import { isSameOrigin } from '@/lib/activations/request';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { SPEAK_MAX_CHARS, VOICE_PLANS, synthesizeSpeech } from '@/lib/voice-tts';
import { consumeToken, readWorkspacePlan } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * LEER UNA FRASE CON LA VOZ DE CORTEX (Deepgram Aura). Sólo con sesión y plan
 * con voz (los mismos de /api/voice/turn): el asistente de voz de los
 * formularios usa la voz del navegador, gratis y también en el enlace público,
 * y ofrece ésta dentro de la app a quien la tiene.
 *
 * GET dice si está disponible (plan + llave) para mostrar la opción; POST
 * devuelve el mp3 de la frase.
 */

async function gate(): Promise<
  | { ok: true; userId: string; db: ReturnType<typeof getOrgScopedClient> }
  | { ok: false; res: NextResponse }
> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const plan = await readWorkspacePlan(db).catch(() => null);
  if (!plan || !VOICE_PLANS.has(plan.plan.code))
    return { ok: false, res: NextResponse.json({ error: 'voice-not-in-plan' }, { status: 402 }) };
  return { ok: true, userId: user.id, db };
}

export async function GET() {
  const g = await gate();
  if (!g.ok) return NextResponse.json({ available: false });
  return NextResponse.json({ available: Boolean(process.env.DEEPGRAM_API_KEY) });
}

const Body = z.object({ text: z.string().trim().min(1).max(SPEAK_MAX_CHARS) });

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'No entendí la frase.' }, { status: 400 });
  const g = await gate();
  if (!g.ok) return g.res;
  try {
    await consumeToken(g.db, g.userId, 'voice.speak', 90);
  } catch {
    return NextResponse.json({ error: 'Muchas frases seguidas.' }, { status: 429 });
  }
  const audio = await synthesizeSpeech(parsed.data.text, { signal: req.signal });
  if (!audio) return NextResponse.json({ error: 'La voz no está disponible.' }, { status: 503 });
  return new Response(audio, {
    headers: { 'content-type': 'audio/mpeg', 'cache-control': 'private, no-store' },
  });
}
