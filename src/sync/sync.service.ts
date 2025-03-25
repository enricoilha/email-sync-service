import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SupabaseService } from "../supabase/supabase.service";
import { GmailService } from "../gmail/gmail.service";
import { GmailWatchService } from "src/gmail/gmail-watch.service";

interface EmailConnection {
  id: string;
  user_id: string;
  email: string;
  provider: "gmail" | "outlook";
  access_token: string;
  refresh_token: string;
  token_expires_at: string | undefined;
  sync_status: "idle" | "syncing" | "error";
  sync_batch_size?: number;
  total_folders?: number;
  latest_history_id?: string;
  sync_error?: string | null;
}

interface SyncResponse {
  messages: Array<{
    id: string;
    subject: string;
    sender: {
      name: string;
      email: string;
    };
    to: Array<{
      name: string;
      email: string;
    }>;
    cc?: Array<{
      name: string;
      email: string;
    }>;
    date: string;
    body: string;
    preview: string;
    read: boolean;
    starred: boolean;
    folder: string;
    attachments?: Array<{
      id: string;
      name: string;
      contentType: string;
      size: number;
    }>;
  }>;
  nextPageToken?: string;
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private supabaseService: SupabaseService,
    private gmailService: GmailService,
    private gmailWatchService: GmailWatchService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async renewGmailWatchSubscriptions() {
    this.logger.log("Running Gmail watch subscription renewal");

    try {
      // Find connections with watch subscriptions expiring in the next 24 hours
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);

      const { data: connections, error } = await this.supabaseService
        .getClient()
        .from("email_connections")
        .select("*")
        .eq("provider", "gmail")
        .lt("watch_expiration", tomorrow.toISOString());

      if (error) throw error;

      this.logger.log(
        `Found ${connections.length} watch subscriptions to renew`,
      );

      for (const connection of connections) {
        try {
          await this.gmailWatchService.setupWatchNotification(
            connection.id,
            connection.access_token,
          );
          this.logger.log(`Renewed watch subscription for ${connection.email}`);
        } catch (error) {
          this.logger.error(
            `Error renewing watch for ${connection.email}: ${error.message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(`Error in watch renewal job: ${error.message}`);
    }
  }

  // Run sync every 5 minutes for all users
  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleCronSync() {
    this.logger.log("Running scheduled email sync for all users");

    try {
      // Get all users with email connections
      const { data: users, error } = await this.supabaseService
        .getClient()
        .from("users")
        .select("id");

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
      const connections = await this.supabaseService.getEmailConnections(
        userId,
      );

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

  async syncConnectionEmails(connection: EmailConnection, userId: string) {
    if (!connection || !connection.id) {
      throw new Error("Invalid connection object");
    }

    try {
      // Check if token is expired and refresh if needed
      const now = new Date();
      const tokenExpiry = connection.token_expires_at
        ? new Date(connection.token_expires_at)
        : new Date(0);
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
            token_expires_at: tokens.expiryDate
              ? new Date(tokens.expiryDate).toISOString()
              : undefined,
          });

          accessToken = tokens.accessToken;
          this.logger.log("Token refreshed successfully");
        } catch (refreshError) {
          this.logger.error(`Error refreshing token: ${refreshError.message}`);
          throw refreshError;
        }
      }

      // Sync emails for each folder type
      const folderTypes = ["inbox", "sent", "drafts", "trash"];

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
        `Error syncing emails for user ${userId}: ${error.message}`,
      );
      throw error;
    }
  }

  private async syncFolderEmails(
    accessToken: string,
    userId: string,
    connectionId: string,
    folderType: string,
  ) {
    try {
      // Get folder ID from database
      const { data: folderData, error: folderError } = await this
        .supabaseService
        .getClient()
        .from("folders")
        .select("id, provider_folder_id")
        .eq("user_id", userId)
        .eq("connection_id", connectionId)
        .eq("type", folderType)
        .single();

      if (folderError) throw folderError;
      if (!folderData) {
        throw new Error(`Folder not found for type ${folderType}`);
      }

      // Get emails from Gmail
      const response = await this.gmailService.getEmails(
        accessToken,
        folderData.provider_folder_id,
      );

      if (!response.messages || response.messages.length === 0) {
        this.logger.log(`No emails found in folder ${folderType}`);
        return { success: true, count: 0 };
      }

      this.logger.log(
        `Retrieved ${response.messages.length} emails from Gmail`,
      );

      if (response.messages.length > 0) {
        // Cache the emails
        await this.supabaseService.cacheEmails(
          response.messages,
          userId,
          connectionId,
          folderData.id,
        );
      }

      return { success: true, count: response.messages.length };
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
      if (!userId) throw new Error("User ID is required");
      if (!connectionId) throw new Error("Connection ID is required");
      if (!folderType) throw new Error("Folder type is required");

      // Get the email connection
      const { data: connections, error } = await this.supabaseService
        .getClient()
        .from("email_connections")
        .select("*")
        .eq("id", connectionId)
        .eq("user_id", userId);

      if (error) throw error;
      if (!connections || connections.length === 0) {
        throw new Error("Email connection not found");
      }

      const connection = connections[0] as EmailConnection;
      this.logger.log(`Found connection for ${connection.email}`);

      // Check if token is expired and refresh if needed
      const now = new Date();
      const tokenExpiry = connection.token_expires_at
        ? new Date(connection.token_expires_at)
        : new Date(0);
      let accessToken = connection.access_token;

      if (tokenExpiry <= now) {
        this.logger.log("Token is expired, refreshing...");
        const tokens = await this.gmailService.refreshAccessToken(
          connection.refresh_token,
        );

        await this.supabaseService.updateEmailConnection(connection.id, {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken || connection.refresh_token,
          token_expires_at: tokens.expiryDate
            ? new Date(tokens.expiryDate).toISOString()
            : undefined,
        });

        accessToken = tokens.accessToken;
      }

      // Get folder ID from database
      const { data: folderData, error: folderError } = await this
        .supabaseService
        .getClient()
        .from("folders")
        .select("id, provider_folder_id")
        .eq("user_id", userId)
        .eq("connection_id", connectionId)
        .eq("type", folderType)
        .single();

      if (folderError) throw folderError;
      if (!folderData) {
        throw new Error(`Folder not found for type ${folderType}`);
      }

      // Get emails from Gmail
      const response = await this.gmailService.getEmails(
        accessToken,
        folderData.provider_folder_id,
      );

      if (!response.messages || response.messages.length === 0) {
        this.logger.log(`No emails found in folder ${folderType}`);
        return { success: true, count: 0 };
      }

      this.logger.log(
        `Retrieved ${response.messages.length} emails from Gmail`,
      );

      if (response.messages.length > 0) {
        // Cache the emails
        await this.supabaseService.cacheEmails(
          response.messages,
          userId,
          connectionId,
          folderData.id,
        );
      }

      return {
        success: true,
        count: response.messages.length,
        nextPageToken: response.nextPageToken,
        hasMore: !!response.nextPageToken,
      };
    } catch (error) {
      this.logger.error(`Error syncing emails: ${error.message}`);
      throw error;
    }
  }
}
