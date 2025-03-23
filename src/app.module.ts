import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { SupabaseModule } from './supabase/supabase.module';
import { GmailModule } from './gmail/gmail.module';
import { SyncModule } from './sync/sync.module';
import { WebhookController } from './webhook.controller';

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
})
export class AppModule {}
