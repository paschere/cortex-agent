import { getOrgScopedClient } from '@/lib/supabase/service';
import { chatModel, readWorkspacePlan } from '@cortex/agent-tools';
import { generateText } from 'ai';
import { createHash, timingSafeEqual } from 'node:crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * LA CABEZA DE LA VOZ — Cortex piensa lo que el bot va a decir en la reunión.
 *
 * ===========================================================================
 * QUIÉN LLAMA Y POR QUÉ NO ES UNA SESIÓN
 * ===========================================================================
 * Esta ruta la llama el BOT DE REUNIONES (services/meet-bot), no un navegador:
 * cuando alguien nombra a Cortex en la llamada, el bot manda aquí la pregunta y
 * la cola del transcript, Cortex responde con SU modelo y SU cerebro, y el bot
 * convierte ese texto en voz. Se autentica con el token de servicio (el mismo
 * MEET_SERVICE_TOKEN), no con una cookie — es infraestructura hablando con
 * infraestructura.
 *
 * ===========================================================================
 * LA VOZ ES PREMIUM: EL FLAG DE PLAN VIVE AQUÍ
 * ===========================================================================
 * Hablar en una reunión es la capa de arriba, y se cobra como tal. Este
 * endpoint es el punto único donde eso se decide: si el plan del workspace no
 * incluye voz, responde 403 y el bot se queda mudo (sigue escuchando, que es
 * el default seguro). Ponerlo aquí y no en el bot significa que la regla de
 * negocio vive del lado que conoce el plan, y el bot no tiene que saber nada de
 * facturación.
 *
 * ===========================================================================
 * CÓMO RESPONDE
 * ===========================================================================
 * Corto y para decirse en voz alta: una o dos frases, sin listas, sin markdown,
 * solo con lo que está en el transcript. Si no lo sabe, lo dice en una frase —
 * una reunión no perdona a un bot que inventa.
 */

const Body = z.object({
  owner: z.string().min(1),
  sessionId: z.string().optional(),
  question: z.string().min(1).max(500),
  transcript: z.string().max(20_000),
});

/** Los planes que incluyen voz en reunión. Ajustable sin tocar código de bot. */
const VOICE_PLANS = new Set((process.env.MEET_VOICE_PLANS || 'business,enterprise').split(','));

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
  if (!tokenOk(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const { owner, question, transcript } = parsed.data;

  // El flag de plan. Un plan sin voz recibe 403 y el bot se calla.
  const db = getOrgScopedClient(owner);
  const plan = await readWorkspacePlan(db).catch(() => null);
  if (!plan || !VOICE_PLANS.has(plan.plan.code)) {
    return NextResponse.json({ error: 'voice-not-in-plan' }, { status: 403 });
  }

  const { text } = await generateText({
    model: chatModel(),
    system:
      'Eres Cortex, y estás en una reunión por voz. Alguien te acaba de hablar. Responde para DECIRSE EN VOZ ALTA: una o dos frases, natural, sin listas ni markdown ni emojis. Usa SOLO lo que está en el transcript de la reunión; si la respuesta no está ahí, dilo en una frase corta y no inventes. Español, tono de colega que está en la llamada.',
    prompt: `TRANSCRIPT RECIENTE DE LA REUNIÓN:\n${transcript || '(nada aún)'}\n\nTE DIJERON: ${question}`,
  });

  return NextResponse.json({ answer: text });
}
