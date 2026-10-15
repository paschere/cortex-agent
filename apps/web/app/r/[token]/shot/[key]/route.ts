import { openReplay, readReplayShot } from '@/lib/task-share/public';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/** Una captura de la repetición compartida (sólo si el enlace sigue vivo). */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string; key: string }> },
) {
  const { token, key } = await params;
  const opened = await openReplay(token, { count: false });
  const bytes = opened ? await readReplayShot(opened, key) : null;
  if (!bytes) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': 'image/jpeg',
      'cache-control': 'private, no-store',
      'x-robots-tag': 'noindex',
      'x-content-type-options': 'nosniff',
    },
  });
}
