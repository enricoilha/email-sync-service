create type "public"."email_provider_type" as enum ('outlook', 'gmail');

create type "public"."folder_type" as enum ('inbox', 'sent', 'drafts', 'archive', 'trash', 'custom');

create table "public"."cached_emails" (
    "id" uuid not null default uuid_generate_v4(),
    "user_id" uuid not null,
    "connection_id" uuid not null,
    "provider_email_id" text not null,
    "folder_id" uuid,
    "subject" text not null,
    "sender_name" text not null,
    "sender_email" text not null,
    "recipients" jsonb not null,
    "cc" jsonb,
    "bcc" jsonb,
    "date" timestamp with time zone not null,
    "body_preview" text,
    "body_html" text,
    "read" boolean default false,
    "starred" boolean default false,
    "has_attachments" boolean default false,
    "attachments" jsonb,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
);


alter table "public"."cached_emails" enable row level security;

create table "public"."email_connections" (
    "id" uuid not null default uuid_generate_v4(),
    "user_id" uuid not null,
    "provider" email_provider_type not null,
    "email" text not null,
    "access_token" text not null,
    "refresh_token" text not null,
    "token_expires_at" timestamp with time zone not null,
    "is_primary" boolean default false,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now(),
    "watch_history_id" text,
    "watch_expiration" timestamp with time zone,
    "settings_json" jsonb default '{}'::jsonb
);


alter table "public"."email_connections" enable row level security;

create table "public"."email_labels" (
    "email_id" uuid not null,
    "label_id" uuid not null,
    "created_at" timestamp with time zone not null default now()
);


alter table "public"."email_labels" enable row level security;

create table "public"."folders" (
    "id" uuid not null default uuid_generate_v4(),
    "user_id" uuid not null,
    "connection_id" uuid not null,
    "name" text not null,
    "type" folder_type not null,
    "provider_folder_id" text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
);


alter table "public"."folders" enable row level security;

create table "public"."labels" (
    "id" uuid not null default uuid_generate_v4(),
    "user_id" uuid not null,
    "name" text not null,
    "color" text not null,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
);


alter table "public"."labels" enable row level security;

create table "public"."user_settings" (
    "user_id" uuid not null,
    "theme" text default 'light'::text,
    "email_signature" text,
    "display_density" text default 'comfortable'::text,
    "notifications_enabled" boolean default true,
    "settings_json" jsonb default '{}'::jsonb,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
);


alter table "public"."user_settings" enable row level security;

create table "public"."users" (
    "id" uuid not null,
    "full_name" text,
    "avatar_url" text,
    "created_at" timestamp with time zone not null default now(),
    "updated_at" timestamp with time zone not null default now()
);


alter table "public"."users" enable row level security;

CREATE UNIQUE INDEX cached_emails_pkey ON public.cached_emails USING btree (id);

CREATE UNIQUE INDEX cached_emails_user_id_connection_id_provider_email_id_key ON public.cached_emails USING btree (user_id, connection_id, provider_email_id);

CREATE UNIQUE INDEX email_connections_pkey ON public.email_connections USING btree (id);

CREATE UNIQUE INDEX email_connections_user_id_email_key ON public.email_connections USING btree (user_id, email);

CREATE UNIQUE INDEX email_labels_pkey ON public.email_labels USING btree (email_id, label_id);

CREATE UNIQUE INDEX folders_pkey ON public.folders USING btree (id);

CREATE UNIQUE INDEX folders_user_id_connection_id_name_key ON public.folders USING btree (user_id, connection_id, name);

CREATE INDEX idx_cached_emails_date ON public.cached_emails USING btree (user_id, connection_id, date DESC);

CREATE INDEX idx_cached_emails_folder ON public.cached_emails USING btree (user_id, connection_id, folder_id);

CREATE UNIQUE INDEX labels_pkey ON public.labels USING btree (id);

CREATE UNIQUE INDEX labels_user_id_name_key ON public.labels USING btree (user_id, name);

CREATE UNIQUE INDEX user_settings_pkey ON public.user_settings USING btree (user_id);

CREATE UNIQUE INDEX users_pkey ON public.users USING btree (id);

