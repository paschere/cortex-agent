import { authenticateExtension } from '@/lib/browser-device/auth';
import { chromeDevice } from '@cortex/agent-tools';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 15;

/**
 * El resultado de una orden. Se valida con el MISMO contrato que la extensión
 * (parseResult): lo que vuelve de una página ajena es dato, y un campo
 * sensible no conserva su valor aunque la extensión se equivocara.
 */
export async function POST(request: Request) {
  const caller = await authenticateExtension(request);
  if (!caller) return NextResponse.json({ error: 'No autorizado.' }, { status: 401 });
  const length = Number(request.headers.get('content-length') ?? 0);
  if (length > chromeDevice.LIMITS.resultMaxBytes) {
    return NextResponse.json({ error: 'Resultado demasiado grande.' }, { status: 413 });
  }
  const text = await request.text();
  if (text.length > chromeDevice.LIMITS.resultMaxBytes) {
    return NextResponse.json({ error: 'Resultado demasiado grande.' }, { status: 413 });
  }
  let body: { commandId?: unknown; result?: unknown } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!body || typeof body.commandId !== 'string' || !/^[0-9a-f-]{36}$/.test(body.commandId)) {
    return NextResponse.json({ error: 'Falta commandId.' }, { status: 400 });
  }
  const parsed = chromeDevice.parseResult(body.result);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const ok = await chromeDevice.completeCommand(
    caller.db,
    caller.device,
    body.commandId,
    parsed.value,
  );
  return NextResponse.json({ ok }, { status: ok ? 200 : 404 });
}
