import { Injectable, Logger } from "@nestjs/common";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import configuration from "src/config/configuration";

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
      .from("email_connections")
      .select("*")
      .eq("user_id", userId);

    if (error) throw error;
    return data;
  }

  async updateEmailConnection(connectionId: string, updates: any) {
    const { data, error } = await this.supabase
      .from("email_connections")
      .update(updates)
      .eq("id", connectionId)
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
    try {
      if (!emails || emails.length === 0) {
        return { success: true, count: 0 };
      }

      // Transform emails for storage
      const emailsToInsert = emails.map((email) => ({
        user_id: userId,
        connection_id: connectionId,
        folder_id: folderId,
        email_id: email.id,
        thread_id: email.threadId || null,
        subject: email.subject,
        sender_name: email.sender?.name || null,
        sender_email: email.sender?.email || null,
        recipient_to: email.to ? JSON.stringify(email.to) : null,
        recipient_cc: email.cc ? JSON.stringify(email.cc) : null,
        date_received: email.date,
        body_html: email.body,
        preview: email.preview,
        is_read: email.read,
        is_starred: email.starred,
        has_attachments: email.attachments && email.attachments.length > 0,
        attachments: email.attachments
          ? JSON.stringify(email.attachments)
          : null,
        updated_at: new Date().toISOString(),
      }));

      // Use upsert to handle duplicates
      const { data, error } = await this.getClient()
        .from("cached_emails")
        .upsert(emailsToInsert, {
          onConflict: "user_id, connection_id, email_id",
          ignoreDuplicates: false,
        });

      if (error) throw error;

      return { success: true, count: emailsToInsert.length };
    } catch (error) {
      console.error(`Error caching emails: ${error.message}`);
      throw error;
    }
  }
}
