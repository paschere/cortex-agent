-- KB uploads bucket (private, 10MB limit, allowed MIME types)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'kb-uploads', 'kb-uploads', false, 10485760,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/plain',
    'text/markdown'
  ]
)
on conflict (id) do nothing;

-- Bucket is private; service role bypasses RLS — this policy blocks all non-service access
create policy "kb_uploads_service_only" on storage.objects
  for all
  using (false)
  with check (false);