alter table "public"."cached_emails" add constraint "cached_emails_pkey" PRIMARY KEY using index "cached_emails_pkey";

alter table "public"."email_connections" add constraint "email_connections_pkey" PRIMARY KEY using index "email_connections_pkey";

alter table "public"."email_labels" add constraint "email_labels_pkey" PRIMARY KEY using index "email_labels_pkey";

alter table "public"."folders" add constraint "folders_pkey" PRIMARY KEY using index "folders_pkey";

alter table "public"."labels" add constraint "labels_pkey" PRIMARY KEY using index "labels_pkey";

alter table "public"."user_settings" add constraint "user_settings_pkey" PRIMARY KEY using index "user_settings_pkey";

alter table "public"."users" add constraint "users_pkey" PRIMARY KEY using index "users_pkey";

alter table "public"."cached_emails" add constraint "cached_emails_connection_id_fkey" FOREIGN KEY (connection_id) REFERENCES email_connections(id) ON DELETE CASCADE not valid;

alter table "public"."cached_emails" validate constraint "cached_emails_connection_id_fkey";

alter table "public"."cached_emails" add constraint "cached_emails_folder_id_fkey" FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL not valid;

alter table "public"."cached_emails" validate constraint "cached_emails_folder_id_fkey";

alter table "public"."cached_emails" add constraint "cached_emails_user_id_connection_id_provider_email_id_key" UNIQUE using index "cached_emails_user_id_connection_id_provider_email_id_key";

alter table "public"."cached_emails" add constraint "cached_emails_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE not valid;

alter table "public"."cached_emails" validate constraint "cached_emails_user_id_fkey";

alter table "public"."email_connections" add constraint "email_connections_user_id_email_key" UNIQUE using index "email_connections_user_id_email_key";

alter table "public"."email_connections" add constraint "email_connections_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE not valid;

alter table "public"."email_connections" validate constraint "email_connections_user_id_fkey";

alter table "public"."email_labels" add constraint "email_labels_email_id_fkey" FOREIGN KEY (email_id) REFERENCES cached_emails(id) ON DELETE CASCADE not valid;

alter table "public"."email_labels" validate constraint "email_labels_email_id_fkey";

alter table "public"."email_labels" add constraint "email_labels_label_id_fkey" FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE not valid;

alter table "public"."email_labels" validate constraint "email_labels_label_id_fkey";

alter table "public"."folders" add constraint "folders_connection_id_fkey" FOREIGN KEY (connection_id) REFERENCES email_connections(id) ON DELETE CASCADE not valid;

alter table "public"."folders" validate constraint "folders_connection_id_fkey";

alter table "public"."folders" add constraint "folders_user_id_connection_id_name_key" UNIQUE using index "folders_user_id_connection_id_name_key";

alter table "public"."folders" add constraint "folders_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE not valid;

alter table "public"."folders" validate constraint "folders_user_id_fkey";

alter table "public"."labels" add constraint "labels_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE not valid;

alter table "public"."labels" validate constraint "labels_user_id_fkey";

alter table "public"."labels" add constraint "labels_user_id_name_key" UNIQUE using index "labels_user_id_name_key";

alter table "public"."user_settings" add constraint "user_settings_user_id_fkey" FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE not valid;

alter table "public"."user_settings" validate constraint "user_settings_user_id_fkey";

alter table "public"."users" add constraint "users_id_fkey" FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE not valid;

alter table "public"."users" validate constraint "users_id_fkey";

set check_function_bodies = off;

CREATE OR REPLACE FUNCTION public.update_modified_column()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$
;

grant delete on table "public"."cached_emails" to "anon";

grant insert on table "public"."cached_emails" to "anon";

grant references on table "public"."cached_emails" to "anon";

grant select on table "public"."cached_emails" to "anon";

grant trigger on table "public"."cached_emails" to "anon";

grant truncate on table "public"."cached_emails" to "anon";

grant update on table "public"."cached_emails" to "anon";

grant delete on table "public"."cached_emails" to "authenticated";

grant insert on table "public"."cached_emails" to "authenticated";

grant references on table "public"."cached_emails" to "authenticated";

grant select on table "public"."cached_emails" to "authenticated";

