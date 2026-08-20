import { z } from 'zod';
import { readWorkspacePlan } from '../billing/usage';
import { registerTool } from '../index';

/**
 * ENTRAR A UNA REUNIÓN EN VIVO — la skill «Cortex, métete a esta llamada».
 *
 * ===========================================================================
 * QUÉ HACE Y QUÉ NO
 * ===========================================================================
 * Le pide al bot de reuniones (services/meet-bot) que entre a un Meet como la
 * cuenta del workspace, empiece a escuchar, y devuelva un id de sesión. NO
 * espera a que la reunión termine ni transcribe aquí: el transcript vive en el
 * bot y se ve en tiempo real en la UI de reunión del chat (una superficie
 * propia con su chat, que se abre con este id). Al colgar, Cortex importa el
 * transcript por el camino que ya existe (meetings.import_transcript) y de ahí
 * alimenta briefings y compromisos.
 *
 * Por qué pide confirmación: meter a Cortex a una reunión es una acción
 * visible ante otras personas — el bot aparece en la lista de participantes con
 * nombre propio. Como abrir una pestaña o enviar un correo, se aprueba una vez;
 * y con la concesión de conversación, entrar a otra reunión en el mismo hilo no
 * vuelve a preguntar durante un rato.
 *
 * F0 (el spike) dejó probado lo que esta tool asume: el bot entra AUTENTICADO
 * (la cuenta del workspace, logueada una vez con el flujo de secretos), porque
 * el invitado anónimo choca con el anti-bot de Meet. Si la cuenta no está
 * logueada, el bot lo dirá como estado 'failed' y esta tool lo reporta.
 */

function meetService(): { base: string; token: string } | null {
  const base = process.env.MEET_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.MEET_SERVICE_TOKEN;
  return base && token ? { base, token } : null;
}

const VOICE_PLANS = new Set((process.env.MEET_VOICE_PLANS || 'business,enterprise').split(','));

async function voiceAllowed(db: import('@supabase/supabase-js').SupabaseClient): Promise<boolean> {
  try {
    const wp = await readWorkspacePlan(db);
    return VOICE_PLANS.has(wp.plan.code);
  } catch {
    return false;
  }
}

export const meetingsJoinLive = registerTool({
  id: 'meetings.join_live',
  description:
    'Entra a una reunión de Google Meet EN VIVO como un participante (la cuenta de este espacio de trabajo), escucha en tiempo real y abre una sala de seguimiento en el chat donde puedes preguntar sobre la llamada mientras pasa: «¿qué dijo Mateo del presupuesto?», «resúmeme lo que va», «¿quedó algún compromiso?». Úsala cuando te pidan «métete a esta reunión», «entra a este Meet y toma notas», «escucha esta llamada» y te den un link de meet.google.com. El bot aparece en la reunión con nombre propio (es visible para todos), y al terminar el transcript queda guardado y alimenta los briefings. NO es para leer una transcripción vieja (meetings.get_transcript) ni para agendar (schedule): es para estar EN una reunión que ocurre ahora.',
  inputSchema: z.object({
    meetUrl: z
      .string()
      .url()
      .regex(/meet\.google\.com/, 'Tiene que ser un enlace de meet.google.com')
      .describe('El enlace completo de la reunión de Google Meet.'),
    botName: z
      .string()
      .max(40)
      .default('Cortex')
      .describe('El nombre con el que el bot aparece en la reunión. Por defecto «Cortex».'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    sessionId: z.string().optional(),
    meetUrl: z.string().optional(),
    message: z.string(),
  }),
  // Visible ante otras personas: se aprueba, como abrir una pestaña. Y con la
  // concesión de conversación, no re-pregunta por cada reunión del mismo hilo.
  requiresConfirmation: true,
  conversationGrace: 15 * 60_000,
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    const svc = meetService();
    if (!svc) {
      return {
        ok: false,
        message:
          'El bot de reuniones no está conectado en este espacio de trabajo todavía. Alguien de operaciones tiene que apuntarlo primero.',
      };
    }
    let res: Response;
    try {
      res = await fetch(`${svc.base}/join`, {
        method: 'POST',
        headers: { authorization: `Bearer ${svc.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          owner: ctx.organizationId,
          meetUrl: input.meetUrl,
          botName: input.botName,
          // La voz es premium: se la decimos al bot solo si el plan la incluye.
          // Sin voz, el bot escucha y no habla — el default seguro. El plan se
          // vuelve a comprobar del lado que piensa la respuesta (voice-answer).
          voiceEnabled: await voiceAllowed(ctx.db),
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      ctx.logger.warn({ err: (err as Error).message }, 'meet join request failed');
      return { ok: false, message: 'No pude comunicarme con el bot de reuniones. Puede estar reiniciándose.' };
    }
    if (!res.ok) {
      if (res.status === 429) {
        return { ok: false, message: 'El bot ya está en el máximo de reuniones a la vez. Espera a que una termine.' };
      }
      return { ok: false, message: 'El bot de reuniones rechazó la solicitud.' };
    }
    const { sessionId } = (await res.json()) as { sessionId: string };
    return {
      ok: true,
      sessionId,
      meetUrl: input.meetUrl,
      message:
        'Voy entrando a la reunión — puede que alguien tenga que admitirme. Sigue la sala en vivo aquí en el chat: te muestro lo que se dice y puedes preguntarme sobre la llamada en tiempo real. Cuando termine, guardo el transcript y actualizo los briefings.',
    };
  },
});
