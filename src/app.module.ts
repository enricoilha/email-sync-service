import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { SupabaseModule } from './supabase/supabase.module';
import { GmailModule } from './gmail/gmail.module';
import { SyncModule } from './sync/sync.module';
import { WebhookController } from './webhook.controller';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseService } from './supabase/supabase.service';
import { FullSyncService } from './sync/full-sync.service';
import { GmailWatchService } from './gmail/gmail-watch.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: '.env',
      
    }),
    ScheduleModule.forRoot(),
    SupabaseModule,
    GmailModule,
    SyncModule,
    
  ],
  controllers: [AppController, WebhookController],
  providers: [AppService, SupabaseService, FullSyncService, GmailWatchService]
  
})
export class AppModule {}
