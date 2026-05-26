create extension if not exists vector;

create type kb_scope as enum ('global', 'team', 'user', 'conversation');
create type document_status as enum ('pending', 'ingesting', 'ready', 'failed');
create type document_source as enum ('upload', 'gdrive', 'url');

create table public.kb_collections (
  id uuid primary key default gen_random_uuid(),
  scope kb_scope not null,
  scope_id uuid,
  name text not null,
  agent_id uuid references public.agents(id) on delete set null,
  gdrive_folder_id text,
  created_at timestamptz not null default now(),
  check (
    (scope = 'global' and scope_id is null)
    or (scope <> 'global' and scope_id is not null)
  )
);
create index kb_collections_scope_idx on public.kb_collections(scope, scope_id);

create table public.kb_documents (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.kb_collections(id) on delete cascade,
  source document_source not null,
  source_ref text,
  title text not null,
  mime text not null,
  sha256 text not null,
  uploaded_by uuid references public.users(id) on delete set null,
  status document_status not null default 'pending',
  error_message text,
  created_at timestamptz not null default now()
);
create index kb_documents_collection_idx on public.kb_documents(collection_id);

create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.kb_documents(id) on delete cascade,
  chunk_index int not null,
  content text not null,
  embedding vector(768) not null,
  tokens int not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index kb_chunks_document_idx on public.kb_chunks(document_id);
create index kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding vector_cosine_ops);
create index kb_chunks_content_fts_idx on public.kb_chunks using gin (to_tsvector('simple', content));

create table public.gdrive_sync_state (
  collection_id uuid primary key references public.kb_collections(id) on delete cascade,
  page_token text not null,
  last_synced_at timestamptz not null default now()
);
