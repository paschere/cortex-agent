import { authenticateExtension } from '@/lib/browser-device/auth';
import { chromeDevice } from '@cortex/agent-tools';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/** La extensión se desvincula sola: el dispositivo queda revocado en Cortex. */
export async function POST(request: Request) {
  const caller = await authenticateExtension(request);
  if (!caller) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  await chromeDevice.revokeDevice(caller.db, caller.device.userId, caller.device.id);
  return NextResponse.json({ ok: true });
}
