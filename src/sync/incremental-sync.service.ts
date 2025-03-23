import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { GmailService } from '../gmail/gmail.service';
import { gmail_v1 } from 'googleapis';

interface HistoryChanges {
  changes: gmail_v1.Schema$History[];
  newHistoryId: string | null;
}

interface TokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiryDate: number;
}

@Injectable()
export class IncrementalSyncService {
  private readonly logger = new Logger(IncrementalSyncService.name);

  constructor(
    private supabaseService: SupabaseService,
    private gmailService: GmailService,
  ) {}

  /**
   * Perform an incremental sync for a user's connection based on history ID
   */
  async performIncrementalSync(userId: string, connectionId: string) {
    this.logger.log(`Starting incremental sync for user ${userId}, connection ${connectionId}`);

    try {
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
      
      // Check if we have a history ID to use for incremental sync
      const historyId = connection.latest_history_id;
      if (!historyId) {
        this.logger.warn(`No history ID available for connection ${connectionId}, full sync required`);
        return { 
          success: false, 
          requiresFullSync: true, 
          message: 'No history ID available, full sync required' 
        };
      }

      // Check if token is expired and refresh if needed
      const now = new Date();
      const tokenExpiry = new Date(connection.token_expires_at);
      let accessToken = connection.access_token;

      if (tokenExpiry <= now) {
        this.logger.log(`Refreshing expired token for connection ${connection.id}`);
        const tokens = await this.gmailService.refreshAccessToken(
          connection.refresh_token,
        ) as TokenResponse;

        // Update the token in the database
        await this.supabaseService.updateEmailConnection(connection.id, {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken || connection.refresh_token,
          token_expires_at: new Date(tokens.expiryDate).toISOString(),
        });

        accessToken = tokens.accessToken;
      }

      // Get history changes since last sync
      const historyChanges = await this.getHistoryChanges(accessToken, historyId);
      
      if (!historyChanges || historyChanges.changes.length === 0) {
        this.logger.log(`No changes detected since last sync for connection ${connectionId}`);
        
        // Update last synced timestamp
        await this.supabaseService.updateEmailConnection(connectionId, {
          last_synced_at: new Date().toISOString(),
        });
        
        return { 
          success: true, 
          changesDetected: false,
          message: 'No changes detected since last sync' 
        };
      }

      this.logger.log(`Found ${historyChanges.changes.length} history changes to process`);
      
      // Process all history changes
      const result = await this.processHistoryChanges(
        userId, 
        connectionId, 
        accessToken, 
        historyChanges
      );
      
      // Update the latest history ID and last synced timestamp
      await this.supabaseService.updateEmailConnection(connectionId, {
        latest_history_id: result.newHistoryId || historyId,
        last_synced_at: new Date().toISOString(),
      });

      return {
        success: true,
        changesDetected: true,
        messagesAdded: result.messagesAdded,
        messagesModified: result.messagesModified,
        messagesDeleted: result.messagesDeleted,
        newHistoryId: result.newHistoryId,
      };
    } catch (error) {
      // Handle history ID invalid error - requires full sync
      if (error.message && error.message.includes('Invalid historyId')) {
        this.logger.warn(`Invalid history ID for connection ${connectionId}, full sync required`);
        return { 
          success: false, 
          requiresFullSync: true, 
          message: 'History ID is invalid or expired, full sync required' 
        };
      }

      this.logger.error(`Error in incremental sync: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get history changes from Gmail using history ID
   */
  private async getHistoryChanges(accessToken: string, historyId: string): Promise<HistoryChanges> {
    try {
      const gmail = this.gmailService.getGmailClient(accessToken);
      
      let allChanges: gmail_v1.Schema$History[] = [];
      let pageToken: string | null = null;
      let lastResponse: gmail_v1.Schema$ListHistoryResponse | null = null;
      
      do {
        const response = await gmail.users.history.list({
          userId: 'me',
          startHistoryId: historyId,
          pageToken: pageToken || undefined,
          historyTypes: ['messageAdded', 'messageDeleted', 'labelAdded', 'labelRemoved'],
        });
        
        lastResponse = response.data;
        
        if (lastResponse?.history && lastResponse.history.length > 0) {
          allChanges = allChanges.concat(lastResponse.history);
        }
        
        pageToken = lastResponse?.nextPageToken || null;
      } while (pageToken);
      
      // Extract new history ID if available
      const newHistoryId = lastResponse?.historyId || null;
      
      return {
        changes: allChanges,
        newHistoryId,
      };
    } catch (error) {
      this.logger.error(`Error getting history changes: ${error.message}`);
      throw error;
    }
  }

  /**
   * Process history changes and update email cache accordingly
   */
  private async processHistoryChanges(
    userId: string,
    connectionId: string,
    accessToken: string,
    historyChanges: HistoryChanges,
  ) {
    // Initialize counters
    let messagesAdded = 0;
    let messagesModified = 0;
    let messagesDeleted = 0;
    
    // Keep track of processed message IDs to avoid duplicates
    const processedMessageIds = new Set<string>();
    const newHistoryId = historyChanges.newHistoryId;
    
    // Extract unique message IDs to process
    const messagesToAdd = new Set<string>();
    const messagesToDelete = new Set<string>();
    const messagesToUpdate = new Set<string>();
    
    // Process each history change
    for (const history of historyChanges.changes) {
      // Process message additions
      if (history.messagesAdded) {
        for (const message of history.messagesAdded) {
          if (!processedMessageIds.has(message.message?.id || '')) {
            messagesToAdd.add(message.message?.id || '');
            processedMessageIds.add(message.message?.id || '');
          }
        }
      }
      
      // Process message deletions
      if (history.messagesDeleted) {
        for (const message of history.messagesDeleted) {
          if (!processedMessageIds.has(message.message?.id || '')) {
            messagesToDelete.add(message.message?.id || '');
            processedMessageIds.add(message.message?.id || '');
          }
        }
      }
      
      // Process label changes
      if (history.labelsAdded || history.labelsRemoved) {
        const labelChanges = [...(history.labelsAdded || []), ...(history.labelsRemoved || [])];
        
        for (const labelChange of labelChanges) {
          if (!processedMessageIds.has(labelChange.message?.id || '') && 
              !messagesToAdd.has(labelChange.message?.id || '') && 
              !messagesToDelete.has(labelChange.message?.id || '')) {
            messagesToUpdate.add(labelChange.message?.id || '');
            processedMessageIds.add(labelChange.message?.id || '');
          }
        }
      }
    }
    
    // Process message additions
    if (messagesToAdd.size > 0) {
      this.logger.log(`Processing ${messagesToAdd.size} added messages`);
      
      const addedMessages = await this.fetchAndCacheMessages(
        userId,
        connectionId,
        accessToken,
        Array.from(messagesToAdd),
      );
      
      messagesAdded = addedMessages;
    }
    
    // Process message deletions
    if (messagesToDelete.size > 0) {
      this.logger.log(`Processing ${messagesToDelete.size} deleted messages`);
      
      await this.deleteMessages(
        userId,
        connectionId,
        Array.from(messagesToDelete),
      );
      
      messagesDeleted = messagesToDelete.size;
    }
    
    // Process message updates (label changes)
    if (messagesToUpdate.size > 0) {
      this.logger.log(`Processing ${messagesToUpdate.size} modified messages`);
      
      const updatedMessages = await this.updateMessages(
        userId,
        connectionId,
        accessToken,
        Array.from(messagesToUpdate),
      );
      
      messagesModified = updatedMessages;
    }
    
    return {
      messagesAdded,
      messagesModified,
      messagesDeleted,
      newHistoryId,
    };
  }
  
  /**
   * Fetch and cache messages by IDs
   */
  private async fetchAndCacheMessages(
    userId: string,
    connectionId: string,
    accessToken: string,
    messageIds: string[],
  ) {
    try {
      const gmail = this.gmailService.getGmailClient(accessToken);
      let cachedCount = 0;
      
      // Process in batches of 20 to avoid overloading the API
      const batchSize = 20;
      
      for (let i = 0; i < messageIds.length; i += batchSize) {
        const batch = messageIds.slice(i, i + batchSize);
        const messages = await Promise.all(batch.map(async (messageId) => {
          try {
            const { data } = await gmail.users.messages.get({
              userId: 'me',
              id: messageId,
              format: 'full',
            });
            
            return this.gmailService.parseGmailMessage(data);
          } catch (error) {
            this.logger.error(`Error fetching message ${messageId}: ${error.message}`);
            return null;
          }
        }));
        
        // Filter out null values and cache valid messages
        const validMessages = messages.filter(message => message !== null);
        
        if (validMessages.length > 0) {
          // Determine folder for each message
          for (const message of validMessages) {
            let folderType = 'inbox'; // Default folder
            
            // Determine the correct folder based on labels
            if (message.folder) {
              folderType = message.folder;
            }
            
            // Cache one message at a time to track individual failures
            try {
              const result = await this.supabaseService.cacheEmails(
                [message],
                userId,
                connectionId,
                folderType,
              );
              
              if (result.count > 0) {
                cachedCount++;
              }
            } catch (error) {
              this.logger.error(`Error caching message ${message.id}: ${error.message}`);
            }
          }
        }
        
        // Short delay between batches
        if (i + batchSize < messageIds.length) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      
      return cachedCount;
    } catch (error) {
      this.logger.error(`Error fetching and caching messages: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Delete messages from cache by IDs
   */
  private async deleteMessages(
    userId: string,
    connectionId: string,
    messageIds: string[],
  ) {
    try {
      const supabase = this.supabaseService.getClient();
      
      // Delete in batches of 100
      const batchSize = 100;
      
      for (let i = 0; i < messageIds.length; i += batchSize) {
        const batch = messageIds.slice(i, i + batchSize);
        
        await supabase
          .from('cached_emails')
          .delete()
          .eq('user_id', userId)
          .eq('connection_id', connectionId)
          .in('provider_email_id', batch);
      }
      
      return messageIds.length;
    } catch (error) {
      this.logger.error(`Error deleting messages: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Update message labels and other properties in cache
   */
  private async updateMessages(
    userId: string,
    connectionId: string,
    accessToken: string,
    messageIds: string[],
  ) {
    try {
      // For updates, we'll fetch the messages again and overwrite the cache
      return await this.fetchAndCacheMessages(
        userId,
        connectionId,
        accessToken,
        messageIds,
      );
    } catch (error) {
      this.logger.error(`Error updating messages: ${error.message}`);
      throw error;
    }
  }
}