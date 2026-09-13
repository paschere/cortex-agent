-- The bot now keeps the sitting as video, not only JPEG frames.
--
-- `recording_offset_sec` is how far into that file the transcript clock
-- starts (lobby + admit). A click on "3:12" seeks to 3:12 + this offset.
-- Uploaded recordings start at 0: the file IS the conversation.

alter table public.live_calls
  add column if not exists recording_offset_sec double precision not null default 0;

comment on column public.live_calls.recording_path is
  'Audio/video of the sitting in app_files bucket live-calls. Live joins write the Playwright webm; uploads write the file the person sent.';
comment on column public.live_calls.recording_offset_sec is
  'Seconds from the start of recording_path to transcript at=0. Zero for uploads.';
