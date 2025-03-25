/* eslint-disable */
import { Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";
import { GmailService } from "../gmail/gmail.service";
import configuration from "src/config/configuration";

@Injectable()
export class FullSyncService {
  private readonly logger = new Logger(FullSyncService.name);
  private configuration = configuration;

  constructor(
    private supabaseService: SupabaseService,
    private gmailService: GmailService,
  ) {}

  /**
   * Start a full mailbox synchronization for a user
   */
  async startFullSync(userId: string, connectionId: string, priority = 1) {
    this.logger.log(
      `Starting full mailbox sync for user ${userId}, connection ${connectionId}`,
    );

    // Get the email connection
    const { data: connections, error } = await this.supabaseService
      .getClient()
      .from("email_connections")
      .select("*")
      .eq("id", connectionId)
      .eq("user_id", userId);

    if (error) throw error;
    if (!connections || connections.length === 0) {
      throw new Error("Email connection not found");
    }

    const connection = connections[0];

    // Check if a sync is already in progress
    const { data: existingSync } = await this.supabaseService
      .getClient()
      .from("sync_operations")
      .select("*")
      .eq("user_id", userId)
      .eq("connection_id", connectionId)
      .eq("status", "in_progress")
      .single();

    if (existingSync) {
      return {
        success: false,
        message: "A sync operation is already in progress for this connection",
        syncId: existingSync.id,
      };
    }

    // Get all folders for this connection
    const { data: folders } = await this.supabaseService
      .getClient()
      .from("folders")
      .select("*")
      .eq("user_id", userId)
      .eq("connection_id", connectionId);

    // If no folders exist, create default ones
    let totalFolders = 4; // Default: inbox, sent, drafts, trash
    if (!folders || folders.length === 0) {
      await this.createDefaultFolders(
        userId,
        connectionId,
        connection.provider,
      );
    } else {
      totalFolders = folders.length;
    }

    // Create a new sync operation record
    const { data: syncOperation, error: syncError } = await this.supabaseService
      .getClient()
      .from("sync_operations")
      .insert({
        user_id: userId,
        connection_id: connectionId,
        email: connection.email,
        provider: connection.provider,
        status: "in_progress",
        progress: 0,
        started_at: new Date().toISOString(),
        folders_completed: 0,
        total_folders: totalFolders,
        messages_synced: 0,
        sync_type: "full",
        priority: priority,
      })
      .select()
      .single();

    if (syncError) throw syncError;

    // Update the connection status
    await this.supabaseService.updateEmailConnection(connectionId, {
      sync_status: "syncing",
      last_sync_type: "full",
    });

    // Start the sync process asynchronously
    this.processFullSync(userId, connectionId, syncOperation.id, connection)
      .catch((error) => {
        this.logger.error(`Error in full sync process: ${error.message}`);
        // Update connection status on error
        this.supabaseService.updateEmailConnection(connectionId, {
          sync_status: "error",
          sync_error: error.message,
        }).catch((err) =>
          this.logger.error(
            `Failed to update connection status: ${err.message}`,
          )
        );
      });

    return {
      success: true,
      message: "Full sync started successfully",
      syncId: syncOperation.id,
    };
  }

  /**
   * Create default folders for a connection
   */
  private async createDefaultFolders(
    userId: string,
    connectionId: string,
    provider: string,
  ) {
    const defaultFolders = [
      { name: "Inbox", type: "inbox", provider_folder_id: "INBOX" },
      {
        name: "Sent",
        type: "sent",
        provider_folder_id: provider === "gmail" ? "SENT" : "Sent Items",
      },
      {
        name: "Drafts",
        type: "drafts",
        provider_folder_id: provider === "gmail" ? "DRAFT" : "Drafts",
      },
      {
        name: "Trash",
        type: "trash",
        provider_folder_id: provider === "gmail" ? "TRASH" : "Deleted Items",
      },
    ];

    const folderInserts = defaultFolders.map((folder) => ({
      user_id: userId,
      connection_id: connectionId,
      name: folder.name,
      type: folder.type,
      provider_folder_id: folder.provider_folder_id,
    }));

    await this.supabaseService
      .getClient()
      .from("folders")
      .insert(folderInserts);

    this.logger.log(`Created default folders for connection ${connectionId}`);
  }

  /**
   * Process the full sync in the background
   */
  private async processFullSync(
    userId: string,
    connectionId: string,
    syncId: string,
    connection: any,
  ) {
    // Generate a worker ID for tracking
    const workerId = `worker-${Math.random().toString(36).substring(2, 10)}`;

    // Register this worker as handling the sync
    await this.updateSyncStatus(syncId, {
      worker_id: workerId,
    });

    try {
      // First check if the connection is already marked as requiring reauthorization
      if (connection.sync_status === "requires_reauth") {
        await this.updateSyncStatus(syncId, {
          status: "failed",
          progress: 0,
          status_message:
            "This connection needs to be reauthorized. Please reconnect your account.",
          completed_at: new Date().toISOString(),
        });

        throw new Error(
          "This connection needs to be reauthorized. Please reconnect your account.",
        );
      }

      // Always refresh token at the start of sync to ensure we have a valid token
      this.logger.log(
        `Refreshing token for connection ${connection.id}`,
      );

      let tokens;
      try {
        tokens = await this.gmailService.refreshAccessToken(
          connection.refresh_token,
        );
      } catch (refreshError) {
        // Check if this is a token revocation
        if (
          refreshError.code === "TOKEN_REVOKED" ||
          (refreshError.message &&
            refreshError.message.includes("Token has been revoked"))
        ) {
          // Mark the connection as needing reauthorization
          await this.supabaseService.updateEmailConnection(connectionId, {
            sync_status: "requires_reauth",
            sync_error: refreshError.message ||
              "Authentication expired. Please reconnect your account.",
            last_sync_error_at: new Date().toISOString(),
          });

          // Update the sync operation to failed
          await this.updateSyncStatus(syncId, {
            status: "failed",
            progress: 0,
            status_message:
              "Authentication error: Token has been revoked. User needs to reconnect account.",
            completed_at: new Date().toISOString(),
          });

          this.logger.error(
            `Token revocation detected for ${connection.email}. Connection marked for reauthorization.`,
          );
          throw refreshError; // Re-throw to stop the sync process
        }

        throw refreshError; // Re-throw other errors
      }

      // Update the token in the database
      await this.supabaseService.updateEmailConnection(connection.id, {
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken || connection.refresh_token,
        token_expires_at: tokens.expiryDate
          ? new Date(tokens.expiryDate).toISOString()
          : null,
      });

      const accessToken = tokens.accessToken;

      // Continue with the rest of your existing function
      // ...
    } catch (error) {
      this.logger.error(`Error in full sync process: ${error.message}`);
      // Update connection status on error
      this.supabaseService.updateEmailConnection(connectionId, {
        sync_status: error.code === "TOKEN_REVOKED"
          ? "requires_reauth"
          : "error",
        sync_error: error.message,
      }).catch((err) =>
        this.logger.error(
          `Failed to update connection status: ${err.message}`,
        )
      );
    }
  }

  /**
   * Sync an entire folder (including all pages)
   */
  private async syncEntireFolder(
    accessToken: string,
    userId: string,
    connectionId: string,
    folderDbId: string,
    providerFolderId: string,
    syncId: string,
    batchSize: number = 100,
  ) {
    let pageToken: string | undefined;
    let totalSynced = 0;
    let pageCount = 0;
    const maxResultsPerPage = Math.min(batchSize, 100); // Maximum allowed by Gmail API is 100
    let hasMorePages = true;
    let retryCount = 0;
    const maxRetries = 3;

    while (hasMorePages) {
      pageCount++;
      this.logger.log(`Processing page ${pageCount} for folder ${folderDbId}`);

      // Update sync status with current page
      await this.updateSyncStatus(syncId, {
        status_message: `Syncing page ${pageCount}...`,
      });

      // Check if token needs refresh before making the API call
      const connection = await this.getConnectionDetails(connectionId);

      // If token is expired, refresh it
      let currentAccessToken = accessToken;
      const now = new Date();
      const tokenExpiry = connection.token_expires_at
        ? new Date(connection.token_expires_at)
        : new Date(0);

      if (tokenExpiry <= now) {
        this.logger.log(
          `Token expired, refreshing token for connection ${connectionId}`,
        );
        const tokens = await this.gmailService.refreshAccessToken(
          connection.refresh_token,
        );

        // Update token in database
        await this.supabaseService.updateEmailConnection(connectionId, {
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken || connection.refresh_token,
          token_expires_at: tokens.expiryDate
            ? new Date(tokens.expiryDate).toISOString()
            : undefined,
        });

        // Use new token for this API call
        currentAccessToken = tokens.accessToken;
        this.logger.log(
          `Successfully refreshed token for connection ${connectionId}`,
        );
      }

      // Use the current (potentially refreshed) token for the API call
      const response = await this.executeWithBackoff(async () => {
        return await this.gmailService.getEmails(
          currentAccessToken,
          providerFolderId,
          {
            maxResults: maxResultsPerPage,
            pageToken: pageToken,
          },
        );
      });

      if (!response.messages || response.messages.length === 0) {
        // No more messages to process
        this.logger.log(`No more messages in folder ${folderDbId}`);
        break;
      }

      // Prepare emails for caching with proper folder_id
      const emailsToCache = response.messages.map((message) => ({
        ...message,
        folder_id: folderDbId,
      }));

      // Cache the messages in batches to avoid transaction limits
      const cacheResult = await this.cacheBatchedEmails(
        emailsToCache,
        userId,
        connectionId,
        folderDbId,
        maxResultsPerPage,
      );

      // Update counts
      totalSynced += cacheResult.count;

      // Update sync status with progress
      await this.updateSyncStatus(syncId, {
        messages_synced: totalSynced,
        status_message: `Synced ${totalSynced} messages...`,
      });

      // Check if there are more pages
      pageToken = response.nextPageToken || undefined;
      hasMorePages = !!pageToken;

      this.logger.log(
        `Processed page ${pageCount} with ${response.messages.length} messages for folder ${folderDbId}`,
      );

      // Reset retry count after successful fetch
      retryCount = 0;

      // Add a small delay to avoid rate limits
      if (hasMorePages) {
        await this.delay(500);
      }
    }

    return { totalSynced, pageCount };
  }

  private async getConnectionDetails(connectionId: string) {
    const { data, error } = await this.supabaseService.getClient()
      .from("email_connections")
      .select("*")
      .eq("id", connectionId)
      .single();

    if (error) {
      throw new Error(`Error fetching connection details: ${error.message}`);
    }

    return data;
  }

  /**
   * Cache emails in batches to avoid transaction size limits
   */
  private async cacheBatchedEmails(
    emails: any[],
    userId: string,
    connectionId: string,
    folderDbId: string,
    batchSize: number = 50,
  ) {
    let totalCached = 0;

    if (!emails || emails.length === 0) {
      return { success: true, count: 0 };
    }

    // Process in batches
    for (let i = 0; i < emails.length; i += batchSize) {
      const batch = emails.slice(i, Math.min(i + batchSize, emails.length));

      const result = await this.supabaseService.cacheEmails(
        batch,
        userId,
        connectionId,
        folderDbId,
      );

      totalCached += result.count;

      // Small delay between batches
      if (i + batchSize < emails.length) {
        await this.delay(100);
      }
    }

    return { success: true, count: totalCached };
  }

  /**
   * Execute a function with exponential backoff for rate limiting
   */
  private async executeWithBackoff<T>(
    fn: () => Promise<T>,
    maxRetries: number = 5,
  ): Promise<T> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const result = await fn();
      return result;
    }

    throw new Error("Maximum retries exceeded");
  }

  /**
   * Update the sync operation status
   */
  private async updateSyncStatus(syncId: string, updates: any) {
    await this.supabaseService
      .getClient()
      .from("sync_operations")
      .update(updates)
      .eq("id", syncId);
  }

  /**
   * Get the sync operation status
   */
  async getSyncStatus(userId: string, syncId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from("sync_operations")
      .select("*")
      .eq("id", syncId)
      .eq("user_id", userId)
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Cancel an in-progress sync operation
   */
  async cancelSync(userId: string, syncId: string) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from("sync_operations")
      .update({
        status: "cancelled",
        status_message: "Sync cancelled by user",
        completed_at: new Date().toISOString(),
      })
      .eq("id", syncId)
      .eq("user_id", userId)
      .eq("status", "in_progress")
      .select()
      .single();

    if (error) throw error;

    return {
      success: true,
      message: "Sync operation cancelled successfully",
    };
  }

  /**
   * List all sync operations for a user
   */
  async listSyncOperations(userId: string, limit = 10) {
    const { data, error } = await this.supabaseService
      .getClient()
      .from("sync_operations")
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }

  /**
   * Extract the latest history ID from Gmail labels
   */
  private extractLatestHistoryId(labels: any[]): string | null {
    if (!labels || labels.length === 0) return null;

    // Find INBOX label which usually has the latest history ID
    const inboxLabel = labels.find((label) => label.id === "INBOX");
    if (inboxLabel && inboxLabel.historyId) {
      return inboxLabel.historyId;
    }

    // If not found, try to find any label with a history ID
    for (const label of labels) {
      if (label.historyId) {
        return label.historyId;
      }
    }

    return null;
  }

  /**
   * Simple delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
