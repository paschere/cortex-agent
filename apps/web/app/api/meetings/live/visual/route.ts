import { createHash, timingSafeEqual } from 'node:crypto';
import { putFileDirect } from '@/lib/files-db';
import {
  LIVE_CALLS_BUCKET,
  liveCallObjectPath,
  normalizeTimeline,
} from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * El bot manda un JPEG de la sala (sobre todo cuando alguien comparte).
 * Autenticado con MEET_SERVICE_TOKEN. El archivo vive en app_files; el
 * índice (session + at + kind) viaja después en el archive JSON.
 */

const KINDS = new Set(['joined', 'left', 'presenting', 'presenting-end', 'frame']);

function tokenOk(req: NextRequest): boolean {
  const expected = process.env.MEET_SERVICE_TOKEN;
  if (!expected) return false;
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(req: NextRequest) {
  if (!tokenOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const owner = (req.headers.get('x-cortex-owner') ?? '').trim();
  const sessionId = (req.headers.get('x-cortex-session') ?? '').trim();
  const at = Number(req.headers.get('x-cortex-at') ?? '0');
  const kind = (req.headers.get('x-cortex-kind') ?? 'frame').trim();
  const label = decodeURIComponent(req.headers.get('x-cortex-label') ?? 'Sala').slice(0, 180);
  const speakerRaw = decodeURIComponent(req.headers.get('x-cortex-speaker') ?? '');
  if (!owner || !sessionId || sessionId.length > 80) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  if (!KINDS.has(kind)) return NextResponse.json({ error: 'bad kind' }, { status: 400 });

  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length < 80 || bytes.length > 1_500_000) {
    return NextResponse.json({ error: 'empty' }, { status: 400 });
  }

  const name = `${Math.max(0, Math.round(at * 10))}-${kind}.jpg`;
  const path = liveCallObjectPath(owner, sessionId, name);
  await putFileDirect({
    organizationId: owner,
    bucket: LIVE_CALLS_BUCKET,
    path,
    content: bytes,
    contentType: 'image/jpeg',
  });

  const event = normalizeTimeline([
    {
      at: Number.isFinite(at) ? at : 0,
      kind,
      label,
      speaker: speakerRaw || null,
      path,
    },
  ])[0];

  return NextResponse.json({ ok: true, path, event });
}