grant trigger on table "public"."cached_emails" to "authenticated";

grant truncate on table "public"."cached_emails" to "authenticated";

grant update on table "public"."cached_emails" to "authenticated";

grant delete on table "public"."cached_emails" to "service_role";

grant insert on table "public"."cached_emails" to "service_role";

grant references on table "public"."cached_emails" to "service_role";

grant select on table "public"."cached_emails" to "service_role";

grant trigger on table "public"."cached_emails" to "service_role";

grant truncate on table "public"."cached_emails" to "service_role";

grant update on table "public"."cached_emails" to "service_role";

grant delete on table "public"."email_connections" to "anon";

grant insert on table "public"."email_connections" to "anon";

grant references on table "public"."email_connections" to "anon";

grant select on table "public"."email_connections" to "anon";

grant trigger on table "public"."email_connections" to "anon";

grant truncate on table "public"."email_connections" to "anon";

grant update on table "public"."email_connections" to "anon";

grant delete on table "public"."email_connections" to "authenticated";

grant insert on table "public"."email_connections" to "authenticated";

grant references on table "public"."email_connections" to "authenticated";

grant select on table "public"."email_connections" to "authenticated";

grant trigger on table "public"."email_connections" to "authenticated";

grant truncate on table "public"."email_connections" to "authenticated";

grant update on table "public"."email_connections" to "authenticated";

grant delete on table "public"."email_connections" to "service_role";

grant insert on table "public"."email_connections" to "service_role";

grant references on table "public"."email_connections" to "service_role";

grant select on table "public"."email_connections" to "service_role";

grant trigger on table "public"."email_connections" to "service_role";

grant truncate on table "public"."email_connections" to "service_role";

grant update on table "public"."email_connections" to "service_role";

grant delete on table "public"."email_labels" to "anon";

grant insert on table "public"."email_labels" to "anon";

grant references on table "public"."email_labels" to "anon";

grant select on table "public"."email_labels" to "anon";

grant trigger on table "public"."email_labels" to "anon";

grant truncate on table "public"."email_labels" to "anon";

grant update on table "public"."email_labels" to "anon";

grant delete on table "public"."email_labels" to "authenticated";

grant insert on table "public"."email_labels" to "authenticated";

grant references on table "public"."email_labels" to "authenticated";

grant select on table "public"."email_labels" to "authenticated";

grant trigger on table "public"."email_labels" to "authenticated";

grant truncate on table "public"."email_labels" to "authenticated";

grant update on table "public"."email_labels" to "authenticated";

grant delete on table "public"."email_labels" to "service_role";

grant insert on table "public"."email_labels" to "service_role";

grant references on table "public"."email_labels" to "service_role";

grant select on table "public"."email_labels" to "service_role";

grant trigger on table "public"."email_labels" to "service_role";

grant truncate on table "public"."email_labels" to "service_role";

grant update on table "public"."email_labels" to "service_role";

grant delete on table "public"."folders" to "anon";

grant insert on table "public"."folders" to "anon";

grant references on table "public"."folders" to "anon";

grant select on table "public"."folders" to "anon";

grant trigger on table "public"."folders" to "anon";

grant truncate on table "public"."folders" to "anon";

grant update on table "public"."folders" to "anon";

grant delete on table "public"."folders" to "authenticated";

grant insert on table "public"."folders" to "authenticated";

grant references on table "public"."folders" to "authenticated";

grant select on table "public"."folders" to "authenticated";

grant trigger on table "public"."folders" to "authenticated";

grant truncate on table "public"."folders" to "authenticated";

grant update on table "public"."folders" to "authenticated";

grant delete on table "public"."folders" to "service_role";

grant insert on table "public"."folders" to "service_role";

grant references on table "public"."folders" to "service_role";

grant select on table "public"."folders" to "service_role";

grant trigger on table "public"."folders" to "service_role";

grant truncate on table "public"."folders" to "service_role";

grant update on table "public"."folders" to "service_role";

grant delete on table "public"."labels" to "anon";

grant insert on table "public"."labels" to "anon";

grant references on table "public"."labels" to "anon";

grant select on table "public"."labels" to "anon";

grant trigger on table "public"."labels" to "anon";

