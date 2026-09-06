import { createHash } from 'node:crypto';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { realtimeSession } from '@/lib/voice-realtime';
import { consumeToken, readWorkspacePlan } from '@cortex/agent-tools';
import { NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 30;
const Body = z.object({
  sdp: z.string().min(10).max(100_000),
  history: z
    .array(z.object({ role: z.enum(['you', 'cortex']), text: z.string().max(2000) }))
    .max(12)
    .default([]),
});
export async function POST(req: Request) {
  const user = await requireSession();
  if (Number(req.headers.get('content-length') || 0) > 150_000)
    return NextResponse.json({ error: 'Solicitud demasiado grande.' }, { status: 413 });
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success)
    return NextResponse.json({ error: 'No se pudo preparar la llamada.' }, { status: 400 });
  const db = getOrgScopedClient(user.organization.id);
  const plan = await readWorkspacePlan(db).catch(() => null);
  const allowed = (
    process.env.VOICE_PLANS ||
    process.env.MEET_VOICE_PLANS ||
    'business,enterprise'
  ).split(',');
  if (!plan || !allowed.includes(plan.plan.code))
    return NextResponse.json(
      { error: 'El modo voz no está incluido en este plan.' },
      { status: 402 },
    );
  if (!process.env.OPENAI_API_KEY)
    return NextResponse.json(
      {
        error: 'La voz en tiempo real todavía no está configurada. Puedes usar el modo compatible.',
      },
      { status: 503 },
    );
  try {
    await consumeToken(db, user.id, 'voice.realtime', 3);
  } catch {
    return NextResponse.json(
      { error: 'Espera un momento antes de volver a conectar.' },
      { status: 429 },
    );
  }
  const form = new FormData();
  form.set('sdp', body.data.sdp);
  form.set(
    'session',
    JSON.stringify(
      realtimeSession(process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1', body.data.history),
    ),
  );
  try {
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'OpenAI-Safety-Identifier': createHash('sha256')
          .update(`${user.organization.id}:${user.id}`)
          .digest('hex'),
      },
      body: form,
      signal: AbortSignal.any([req.signal, AbortSignal.timeout(20_000)]),
    });
    if (!response.ok)
      return NextResponse.json(
        {
          error:
            'No fue posible conectar la voz en tiempo real. Intenta de nuevo o usa el modo compatible.',
        },
        { status: 502 },
      );
    return new Response(await response.text(), {
      headers: { 'content-type': 'application/sdp', 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json(
      { error: 'La conexión de voz tardó demasiado. Intenta de nuevo.' },
      { status: 504 },
    );
  }
}
