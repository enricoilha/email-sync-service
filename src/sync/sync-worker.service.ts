import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { GmailService } from '../gmail/gmail.service';
import { FullSyncService } from './full-sync.service';
import { IncrementalSyncService } from './incremental-sync.service';
import * as os from 'os';
import * as crypto from 'crypto';

/**
 * SyncWorkerService manages distributed processing of email sync operations
 * It runs as a background process that picks up sync jobs from the queue
 * and processes them independently, enabling horizontal scaling.
 */
@Injectable()
export class SyncWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncWorkerService.name);
  private workerId: string;
  private active = false;
  private processing = false;
  private lastHeartbeat: Date;
  private jobCheckInterval: NodeJS.Timeout;
  private heartbeatInterval: NodeJS.Timeout;
  private readonly maxConcurrentJobs = 1; // Start with 1, can be made configurable
  private readonly heartbeatSeconds = 30;
  private readonly jobLockTimeoutMinutes = 10;
  private readonly retryDelaySeconds = 60;
  private readonly maxConsecutiveFailures = 3;
  private consecutiveFailures = 0;

  constructor(
    private supabaseService: SupabaseService,
    private gmailService: GmailService,
    private fullSyncService: FullSyncService,
    private incrementalSyncService: IncrementalSyncService,
    private schedulerRegistry: SchedulerRegistry,
  ) {
    // Create a unique worker ID based on hostname and a random string
    this.workerId = `worker-${os.hostname()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Start the worker when the module initializes
   */
  async onModuleInit() {
    this.logger.log(`Initializing sync worker ${this.workerId}`);
    await this.registerWorker();
    
    // Start the job check interval
    this.jobCheckInterval = setInterval(() => this.checkForJobs(), 5000);
    this.schedulerRegistry.addInterval('jobCheckInterval', this.jobCheckInterval);
    
    // Start the heartbeat interval
    this.heartbeatInterval = setInterval(() => this.sendHeartbeat(), this.heartbeatSeconds * 1000);
    this.schedulerRegistry.addInterval('heartbeatInterval', this.heartbeatInterval);
    
    this.active = true;
    this.logger.log(`Sync worker ${this.workerId} started`);
  }

  /**
   * Clean up when the module is destroyed
   */
  async onModuleDestroy() {
    this.logger.log(`Shutting down sync worker ${this.workerId}`);
    this.active = false;
    
    // Clear intervals
    clearInterval(this.jobCheckInterval);
    clearInterval(this.heartbeatInterval);
    
    // Release any jobs in progress
    await this.releaseLockedJobs();
    
    // Update worker status
    await this.updateWorkerStatus('stopped');
    
    this.logger.log(`Sync worker ${this.workerId} stopped`);
  }

  /**
   * Register this worker in the database
   */
  private async registerWorker() {
    try {
      const { data, error } = await this.supabaseService.getClient()
        .from('sync_workers')
        .upsert({
          worker_id: this.workerId,
          hostname: os.hostname(),
          status: 'active',
          last_heartbeat: new Date().toISOString(),
          cpu_info: os.cpus()[0]?.model || 'unknown',
          memory_total: os.totalmem(),
          started_at: new Date().toISOString(),
        }, {
          onConflict: 'worker_id',
        });
        
      if (error) {
        this.logger.error(`Error registering worker: ${error.message}`);
      } else {
        this.logger.log(`Worker ${this.workerId} registered successfully`);
      }
    } catch (error) {
      this.logger.error(`Exception registering worker: ${error.message}`);
    }
  }

  /**
   * Send a heartbeat to the database to indicate this worker is active
   */
  private async sendHeartbeat() {
    if (!this.active) return;
    
    try {
      this.lastHeartbeat = new Date();
      
      const { error } = await this.supabaseService.getClient()
        .from('sync_workers')
        .update({
          last_heartbeat: this.lastHeartbeat.toISOString(),
          status: 'active',
          current_memory_usage: process.memoryUsage().heapUsed,
          jobs_processed_count: await this.getProcessedJobCount(),
        })
        .eq('worker_id', this.workerId);
        
      if (error) {
        this.logger.error(`Error sending heartbeat: ${error.message}`);
      }
    } catch (error) {
      this.logger.error(`Exception sending heartbeat: ${error.message}`);
    }
  }

  /**
   * Update worker status in the database
   */
  private async updateWorkerStatus(status: string, details: object = {}) {
    try {
      const { error } = await this.supabaseService.getClient()
        .from('sync_workers')
        .update({
          status,
          last_heartbeat: new Date().toISOString(),
          ...details,
        })
        .eq('worker_id', this.workerId);
        
      if (error) {
        this.logger.error(`Error updating worker status: ${error.message}`);
      }
    } catch (error) {
      this.logger.error(`Exception updating worker status: ${error.message}`);
    }
  }

  /**
   * Get count of jobs processed by this worker
   */
  private async getProcessedJobCount() {
    try {
      const { count, error } = await this.supabaseService.getClient()
        .from('sync_operations')
        .select('*', { count: 'exact', head: true })
        .eq('worker_id', this.workerId)
        .not('status', 'eq', 'in_progress');
        
      if (error) {
        this.logger.error(`Error getting processed job count: ${error.message}`);
        return 0;
      }
      
      return count || 0;
    } catch (error) {
      this.logger.error(`Exception getting processed job count: ${error.message}`);
      return 0;
    }
  }

  /**
   * Check for available sync jobs
   */
  private async checkForJobs() {
    if (!this.active || this.processing) return;
    
    try {
      this.processing = true;
      
      // Check for abandoned jobs first (jobs that were locked but not completed)
      await this.claimAbandonedJobs();
      
      // Then check for new jobs
      await this.claimNewJobs();
    } catch (error) {
      this.logger.error(`Error checking for jobs: ${error.message}`);
      this.consecutiveFailures++;
      
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        this.logger.error(`Too many consecutive failures (${this.consecutiveFailures}), pausing worker`);
        await this.updateWorkerStatus('error', { error_message: error.message });
        this.active = false;
        
        // Restart after delay
        setTimeout(() => {
          this.logger.log('Restarting worker after error pause');
          this.active = true;
          this.consecutiveFailures = 0;
          this.updateWorkerStatus('active');
        }, this.retryDelaySeconds * 1000);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Claim jobs that were abandoned by failed workers
   */
  private async claimAbandonedJobs() {
    try {
      // Look for jobs that have been locked but not updated for a while
      const lockTimeout = new Date();
      lockTimeout.setMinutes(lockTimeout.getMinutes() - this.jobLockTimeoutMinutes);
      
      const { data: abandonedJobs, error } = await this.supabaseService.getClient()
        .from('sync_operations')
        .select('*')
        .eq('status', 'in_progress')
        .lt('updated_at', lockTimeout.toISOString())
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(this.maxConcurrentJobs);
        
      if (error) {
        throw new Error(`Error finding abandoned jobs: ${error.message}`);
      }
      
      if (abandonedJobs?.length > 0) {
        for (const job of abandonedJobs) {
          this.logger.log(`Claiming abandoned job ${job.id} for ${job.email}`);
          
          // Update the job to be claimed by this worker
          const { error: updateError } = await this.supabaseService.getClient()
            .from('sync_operations')
            .update({
              worker_id: this.workerId,
              status_message: `Reassigned to worker ${this.workerId} after previous worker failed`,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id)
            .eq('status', 'in_progress');
            
          if (updateError) {
            this.logger.error(`Error claiming abandoned job ${job.id}: ${updateError.message}`);
            continue;
          }
          
          // Process the job
          this.processJob(job);
          
          // Only process one job at a time for now
          break;
        }
      }
    } catch (error) {
      this.logger.error(`Error handling abandoned jobs: ${error.message}`);
    }
  }

  /**
   * Claim new jobs from the queue
   */
  private async claimNewJobs() {
    try {
      // Look for new jobs that haven't been claimed yet
      const { data: newJobs, error } = await this.supabaseService.getClient()
        .from('sync_operations')
        .select('*')
        .is('worker_id', null)
        .eq('status', 'in_progress')
        .order('priority', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(this.maxConcurrentJobs);
        
      if (error) {
        throw new Error(`Error finding new jobs: ${error.message}`);
      }
      
      if (newJobs?.length > 0) {
        for (const job of newJobs) {
          this.logger.log(`Claiming new job ${job.id} for ${job.email}`);
          
          // Update the job to be claimed by this worker
          const { error: updateError } = await this.supabaseService.getClient()
            .from('sync_operations')
            .update({
              worker_id: this.workerId,
              status_message: `Processing by worker ${this.workerId}`,
              updated_at: new Date().toISOString(),
            })
            .eq('id', job.id)
            .is('worker_id', null);
            
          if (updateError) {
            this.logger.error(`Error claiming new job ${job.id}: ${updateError.message}`);
            continue;
          }
          
          // Process the job
          this.processJob(job);
          
          // Only process one job at a time for now
          break;
        }
      }
    } catch (error) {
      this.logger.error(`Error handling new jobs: ${error.message}`);
    }
  }

  /**
   * Process a sync job
   */
  private async processJob(job: any) {
    try {
      this.logger.log(`Processing job ${job.id} (${job.sync_type}) for ${job.email}`);
      
      // Update worker status to show current job
      await this.updateWorkerStatus('processing', { 
        current_job_id: job.id,
        current_job_type: job.sync_type,
        current_job_started: new Date().toISOString()
      });
      
      // Process based on job type
      if (job.sync_type === 'full') {
        // The full sync service will update the sync_operations record
        // with progress automatically
        await this.fullSyncService.startFullSync(
          job.user_id,
          job.connection_id,
          1 // priority
        );
      } else if (job.sync_type === 'incremental') {
        await this.incrementalSyncService.performIncrementalSync(
          job.user_id, 
          job.connection_id
        );
        
        // Update the job as completed since incremental sync
        // doesn't update the job status itself
        await this.supabaseService.getClient()
          .from('sync_operations')
          .update({
            status: 'completed',
            progress: 100,
            completed_at: new Date().toISOString(),
            status_message: 'Incremental sync completed successfully',
          })
          .eq('id', job.id);
      } else {
        throw new Error(`Unknown job type: ${job.sync_type}`);
      }
      
      // Reset consecutive failures on success
      this.consecutiveFailures = 0;
      
      // Update worker status
      await this.updateWorkerStatus('active', { 
        current_job_id: null,
        current_job_type: null,
        last_job_id: job.id,
        last_job_completed: new Date().toISOString()
      });
    } catch (error) {
      this.logger.error(`Error processing job ${job.id}: ${error.message}`);
      
      // Update the job with the error
      await this.supabaseService.getClient()
        .from('sync_operations')
        .update({
          status: 'failed',
          status_message: `Error: ${error.message}`,
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id);
      
      // Update worker status
      await this.updateWorkerStatus('error', { 
        error_message: error.message,
        current_job_id: null,
        current_job_type: null,
        last_error_at: new Date().toISOString()
      });
      
      this.consecutiveFailures++;
    }
  }

  /**
   * Get connection details for a job
   */
  private async getConnectionDetails(connectionId: string) {
    const { data, error } = await this.supabaseService.getClient()
      .from('email_connections')
      .select('*')
      .eq('id', connectionId)
      .single();
      
    if (error) {
      throw new Error(`Error fetching connection details: ${error.message}`);
    }
    
    return data;
  }

  /**
   * Release any jobs locked by this worker
   */
  private async releaseLockedJobs() {
    try {
      const { data: lockedJobs, error } = await this.supabaseService.getClient()
        .from('sync_operations')
        .select('id')
        .eq('worker_id', this.workerId)
        .eq('status', 'in_progress');
        
      if (error) {
        this.logger.error(`Error finding locked jobs: ${error.message}`);
        return;
      }
      
      if (lockedJobs?.length > 0) {
        for (const job of lockedJobs) {
          this.logger.log(`Releasing locked job ${job.id}`);
          
          await this.supabaseService.getClient()
            .from('sync_operations')
            .update({
              worker_id: null,
              status_message: `Released by worker ${this.workerId} during shutdown`,
            })
            .eq('id', job.id);
        }
      }
    } catch (error) {
      this.logger.error(`Error releasing locked jobs: ${error.message}`);
    }
  }
}