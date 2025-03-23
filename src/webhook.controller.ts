import { Controller, Post, Body, Headers, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { SupabaseService } from './supabase/supabase.service';
import { GmailWatchService } from './gmail/gmail-watch.service';

@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);
  
  constructor(private gmailWatchService: GmailWatchService, private supabaseService: SupabaseService) {}
  
  @Post('gmail')
  async handleGmailPushNotification(
    @Headers('x-goog-resource-state') resourceState: string,
    @Headers('x-goog-resource-id') resourceId: string,
    @Headers('x-goog-resource-uri') resourceUri: string,
    @Headers('x-goog-message-number') messageNumber: string,
    @Body() body: any,
  ) {
    try {
      this.logger.log(`Received Gmail notification: ${resourceState}`);
      
      // Validate the request
      if (!resourceState || !resourceId) {
        throw new HttpException('Invalid notification', HttpStatus.BAD_REQUEST);
      }
      
      // Only process 'exists' notifications (new messages or changes)
      if (resourceState !== 'exists') {
        return { success: true, message: 'Not a change notification' };
      }
      
      // Find the connection ID associated with this resourceId
      const { data: connection, error } = await this.supabaseService.getClient()
        .from('email_connections')
        .select('id')
        .eq('watch_resource_id', resourceId)
        .single();
        
      if (error || !connection) {
        throw new HttpException('Connection not found', HttpStatus.NOT_FOUND);
      }
      
      // Process the history update
      const result = await this.gmailWatchService.processHistoryUpdate(
        connection.id,
        body.historyId,
      );
      
      return {
        ...result,
      };
    } catch (error) {
      this.logger.error(`Error handling Gmail notification: ${error.message}`);
      throw new HttpException(
        error.message || 'Error processing notification',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}