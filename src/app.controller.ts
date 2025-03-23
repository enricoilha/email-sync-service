import { Body, Controller, Get, HttpException, HttpStatus, Post, Request } from '@nestjs/common';
import { AppService } from './app.service';
import { SupabaseService } from './supabase/supabase.service';
import { FullSyncService } from './sync/full-sync.service';
import { GmailWatchService } from './gmail/gmail-watch.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService, private readonly supabaseService: SupabaseService, private readonly fullSyncService: FullSyncService, private readonly gmailWatchService: GmailWatchService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  // In your API endpoint that handles email connection creation
@Post('email-connections')
async createEmailConnection(@Request() req, @Body() connectionData: any) {
  try {
    const userId = req.user.id;
    
    // Create the connection in database
    const { data: connection, error } = await this.supabaseService.getClient()
      .from('email_connections')
      .insert({
        user_id: userId,
        provider: connectionData.provider,
        email: connectionData.email,
        access_token: connectionData.accessToken,
        refresh_token: connectionData.refreshToken,
        token_expires_at: connectionData.expiresAt,
        // Set sync_enabled to false to prevent automatic scheduled syncs
        sync_enabled: false,
      })
      .select()
      .single();
      
    if (error) throw error;
    
    // Trigger a one-time initial full sync
    const syncResult = await this.fullSyncService.startFullSync(userId, connection.id, 1);
    
    // If Gmail provider, set up push notifications
    if (connection.provider === 'gmail') {
      await this.gmailWatchService.setupWatchNotification(connection.id, connection.access_token);
    }
    
    return {
      success: true,
      connection,
      syncStarted: true,
      syncId: syncResult.syncId
    };
  } catch (error) {
    throw new HttpException(
      error.message || 'Error creating email connection',
      HttpStatus.INTERNAL_SERVER_ERROR
    );
  }
}
}
