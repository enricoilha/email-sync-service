import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Query,
  HttpException,
  HttpStatus,
  Request,
} from '@nestjs/common';
import { SyncService } from './sync.service';
import { FullSyncService } from './full-sync.service';
import { IncrementalSyncService } from './incremental-sync.service';

@Controller('sync')
export class SyncController {
  constructor(
    private syncService: SyncService,
    private fullSyncService: FullSyncService,
    private incrementalSyncService: IncrementalSyncService,
  ) {}

  @Post('on-demand')
  async syncOnDemand(
    @Request() req,
    @Body() body: { connectionId: string; folderType: string; fullSync: boolean },
  ) {
    try {
      const userId = req.user.id;
      
      const result = await this.syncService.syncEmailsOnDemand(
        userId,
        body.connectionId,
        body.folderType,
        body.fullSync,
      );
      return result;
    } catch (error) {
      throw new HttpException(
        error.message || 'Error syncing emails',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('full')
  async startFullSync(
    @Request() req,
    @Body() body: { connectionId: string; priority?: number },
  ) {
    try {
      const userId = req.user.id;
      
      if (!body.connectionId) {
        throw new HttpException(
          'Connection ID is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.fullSyncService.startFullSync(
        userId,
        body.connectionId,
        body.priority || 1, // Default to high priority for user-initiated syncs
      );
      return result;
    } catch (error) {
      throw new HttpException(
        error.message || 'Error starting full sync',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('incremental')
  async startIncrementalSync(
    @Request() req,
    @Body() body: { connectionId: string; priority?: number },
  ) {
    try {
      const userId = req.user.id;
      
      if (!body.connectionId) {
        throw new HttpException(
          'Connection ID is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.incrementalSyncService.performIncrementalSync(
        userId,
        body.connectionId,
      );
      
      // If incremental sync requires a full sync, inform the client
      if (result.requiresFullSync) {
        return {
          success: false,
          requiresFullSync: true,
          message: result.message,
        };
      }
      
      return result;
    } catch (error) {
      throw new HttpException(
        error.message || 'Error during incremental sync',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('status/:syncId')
  async getSyncStatus(
    @Request() req,
    @Param('syncId') syncId: string,
  ) {
    try {
      const userId = req.user.id;
      
      if (!syncId) {
        throw new HttpException(
          'Sync ID is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.fullSyncService.getSyncStatus(userId, syncId);
      return result;
    } catch (error) {
      throw new HttpException(
        error.message || 'Error getting sync status',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('cancel/:syncId')
  async cancelSync(
    @Request() req,
    @Param('syncId') syncId: string,
  ) {
    try {
      const userId = req.user.id;
      
      if (!syncId) {
        throw new HttpException(
          'Sync ID is required',
          HttpStatus.BAD_REQUEST,
        );
      }

      const result = await this.fullSyncService.cancelSync(userId, syncId);
      return result;
    } catch (error) {
      throw new HttpException(
        error.message || 'Error cancelling sync',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('history')
  async getSyncHistory(
    @Request() req,
    @Query('limit') limit: number = 10,
  ) {
    try {
      const userId = req.user.id;
      const result = await this.fullSyncService.listSyncOperations(userId, limit);
      return result;
    } catch (error) {
      throw new HttpException(
        error.message || 'Error getting sync history',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}