import { pool } from '@/lib/auth';
import { auth } from '@/lib/auth';
import { requireNotificationAccount } from '@/lib/notifications/account';
import {
  countGlobalUnread,
  listGlobalNotifications,
  notificationSnapshotKey,
} from '@/lib/notifications/global-repository';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** SSE autenticado; cada snapshot vuelve a comprobar las membresías actuales. */
export async function GET(req: NextRequest): Promise<Response> {
  const account = await requireNotificationAccount();
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      let previous = '';
      const close = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          /* runtime closed the request */
        }
      };
      const send = (event: string, data: unknown) => {
        if (!open) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      req.signal.addEventListener('abort', close);
      try {
        send('open', { connected: true });
        let lastAuthCheck = Date.now();
        while (open && Date.now() - startedAt < 280_000) {
          if (Date.now() - lastAuthCheck >= 10_000) {
            const liveSession = await auth.api.getSession({
              headers: req.headers,
              query: { disableCookieCache: true },
            });
            if (!liveSession?.user || liveSession.user.id !== account.id) break;
            lastAuthCheck = Date.now();
          }
          const [notifications, unread] = await Promise.all([
            listGlobalNotifications(pool, account.id),
            countGlobalUnread(pool, account.id),
          ]);
          const key = notificationSnapshotKey(notifications);
          if (key !== previous) {
            previous = key;
            send('snapshot', {
              notifications,
              unread,
            });
          } else {
            controller.enqueue(encoder.encode(': keep-alive\n\n'));
          }
          await sleep(3_000);
        }
        send('closed', {});
      } catch {
        send('fault', { message: 'La actualización en vivo se interrumpió.' });
      } finally {
        close();
      }
    },
  });
  return new NextResponse(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
