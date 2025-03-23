import { Module } from '@nestjs/common';
import { GmailService } from './gmail.service';
import { GmailWatchService } from './gmail-watch.service';
import { SupabaseModule } from 'src/supabase/supabase.module';
import { WebhookController } from 'src/webhook.controller';

@Module({
  imports: [SupabaseModule],
  providers: [GmailService, GmailWatchService],
  exports: [GmailService, GmailWatchService],
  controllers: [WebhookController]
})
export class GmailModule {}