import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { SyncService } from './sync.service';
import { FullSyncService } from './full-sync.service';
import { IncrementalSyncService } from './incremental-sync.service';
import { SyncWorkerService } from './sync-worker.service';
import { SyncController } from './sync.controller';
import { SupabaseModule } from '../supabase/supabase.module';
import { GmailModule } from '../gmail/gmail.module';
import { GuardsModule } from 'src/auth/guards.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    SupabaseModule, 
    GmailModule,
    GuardsModule
  ],
  controllers: [SyncController],
  providers: [
    SyncService, 
    FullSyncService, 
    IncrementalSyncService,
    SyncWorkerService
  ],
  exports: [
    SyncService, 
    FullSyncService, 
    IncrementalSyncService,
    SyncWorkerService
  
  ],
})
export class SyncModule {}