grant truncate on table "public"."labels" to "anon";

grant update on table "public"."labels" to "anon";

grant delete on table "public"."labels" to "authenticated";

grant insert on table "public"."labels" to "authenticated";

grant references on table "public"."labels" to "authenticated";

grant select on table "public"."labels" to "authenticated";

grant trigger on table "public"."labels" to "authenticated";

grant truncate on table "public"."labels" to "authenticated";

grant update on table "public"."labels" to "authenticated";

grant delete on table "public"."labels" to "service_role";

grant insert on table "public"."labels" to "service_role";

grant references on table "public"."labels" to "service_role";

grant select on table "public"."labels" to "service_role";

grant trigger on table "public"."labels" to "service_role";

grant truncate on table "public"."labels" to "service_role";

grant update on table "public"."labels" to "service_role";

grant delete on table "public"."user_settings" to "anon";

grant insert on table "public"."user_settings" to "anon";

grant references on table "public"."user_settings" to "anon";

grant select on table "public"."user_settings" to "anon";

grant trigger on table "public"."user_settings" to "anon";

grant truncate on table "public"."user_settings" to "anon";

grant update on table "public"."user_settings" to "anon";

grant delete on table "public"."user_settings" to "authenticated";

grant insert on table "public"."user_settings" to "authenticated";

grant references on table "public"."user_settings" to "authenticated";

grant select on table "public"."user_settings" to "authenticated";

grant trigger on table "public"."user_settings" to "authenticated";

grant truncate on table "public"."user_settings" to "authenticated";

grant update on table "public"."user_settings" to "authenticated";

grant delete on table "public"."user_settings" to "service_role";

grant insert on table "public"."user_settings" to "service_role";

grant references on table "public"."user_settings" to "service_role";

grant select on table "public"."user_settings" to "service_role";

grant trigger on table "public"."user_settings" to "service_role";

grant truncate on table "public"."user_settings" to "service_role";

grant update on table "public"."user_settings" to "service_role";

grant delete on table "public"."users" to "anon";

grant insert on table "public"."users" to "anon";

grant references on table "public"."users" to "anon";

grant select on table "public"."users" to "anon";

grant trigger on table "public"."users" to "anon";

grant truncate on table "public"."users" to "anon";

grant update on table "public"."users" to "anon";

grant delete on table "public"."users" to "authenticated";

grant insert on table "public"."users" to "authenticated";

grant references on table "public"."users" to "authenticated";

grant select on table "public"."users" to "authenticated";

grant trigger on table "public"."users" to "authenticated";

grant truncate on table "public"."users" to "authenticated";

grant update on table "public"."users" to "authenticated";

grant delete on table "public"."users" to "service_role";

grant insert on table "public"."users" to "service_role";

grant references on table "public"."users" to "service_role";

grant select on table "public"."users" to "service_role";

grant trigger on table "public"."users" to "service_role";

grant truncate on table "public"."users" to "service_role";

grant update on table "public"."users" to "service_role";

create policy "Users can only access their own cached emails"
on "public"."cached_emails"
as permissive
for all
to public
using ((auth.uid() = user_id));


create policy "Users can only access their own email connections"
on "public"."email_connections"
as permissive
for all
to public
using ((auth.uid() = user_id));


create policy "Users can only access their own email labels"
on "public"."email_labels"
as permissive
for all
to public
using ((email_id IN ( SELECT cached_emails.id
   FROM cached_emails
  WHERE (cached_emails.user_id = auth.uid()))));


create policy "Users can only access their own folders"
on "public"."folders"
as permissive
for all
to public
using ((auth.uid() = user_id));


create policy "Users can only access their own labels"
on "public"."labels"
as permissive
for all
to public
using ((auth.uid() = user_id));


create policy "Users can only access their own settings"
on "public"."user_settings"
as permissive
for all
to public
using ((auth.uid() = user_id));


create policy "Users can only access their own data"
on "public"."users"
as permissive
for all
to public
using ((auth.uid() = id));


