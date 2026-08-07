-- The index for archived Outlook threads.
--
-- WHY IT IS NOT IN 0078, WHERE IT BELONGS. Postgres refuses to USE a value that
-- was added to an enum in the same transaction, and the Supabase CLI runs one
-- migration per transaction. Migration 0078 adds 'outlook' to `document_source`;
-- a partial index whose predicate names that value therefore cannot live beside
-- it, and putting them together fails at apply time with "invalid input value
-- for enum". Nothing in typecheck, the test suite or the production build
-- notices — every one of them was green while this was broken.
--
-- The next migration is the earliest place the value exists as far as Postgres
-- is concerned, so this is that place.

create index if not exists kb_documents_outlook_idx
  on public.kb_documents (collection_id, recorded_at desc)
  where source = 'outlook';
