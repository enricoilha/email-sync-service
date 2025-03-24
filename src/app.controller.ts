import { Body, Controller, Get, HttpException, HttpStatus, Post, Request, UseGuards } from '@nestjs/common';
import { AppService } from './app.service';
import { SupabaseService } from './supabase/supabase.service';
import { FullSyncService } from './sync/full-sync.service';
import { GmailWatchService } from './gmail/gmail-watch.service';
import { AuthGuard } from './auth/auth.guard';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService, private readonly supabaseService: SupabaseService, private readonly fullSyncService: FullSyncService, private readonly gmailWatchService: GmailWatchService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }


@Post('email-connections')
@UseGuards(AuthGuard)
async createEmailConnection(@Request() req, @Body() connectionData: any) {
  try {
    const userId = req.user.id;
    
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
    
    const syncResult = await this.fullSyncService.startFullSync(userId, connection.id, 1);
    
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