CREATE TRIGGER update_cached_emails_modtime BEFORE UPDATE ON public.cached_emails FOR EACH ROW EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_email_connections_modtime BEFORE UPDATE ON public.email_connections FOR EACH ROW EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_folders_modtime BEFORE UPDATE ON public.folders FOR EACH ROW EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_labels_modtime BEFORE UPDATE ON public.labels FOR EACH ROW EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_user_settings_modtime BEFORE UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION update_modified_column();

CREATE TRIGGER update_users_modtime BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION update_modified_column();


-- Create a table to track sync operations
CREATE TABLE sync_operations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES email_connections(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'cancelled')),
  status_message TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  completed_at TIMESTAMP WITH TIME ZONE,
  folders_completed INTEGER NOT NULL DEFAULT 0,
  total_folders INTEGER NOT NULL DEFAULT 4,
  messages_synced INTEGER NOT NULL DEFAULT 0,
  current_folder TEXT,
  latest_history_id TEXT,
  provider email_provider_type NOT NULL,
  sync_type TEXT NOT NULL DEFAULT 'full',
  priority INTEGER NOT NULL DEFAULT 1,
  retry_count INTEGER NOT NULL DEFAULT 0,
  max_retries INTEGER NOT NULL DEFAULT 3,
  worker_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Add index for faster querying
CREATE INDEX sync_operations_user_id_idx ON sync_operations (user_id);
CREATE INDEX sync_operations_connection_id_idx ON sync_operations (connection_id);
CREATE INDEX sync_operations_status_idx ON sync_operations (status);

-- Add RLS policies
ALTER TABLE sync_operations ENABLE ROW LEVEL SECURITY;

-- Allow users to view only their own sync operations
CREATE POLICY "Users can view their own sync operations" 
ON sync_operations FOR SELECT 
USING (auth.uid() = user_id);

-- Allow users to insert their own sync operations
CREATE POLICY "Users can insert their own sync operations" 
ON sync_operations FOR INSERT 
WITH CHECK (auth.uid() = user_id);

-- Allow users to update their own sync operations
CREATE POLICY "Users can update their own sync operations" 
ON sync_operations FOR UPDATE 
USING (auth.uid() = user_id);

-- Add columns to email_connections table for sync tracking
ALTER TABLE email_connections 
ADD COLUMN latest_history_id TEXT,
ADD COLUMN last_synced_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN last_sync_type TEXT,
ADD COLUMN sync_enabled BOOLEAN DEFAULT TRUE,
ADD COLUMN sync_frequency INTEGER DEFAULT 15, -- minutes between syncs
ADD COLUMN sync_batch_size INTEGER DEFAULT 100, -- emails per batch
ADD COLUMN sync_status TEXT DEFAULT 'idle',
ADD COLUMN sync_error TEXT;

-- Create trigger function to update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on sync_operations table
CREATE TRIGGER update_sync_operations_timestamp
BEFORE UPDATE ON sync_operations
FOR EACH ROW
EXECUTE FUNCTION update_timestamp();

-- Create trigger on email_connections table if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'update_email_connections_timestamp') THEN
    CREATE TRIGGER update_email_connections_timestamp
    BEFORE UPDATE ON email_connections
    FOR EACH ROW
    EXECUTE FUNCTION update_timestamp();
  END IF;
END $$;

