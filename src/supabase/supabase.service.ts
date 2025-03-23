import { Injectable, Logger } from '@nestjs/common';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import configuration from 'src/config/configuration';

@Injectable()
export class SupabaseService {
  private supabase: SupabaseClient;
  private readonly logger = new Logger(SupabaseService.name);
  private configuration = configuration;

  constructor() {
    this.supabase = createClient(
      this.configuration().supabase.url!,
      this.configuration().supabase.serviceKey!,
    );
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }

  async getEmailConnections(userId: string) {
    const { data, error } = await this.supabase
      .from('email_connections')
      .select('*')
      .eq('user_id', userId);

    if (error) throw error;
    return data;
  }

  async updateEmailConnection(connectionId: string, updates: any) {
    const { data, error } = await this.supabase
      .from('email_connections')
      .update(updates)
      .eq('id', connectionId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async cacheEmails(
    emails: any[],
    userId: string,
    connectionId: string,
    folderId: string,
  ) {
    if (!emails || emails.length === 0) {
      this.logger.log('No emails to cache');
      return { success: true, count: 0 };
    }

    // Filter out invalid emails
    const validEmails = emails.filter((email) => {
      if (!email || !email.id) {
        this.logger.warn('Skipping invalid email object');
        return false;
      }
      return true;
    });

    this.logger.log(
      `Caching ${validEmails.length} valid emails out of ${emails.length} total`,
    );

    if (validEmails.length === 0) {
      return { success: true, count: 0 };
    }

    const cachePromises = validEmails.map((email) => {
      try {
        return this.supabase.from('cached_emails').upsert(
          {
            user_id: userId,
            connection_id: connectionId,
            provider_email_id: email.id,
            folder_id: folderId,
            subject: email.subject || '(No subject)',
            sender_name: email.sender?.name || 'Unknown',
            sender_email: email.sender?.email || '',
            recipients: email.to || [],
            cc: email.cc || null,
            date: email.date || new Date().toISOString(),
            body_preview: email.preview || '',
            body_html: email.body || '',
            read: email.read || false,
            starred: email.starred || false,
            has_attachments: !!email.attachments?.length,
            attachments: email.attachments || null,
          },
          {
            onConflict: 'user_id,connection_id,provider_email_id',
          },
        );
      } catch (error) {
        this.logger.error(`Error preparing email for cache: ${error.message}`);
        return Promise.resolve({ error });
      }
    });

    try {
      const results = await Promise.all(cachePromises);
      const errors = results.filter((result) => result.error);

      if (errors.length > 0) {
        this.logger.warn(
          `${errors.length} errors occurred while caching emails`,
        );
      }

      return {
        success: true,
        count: validEmails.length,
        errors: errors.length,
      };
    } catch (error) {
      this.logger.error(`Error caching emails: ${error.message}`);
      throw error;
    }
  }
}
