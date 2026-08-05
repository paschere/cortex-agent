import { loadEvents, loadRun } from '@/lib/orchestrator/repository';
import { isTerminal } from '@/lib/orchestrator/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/** How often the log is drained. Fast enough to feel live, cheap enough to hold open. */
const POLL_MS = 500;
/** Status is re-read every Nth poll: it changes once, the log changes constantly. */
const STATUS_EVERY = 4;
/** Comment frame keeping proxies from closing an idle connection. */
const HEARTBEAT_MS = 15_000;
/** Hard stop, comfortably inside `maxDuration`. The browser reconnects if it matters. */
const MAX_STREAM_MS = 280_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Server-sent events for one run.
 *
 * A poll loop over `orchestration_events` rather than Postgres LISTEN/NOTIFY or
 * Supabase realtime: the log is append-only and keyed by a monotonic bigserial,
 * so "everything after id N" is one index scan and the client can resume from
 * exactly where it stopped — including across a reconnect — with no broker, no
 * missed-message window and no second connection to keep healthy.
 *
 * Every frame is a default `message` event carrying one row as JSON. The stream
 * ends with a named `closed` event, which is the client's signal to stop rather
 * than let EventSource reconnect forever.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const user = await requireSession();
  const { id } = await params;
  const db = getOrgScopedClient(user.organization.id);

  const run = await loadRun(db, id, user.organization.id);
  if (!run) return NextResponse.json({ error: 'Run not found' }, { status: 404 });

  // The page renders the log it already has and tells us where to pick up, so a
  // reload never replays hundreds of events the reader is already looking at.
  const after = Number(req.nextUrl.searchParams.get('after') ?? '0');
  let cursor = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;

  const encoder = new TextEncoder();
  const startedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const close = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime when the client went away.
        }
      };
      req.signal.addEventListener('abort', close);

      const send = (frame: string) => {
        if (!open) return false;
        try {
          controller.enqueue(encoder.encode(frame));
          return true;
        } catch {
          open = false;
          return false;
        }
      };

      // Tells the client where the stream actually starts, and flushes any
      // buffering proxy sitting in front of us.
      send(`event: open\ndata: ${JSON.stringify({ runId: id, after: cursor })}\n\n`);

      let status = run.status;
      let tick = 0;
      let lastBeat = Date.now();

      try {
        while (open) {
          const events = await loadEvents(db, id, cursor);
          for (const event of events) {
            cursor = event.id;
            // `id:` makes the browser send Last-Event-ID on reconnect; we also
            // echo it in the payload because the reducer dedupes on it.
            if (!send(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`)) break;
          }

          if (Date.now() - lastBeat > HEARTBEAT_MS) {
            send(': keep-alive\n\n');
            lastBeat = Date.now();
          }

          // A terminal run gets one final drain (the loop above just did it)
          // before the stream closes, so the run_done event can never be lost
          // to a race between the status write and the event insert.
          if (isTerminal(status) && events.length === 0) break;

          if (Date.now() - startedAt > MAX_STREAM_MS) break;

          if (tick++ % STATUS_EVERY === 0) {
            const fresh = await loadRun(db, id, user.organization.id);
            if (!fresh) break;
            status = fresh.status;
          }

          await sleep(POLL_MS);
        }

        send(`event: closed\ndata: ${JSON.stringify({ status, after: cursor })}\n\n`);
      } finally {
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends buffer by default, which turns a live console into a
      // page that shows everything at once when the run ends.
      'X-Accel-Buffering': 'no',
    },
  });
}