CREATE TABLE sync_workers (
  worker_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  last_heartbeat TIMESTAMP WITH TIME ZONE,
  cpu_info TEXT,
  memory_total BIGINT,
  current_memory_usage BIGINT,
  jobs_processed_count INTEGER DEFAULT 0,
  current_job_id UUID REFERENCES sync_operations(id) ON DELETE SET NULL,
  current_job_type TEXT,
  current_job_started TIMESTAMP WITH TIME ZONE,
  last_job_id UUID,
  last_job_completed TIMESTAMP WITH TIME ZONE,
  last_error_at TIMESTAMP WITH TIME ZONE,
  error_message TEXT,
  started_at TIMESTAMP WITH TIME ZONE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Create index for finding inactive workers
CREATE INDEX idx_sync_workers_status_heartbeat ON sync_workers (status, last_heartbeat);

-- Create trigger for updating timestamp
CREATE TRIGGER update_sync_workers_modtime 
BEFORE UPDATE ON sync_workers 
FOR EACH ROW 
EXECUTE FUNCTION update_modified_column();

-- Function to clean up inactive workers
CREATE OR REPLACE FUNCTION cleanup_inactive_workers()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  inactive_timeout INTERVAL := INTERVAL '5 minutes';
BEGIN
  -- Mark workers as inactive if no heartbeat received
  UPDATE sync_workers
  SET status = 'inactive'
  WHERE status = 'active'
    AND last_heartbeat < (NOW() - inactive_timeout);

  -- Release jobs from inactive workers
  UPDATE sync_operations
  SET worker_id = NULL,
      status_message = 'Worker became inactive, job released for reprocessing'
  WHERE status = 'in_progress'
    AND worker_id IN (
      SELECT worker_id 
      FROM sync_workers
      WHERE status = 'inactive'
    );
END;
$$;

-- Function to schedule jobs for incremental sync
CREATE OR REPLACE FUNCTION schedule_incremental_syncs()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  connection_record RECORD;
BEGIN
  -- Find connections that need incremental sync
  FOR connection_record IN
    SELECT 
      ec.id as connection_id,
      ec.user_id,
      ec.email,
      ec.provider,
      ec.sync_frequency
    FROM email_connections ec
    WHERE ec.sync_enabled = TRUE
      AND (
        ec.last_synced_at IS NULL 
        OR 
        ec.last_synced_at < (NOW() - (ec.sync_frequency * INTERVAL '1 minute'))
      )
      -- Exclude connections that already have a pending sync
      AND NOT EXISTS (
        SELECT 1 FROM sync_operations so
        WHERE so.connection_id = ec.id
          AND so.status = 'in_progress'
      )
  LOOP
    -- Create a new sync operation
    INSERT INTO sync_operations (
      user_id,
      connection_id,
      email,
      provider,
      status,
      progress,
      started_at,
      sync_type,
      priority
    ) VALUES (
      connection_record.user_id,
      connection_record.connection_id,
      connection_record.email,
      connection_record.provider,
      'in_progress',
      0,
      NOW(),
      'incremental',
      2 -- Lower priority than user-initiated syncs
    );
  END LOOP;
END;
$$;

-- Create a cron job to run these functions
-- Note: This requires pg_cron extension to be enabled
-- If pg_cron is not available, you'll need to schedule these jobs externally

-- Enable pg_cron extension if available
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    -- Schedule cleanup every minute
    PERFORM cron.schedule('* * * * *', 'SELECT cleanup_inactive_workers()');
    
    -- Schedule incremental syncs every minute
    PERFORM cron.schedule('* * * * *', 'SELECT schedule_incremental_syncs()');
  END IF;
END
$$;

-- If pg_cron is not available, add comment to indicate external scheduling needed
-- COMMENT ON FUNCTION cleanup_inactive_workers() IS 'Run this function regularly via an external scheduler if pg_cron is not available';
-- COMMENT ON FUNCTION schedule_incremental_syncs() IS 'Run this function regularly via an external scheduler if pg_cron is not available';

-- Add RLS policies
ALTER TABLE sync_workers ENABLE ROW LEVEL SECURITY;

-- Allow service role and authenticated users to view workers
CREATE POLICY "Service role can view workers" 
ON sync_workers FOR SELECT 
USING (true);

ALTER TABLE email_connections 
ADD COLUMN watch_resource_id TEXT,
ADD COLUMN watch_history_id TEXT,
ADD COLUMN watch_expiration TIMESTAMP WITH TIME ZONE;

-- If you need to add these columns to your table:
ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'idle';
ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS sync_error TEXT;
ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS last_sync_error_at TIMESTAMP;

-- Add necessary columns to email_connections table
ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS sync_status VARCHAR(50) DEFAULT 'idle';
ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS sync_error TEXT;
ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS last_sync_error_at TIMESTAMP;
ALTER TABLE email_connections ADD COLUMN IF NOT EXISTS sync_in_progress BOOLEAN DEFAULT false;

-- Create sync_locks table for distributed locking
CREATE TABLE IF NOT EXISTS sync_locks (
  id TEXT PRIMARY KEY,
  acquired_at TIMESTAMP NOT NULL,
  expires_at TIMESTAMP NOT NULL
);