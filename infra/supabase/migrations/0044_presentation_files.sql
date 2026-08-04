-- Downloadable candidate presentations.
--
-- An MCP tool can only return text, so "send me her presentation" has to be
-- answered with a LINK. presentations.create_pdf asks the Cortex matcher to
-- render the stored write-up to PDF (its own Puppeteer/letterhead exporter —
-- no second renderer), uploads the bytes to the private bucket below, and
-- records a row here. The row IS the link: /api/files/presentation/<token>
-- resolves it, checks the expiry, streams the object and counts the download.
--
-- Why a row instead of a Supabase signed URL: a signed URL leaks the storage
-- host and object path, expires with an opaque XML error, and can be neither
-- counted nor revoked. A link on our own domain can be audited, expired on our
-- terms, and repointed if the bytes ever move.
--
-- Why the token is the whole credential: the link is clicked out of a Claude
-- conversation, Slack or email, where no Cortex session cookie exists. A
-- session check would make the deliverable unopenable. Compensating controls
-- are 32 random bytes of entropy, a short expiry (7 days by default, written
-- by the tool, not defaulted here), and a download counter. The full
-- trade-off is documented on
-- apps/web/app/api/files/presentation/[token]/route.ts.
--
-- candidate_id / job_id are TEXT, not uuid references: they are matcher
-- identifiers and that database is a separate system. Never add an FK here.

create table if not exists public.presentation_files (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  candidate_id text not null,
  candidate_name text,
  job_id text,
  storage_path text not null,
  filename text not null,
  size_bytes integer,
  created_by uuid references public.users(id) on delete set null,
  downloads integer not null default 0,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- The download route looks up by token on every click; the two list paths are
-- "everything recent" and "everything for this candidate".
create index if not exists presentation_files_candidate_idx
  on public.presentation_files (candidate_id, created_at desc);
create index if not exists presentation_files_created_at_idx
  on public.presentation_files (created_at desc);
create index if not exists presentation_files_created_by_idx
  on public.presentation_files (created_by);

alter table public.presentation_files enable row level security;
-- Service-role only (RLS deny-all), same as the rest of the schema: every read
-- and write goes through the service client in apps/web/lib/supabase/service.ts.

-- Private bucket for the rendered PDFs. Separate from kb-uploads: different
-- lifetime (these expire), different producer (the agent, not a human upload)
-- and a single allowed MIME type. 25 MB ceiling — a presentation is ~100 KB,
-- so anything near the limit is a bug worth failing on.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('presentation-files', 'presentation-files', false, 26214400, array['application/pdf'])
on conflict (id) do nothing;

-- Bucket is private; the service role bypasses RLS, so this policy blocks all
-- non-service access (same pattern as 0013_storage_bucket.sql).
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'presentation_files_service_only'
  ) then
    create policy "presentation_files_service_only" on storage.objects
      for all
      using (false)
      with check (false);
  end if;
end $$;

-- Cortex gains the new family. Wildcard, so later presentations.* tools need no
-- migration (filterTools() in packages/agent-tools/src/registry.ts expands it).
update public.agents
set allowed_tool_ids = array_append(allowed_tool_ids, 'presentations.*')
where slug = 'cortex'
  and not ('presentations.*' = any(allowed_tool_ids));
