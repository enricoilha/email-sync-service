// gmail-watch.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { GmailService } from '../gmail/gmail.service';
import { gmail_v1 } from 'googleapis';
import { ParsedEmail } from '../types/email.types';

@Injectable()
export class GmailWatchService {
  private readonly logger = new Logger(GmailWatchService.name);
  
  constructor(
    private supabaseService: SupabaseService,
    private gmailService: GmailService,
  ) {}
  
  /**
   * Set up Gmail push notifications for a connection
   */
  async setupWatchNotification(connectionId: string, accessToken: string) {
    try {
      const gmail = this.gmailService.getGmailClient(accessToken);
      
      // Create Gmail push notification subscription
      const { data } = await gmail.users.watch({
        userId: 'me',
        requestBody: {
          topicName: `projects/your-project-id/topics/gmail-notifications`,
          labelIds: ['INBOX'],
        },
      });
      
      if (!data.historyId || !data.expiration) {
        throw new Error('Invalid watch response data');
      }
      
      // Store the historyId and expiration in the database
      await this.supabaseService.updateEmailConnection(connectionId, {
        watch_history_id: data.historyId,
        watch_expiration: new Date(parseInt(data.expiration)).toISOString(),
      });
      
      this.logger.log(`Gmail watch set up for connection ${connectionId}, expires: ${data.expiration}`);
      
      return {
        success: true,
        historyId: data.historyId,
        expiration: data.expiration,
      };
    } catch (error) {
      this.logger.error(`Error setting up Gmail watch: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Process a history update from Gmail push notification
   */
  async processHistoryUpdate(connectionId: string, historyId: string) {
    try {
      // Get the connection details
      const { data: connection, error } = await this.supabaseService.getClient()
        .from('email_connections')
        .select('*')
        .eq('id', connectionId)
        .single();
        
      if (error) throw error;
      
      // If we don't have a previous history ID, we can't process changes
      if (!connection.watch_history_id) {
        throw new Error('No watch history ID found');
      }
      
      // Get the history changes
      const gmail = this.gmailService.getGmailClient(connection.access_token);
      const historyResponse = await gmail.users.history.list({
        userId: 'me',
        startHistoryId: connection.watch_history_id,
        historyTypes: ['messageAdded', 'labelAdded'],
      });
      
      const historyData = historyResponse.data;
      
      if (!historyData.historyId) {
        throw new Error('Invalid history response: missing historyId');
      }
      
      if (!historyData.history || historyData.history.length === 0) {
        this.logger.log('No new changes to process');
        return { success: true, newMessages: 0 };
      }
      
      // Find new message IDs
      const newMessageIds = new Set<string>();
      for (const history of historyData.history) {
        if (history.messagesAdded) {
          for (const message of history.messagesAdded) {
            const messageData = message.message;
            if (messageData && messageData.labelIds?.includes('INBOX') && messageData.id) {
              newMessageIds.add(messageData.id);
            }
          }
        }
      }
      
      if (newMessageIds.size === 0) {
        this.logger.log('No new inbox messages to process');
        return { success: true, newMessages: 0 };
      }
      
      // Process new messages
      const newMessages: ParsedEmail[] = [];
      for (const messageId of newMessageIds) {
        try {
          // Get full message
          const messageResponse = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
          });
          
          const messageData = messageResponse.data;
          
          // Parse message
          const parsedMessage = this.gmailService.parseGmailMessage(messageData);
          
          if (parsedMessage) {
            // Get folder ID for inbox
            const { data: folderData } = await this.supabaseService.getClient()
              .from('folders')
              .select('id')
              .eq('user_id', connection.user_id)
              .eq('connection_id', connectionId)
              .eq('type', 'inbox')
              .single();
            
            if (!folderData?.id) {
              throw new Error('Folder ID not found');
            }
            
            // Store in database
            await this.supabaseService.cacheEmails(
              [parsedMessage],
              connection.user_id,
              connectionId,
              folderData.id,
            );
            
            newMessages.push(parsedMessage);
          }
        } catch (error) {
          this.logger.error(`Error processing message ${messageId}: ${error.message}`);
          // Continue with next message
        }
      }
      
      // Update history ID
      if (!historyData.historyId) {
        throw new Error('Invalid history ID');
      }
      
      await this.supabaseService.updateEmailConnection(connectionId, {
        watch_history_id: historyData.historyId,
      });
      
      this.logger.log(`Processed ${newMessages.length} new messages`);
      
      // Trigger any necessary notifications or events
      for (const message of newMessages) {
        await this.triggerNewEmailNotification(connection.user_id, connectionId, message);
      }
      
      return {
        success: true,
        newMessages: newMessages.length,
        messages: newMessages,
      };
    } catch (error) {
      this.logger.error(`Error processing history update: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Trigger notifications for new emails
   */
  private async triggerNewEmailNotification(userId: string, connectionId: string, message: ParsedEmail) {
    try {
      // Create notification record
      await this.supabaseService.getClient()
        .from('notifications')
        .insert({
          user_id: userId,
          type: 'new_email',
          title: `New email: ${message.subject}`,
          content: `From: ${message.sender.name} (${message.sender.email})`,
          metadata: {
            email_id: message.id,
            connection_id: connectionId,
            sender: message.sender,
            subject: message.subject,
          },
          read: false,
        });
      
      // You can add additional notification methods here (Push, SMS, etc.)
    } catch (error) {
      this.logger.error(`Error creating notification: ${error.message}`);
    }
  }
}