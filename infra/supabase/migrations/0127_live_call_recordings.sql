-- Live calls become something you can watch back, not just read.
--
-- WHAT WAS WRONG. `live_calls` kept who said what. The Calls page replayed a
-- transcript and Cortex's reading. That is enough for "qué acordamos" and not
-- enough for "en qué minuto mostraron la cotización" or "qué había en la
-- pantalla cuando Mateo compartió". The bot already sat in the call; it threw
-- the pixels away. A recording someone already had (Meet's own, a Zoom export)
-- had nowhere to land except Brain Knowledge as a faceless audio file.
--
-- WHAT THIS ADDS.
--   `source`           — 'live' (Cortex was in the Meet) or 'upload' (a file).
--   `timeline`         — ordered events: who joined, who presented, a frame.
--                        Frames are paths in `app_files` (bucket `live-calls`),
--                        not bytes in this row. The JSON is the index.
--   `recording_path`   — optional audio/video the person uploaded, same bucket.
--
-- WHY NOT A FULL VIDEO OF EVERY CALL. Headless Chromium encoding 1080p for an
-- hour is the wrong cost for "what was on screen when they shared". A JPEG
-- when presenting starts, then one every ~20 s while it lasts, is the record
-- of the shared surface. Speech stays in `transcript`. The uploaded file is
-- for the sitting Cortex did not attend.

alter table public.live_calls
  add column if not exists source text not null default 'live'
    check (source in ('live', 'upload')),
  add column if not exists timeline jsonb not null default '[]',
  add column if not exists recording_path text,
  add column if not exists recording_content_type text;

comment on column public.live_calls.source is
  '''live'' = Cortex sat in the Meet. ''upload'' = a recording someone filed afterwards.';
comment on column public.live_calls.timeline is
  'Ordered call events: [{at, kind, label, speaker, path, caption}]. at is seconds into the sitting. kind is joined | left | presenting | presenting-end | frame. path is an app_files path in bucket live-calls.';
comment on column public.live_calls.recording_path is
  'Optional uploaded audio/video in app_files bucket live-calls. Null when Cortex only kept the transcript and frames.';
