import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { GmailService } from '../gmail/gmail.service';
import { GmailWatchService } from 'src/gmail/gmail-watch.service';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private supabaseService: SupabaseService,
    private gmailService: GmailService,
    private gmailWatchService: GmailWatchService
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
async renewGmailWatchSubscriptions() {
  this.logger.log('Running Gmail watch subscription renewal');

  try {
    // Find connections with watch subscriptions expiring in the next 24 hours
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    
    const { data: connections, error } = await this.supabaseService.getClient()
      .from('email_connections')
      .select('*')
      .eq('provider', 'gmail')
      .lt('watch_expiration', tomorrow.toISOString());
      
    if (error) throw error;
    
    this.logger.log(`Found ${connections.length} watch subscriptions to renew`);
    
    for (const connection of connections) {
      try {
        await this.gmailWatchService.setupWatchNotification(
          connection.id,
          connection.access_token,
        );
        this.logger.log(`Renewed watch subscription for ${connection.email}`);
      } catch (error) {
        this.logger.error(`Error renewing watch for ${connection.email}: ${error.message}`);
      }
    }
  } catch (error) {
    this.logger.error(`Error in watch renewal job: ${error.message}`);
  }
}

  // Run sync every 5 minutes for all users
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCronSync() {
    this.logger.log('Running scheduled email sync for all users');

    try {
      // Get all users with email connections
      const { data: users, error } = await this.supabaseService
        .getClient()
        .from('users')
        .select('id');

      if (error) throw error;

      // Sync emails for each user
      for (const user of users) {
        try {
          await this.syncUserEmails(user.id);
        } catch (error) {
          this.logger.error(
            `Error syncing emails for user ${user.id}: ${error.message}`,
          );
          // Continue with next user
        }
      }

      this.logger.log(`Completed sync for ${users.length} users`);
    } catch (error) {
      this.logger.error(`Error in scheduled sync: ${error.message}`);
    }
  }

  async syncUserEmails(userId: string) {
    try {
      // Get all email connections for the user
      const connections =
        await this.supabaseService.getEmailConnections(userId);

      if (!connections || connections.length === 0) {
        this.logger.log(`No email connections found for user ${userId}`);
        return { success: true, connectionsProcessed: 0 };
      }

      this.logger.log(
        `Found ${connections.length} connections for user ${userId}`,
      );

      let successCount = 0;
      for (const connection of connections) {
        try {
          await this.syncConnectionEmails(connection, userId);
          successCount++;
        } catch (error) {
          this.logger.error(
            `Error syncing connection ${connection.id}: ${error.message}`,
          );
          // Continue with next connection
        }
      }

      return {
        success: true,
        connectionsProcessed: connections.length,
        successfulConnections: successCount,
      };
    } catch (error) {
      this.logger.error(
        `Error syncing emails for user ${userId}: ${error.message}`,
      );
      throw error;
    }
  }

  async syncConnectionEmails(connection: any, userId: string) {
    if (!connection || !connection.id) {
      throw new Error('Invalid connection object');
    }

    try {
      // Check if token is expired and refresh if needed
      const now = new Date();
      const tokenExpiry = new Date(connection.token_expires_at);
      let accessToken = connection.access_token;

      if (tokenExpiry <= now) {
        try {
          this.logger.log(
            `Refreshing expired token for connection ${connection.id}`,
          );
          const tokens = await this.gmailService.refreshAccessToken(
            connection.refresh_token,
          );

          // Update the token in the database
          await this.supabaseService.updateEmailConnection(connection.id, {
            access_token: tokens.accessToken,
            refresh_token: tokens.refreshToken || connection.refresh_token,
            //@ts-ignore
            token_expires_at: new Date(tokens.expiryDate).toISOString(),
          });

          accessToken = tokens.accessToken;
          this.logger.log('Token refreshed successfully');
        } catch (refreshError) {
          this.logger.error(`Error refreshing token: ${refreshError.message}`);
          throw refreshError;
        }
      }

      // Sync emails for each folder type
      const folderTypes = ['inbox', 'sent', 'drafts', 'trash'];

      let successCount = 0;
      for (const folderType of folderTypes) {
        try {
          await this.syncFolderEmails(
            accessToken,
            userId,
            connection.id,
            folderType,
          );
          successCount++;
        } catch (error) {
          this.logger.error(
            `Error syncing folder ${folderType}: ${error.message}`,
          );
          // Continue with next folder
        }
      }

      return {
        success: true,
        foldersProcessed: folderTypes.length,
        successfulFolders: successCount,
      };
    } catch (error) {
      this.logger.error(
        `Error syncing connection ${connection.id}: ${error.message}`,
      );
      throw error;
    }
  }

  async syncFolderEmails(
    accessToken: string,
    userId: string,
    connectionId: string,
    folderType: string,
  ) {
    try {
      // Map folder types to Gmail label IDs
      const folderMap: Record<string, string> = {
        inbox: 'INBOX',
        sent: 'SENT',
        drafts: 'DRAFT',
        trash: 'TRASH',
        archive: 'ARCHIVE',
      };

      const labelId = folderMap[folderType] || 'INBOX';

      this.logger.log(
        `Syncing ${folderType} folder for connection ${connectionId}`,
      );

      // Get emails from Gmail
      const emails = await this.gmailService.getEmails(accessToken, labelId, {
        maxResults: 50,
      });

      this.logger.log(`Retrieved ${emails.length} emails from Gmail`);

      // Cache emails in Supabase
      if (emails.length > 0) {
        const cacheResult = await this.supabaseService.cacheEmails(
          emails,
          userId,
          connectionId,
          folderType,
        );
        this.logger.log(`Cached ${cacheResult.count} emails in database`);
      }

      return { success: true, count: emails.length };
    } catch (error) {
      this.logger.error(`Error syncing folder ${folderType}: ${error.message}`);
      throw error;
    }
  }

  async syncEmailsOnDemand(
    userId: string,
    connectionId: string,
    folderType: string,
    fullSync: boolean,
  ) {
    this.logger.log(
      `On-demand sync requested for user ${userId}, connection ${connectionId}, folder ${folderType}`,
    );

    try {
      // Validate inputs
      if (!userId) throw new Error('User ID is required');
      if (!connectionId) throw new Error('Connection ID is required');
      if (!folderType) throw new Error('Folder type is required');

      // Get the email connection
      const { data: connections, error } = await this.supabaseService
        .getClient()
        .from('email_connections')
        .select('*')
        .eq('id', connectionId)
        .eq('user_id', userId);

      if (error) throw error;
      if (!connections || connections.length === 0) {
        throw new Error('Email connection not found');
      }

      const connection = connections[0];
      this.logger.log(`Found connection for ${connection.email}`);

      // Check if token is expired and refresh if needed
      const now = new Date();
      const tokenExpiry = new Date(connection.token_expires_at);
      let accessToken = connection.access_token;

      if (tokenExpiry <= now) {
        this.logger.log('Token is expired, refreshing...');
        const tokens = await this.gmailService.refreshAccessToken(
          connection.refresh_token,
        );

        await this.supabaseService.updateEmailConnection(connection.id, {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken || connection.refresh_token,
          //@ts-ignore
          token_expires_at: new Date(tokens.expiryDate).toISOString(),
        });

        accessToken = tokens.accessToken;
        this.logger.log('Token refreshed successfully');
      }

      // If doing a full sync, clear existing cached emails for this folder
      if (fullSync) {
        this.logger.log(
          `Performing full sync, clearing cached emails for ${folderType} folder`,
        );
        await this.supabaseService
          .getClient()
          .from('cached_emails')
          .delete()
          .eq('user_id', userId)
          .eq('connection_id', connectionId)
          .eq('folder_id', folderType);

        this.logger.log(`Cleared cached emails for ${folderType} folder`);
      }

      // Map folder types to Gmail label IDs
      const folderMap: Record<string, string> = {
        inbox: 'INBOX',
        sent: 'SENT',
        drafts: 'DRAFT',
        trash: 'TRASH',
        archive: 'ARCHIVE',
      };

      const labelId = folderMap[folderType] || 'INBOX';
      this.logger.log(`Using Gmail label: ${labelId}`);

      // Get emails from Gmail
      this.logger.log('Fetching emails from Gmail...');
      const emails = await this.gmailService.getEmails(accessToken, labelId, {
        maxResults: 100, // Get more emails for on-demand sync
      });

      this.logger.log(`Retrieved ${emails.length} emails from Gmail`);

      // Cache emails in Supabase
      let cacheResult = { count: 0 };
      if (emails.length > 0) {
        cacheResult = await this.supabaseService.cacheEmails(
          emails,
          userId,
          connectionId,
          folderType,
        );
        this.logger.log(`Cached ${cacheResult.count} emails in database`);
      }

      return {
        success: true,
        count: cacheResult.count,
        nextPageToken: emails.nextPageToken,
        hasMore: !!emails.nextPageToken,
      };
    } catch (error) {
      this.logger.error(`Error in on-demand sync: ${error.message}`);
      throw error;
    }
  }
}
