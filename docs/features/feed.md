# Feed

`/feed` is a private intake surface, separate from Brain Knowledge. Users add
PDF, DOCX, XLSX, CSV, TXT, Markdown, pasted text, or public web pages. Uploads
are limited to 10 MB; parsed content to 200,000 characters; spreadsheets to
20 sheets and 50,000 cells. There are at most 100 active entries per user.

Entries reuse `chat_attachments` with `disposition = 'turn'`. Original bytes
live in `chat-uploads`; no KB document or embedding is created on intake or
consultation. The existing seven-day `purge_at` and `chat_surface_purge()`
remove temporary rows and bytes. Feed excludes expired entries immediately.
Deleting a Feed entry does not erase answers already produced in a chat or
copies explicitly saved in Brain Knowledge.

“Consultar con Cortex” creates a conversation once and attaches the entry.
The model receives an explicitly temporary excerpt, up to 12,000 characters.
For spreadsheets, `feed_table_query` also reads and calculates against all
stored cells, with row pagination, equality filters, sum, average, min, max,
and count. Column and row numbers start at one. The default first data row is
two; the model must verify headers and units. Non-numeric cells prevent a
numeric aggregate from silently producing a partial result. Excel formulas
use their saved results; formulas are never executed.

“Guardar en el cerebro” opens a destination picker and calls the existing
attachment promotion path only after the user selects that action. It copies
the original, checks space permissions, and queues normal KB ingestion.
Promotion is also available when explicitly requested in conversation.

Organization scoping applies through the existing scoped client. Feed reads,
consultation, deletion, attachment loading, and promotion additionally constrain
the creator and expiry. Public URLs use the existing guarded web scraper;
login-only pages are not supported. A URL captures a snapshot, not a live sync.
The UI identifies partial captures.

## Installation and verification

Apply `infra/supabase/migrations/0128_feed.sql` before deploying the app changes.
The migration adds Feed metadata to temporary attachments and allows them to
exist before a conversation. No new storage bucket or scheduled purge is needed.

Targeted tests:

```sh
pnpm --filter @cortex/agent-tools test src/kb/parsers.test.ts src/attachments/__tests__/promote.test.ts
pnpm --filter @cortex/web test lib/feed/routes.test.ts lib/feed/table-query.test.ts lib/nav-shape.test.ts lib/tenancy-guard.test.ts
pnpm --filter @cortex/web typecheck
```

The local implementation run verified these tests and exercised the actual Feed
React component on desktop and mobile against fixture API responses. A live
Supabase end-to-end run remains necessary: local PostgreSQL was not running
and migration 0128 could not be applied during that run.

The broader `lib/unchecked-reads.test.ts` guard has existing failures outside
Feed: unchecked reads in live meeting archive/voice-answer, voice turn, and
weekly report, plus an already-stale baseline for the chat route. The chat
route's unchecked-read count is one in both HEAD and this change. The attachment
route baseline was reduced because its GET now handles database errors.

## Routing, identity, and Google Sheets snapshots (0145)

Feed now proposes business areas per worksheet using explainable header matches.
Ambiguous/unknown tables remain unclassified. Recommendations appear in the preview
and temporary chat context; they never write CRM records, accounting entries, or KB.
Financial candidates flag missing currency and direction as well as record fields.

Identical parsed tables/text are reused within one owner and organization. URLs
retain their origin in the identity; capture timestamps are excluded. A database
unique index prevents simultaneous duplicate inserts. Expired entries release only
their identity slot, retaining their old evidence until the normal purge. Existing
legacy uploads can be reused by exact byte hash. This is exact-content detection,
not automatic reconciliation of differently formatted invoices from different systems.

Google Sheets URLs use the current workspace/user Google connection. A read captures
up to 20 tabs, A1:AZ1000 per tab, at most 50,000 populated cells in total. Larger grid
bounds visibly mark the capture partial. This is manual refresh, not unattended sync.
Changed contents create a separate snapshot; unchanged contents reuse the existing
snapshot without extending retention. The list groups URL snapshots by source and
can show older captures. XLSX/CSV remain supported through file upload.

Table queries report identical rows and their original row numbers. They do not
silently remove them: repeated transactions may be valid. Computed values explicitly
include all selected rows and require review when duplicates are present.
