import { z } from 'zod';
import { readWorkspacePlan } from '../billing/usage';
import { registerTool } from '../index';
import { fetchEventsInRange, parseMeetCode, type RawGCalEvent } from '../gcal/events';
import { gcalFetch } from '../gcal/client';

/**
 * ENTRAR A UNA REUNIÓN EN VIVO — la skill «Cortex, métete a esta llamada».
 *
 * ===========================================================================
 * CÓMO ENTRA EL BOT (2026)
 * ===========================================================================
 * El bot entra con la cuenta de Google dedicada (MEET_MODE=account), y antes
 * de mandarlo, esta tool asegura que el email del bot esté en el invite del
 * Calendar event. Si está en el invite, Google Meet lo clasifica como
 * participante "conocido" y lo admite directo — sin sala de espera, sin la
 * cola de "riesgo potencial" que deniega por defecto desde marzo 2026. Es la
 * misma técnica que usan Recall.ai, Claap y todos los vendors comerciales.
 *
 * F0 (el spike) dejó probado el audio. El join en vivo es el de Vexa
 * (Playwright 1.56, clicks humanizados por X11, selectores y admisión) en
 * services/meet-bot/src/join. El invite del calendario es lo que hace que
 * Google deje entrar al bot sin pelear.
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

/**
 * ASEGURAR QUE EL BOT ESTÁ EN EL INVITE — la pieza que hace que Google Meet
 * admita al bot sin pelear.
 *
 * Desde marzo 2026, Google Meet tiene dos colas para la sala de espera: una
 * para participantes "conocidos" (en el invite o del mismo dominio Workspace)
 * y otra para "riesgo potencial" (bots, anónimos, automatización) cuyo
 * default es DENEGAR. La única forma de que el bot caiga en la cola de bajo
 * riesgo es que su email esté en el invite del Calendar event. Esto lo hace
 * Recall.ai, Claap, y todos los vendors comerciales — no hay otra salida.
 *
 * Esta función busca el evento de Calendar cuyo Meet code matchea el meetUrl,
 * y si el bot no está en los attendees, lo agrega con un PATCH. Si no encuentra
 * el evento (la reunión no está en el calendario), no falla — el bot entra
 * igual, solo que puede que alguien tenga que admitirlo a mano.
 */
async function ensureBotOnInvite(
  ctx: import('../types').ToolContext,
  meetUrl: string,
  botEmail: string,
): Promise<{ added: boolean; eventId: string | null }> {
  const code = parseMeetCode({ hangoutLink: meetUrl });
  if (!code) return { added: false, eventId: null };

  const now = new Date();
  const timeMin = new Date(now.getTime() - 2 * 3_600_000).toISOString();
  const timeMax = new Date(now.getTime() + 6 * 3_600_000).toISOString();

  let events: RawGCalEvent[];
  try {
    events = await fetchEventsInRange(ctx, {
      calendarId: 'primary',
      timeMin,
      timeMax,
      maxResults: 50,
    });
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message }, 'could not fetch calendar events for bot invite');
    return { added: false, eventId: null };
  }

  const match = events.find((e) => parseMeetCode(e) === code);
  if (!match?.id) return { added: false, eventId: null };

  const alreadyInvited = (match.attendees ?? []).some(
    (a) => a.email?.toLowerCase() === botEmail.toLowerCase(),
  );
  if (alreadyInvited) return { added: false, eventId: match.id };

  try {
    await gcalFetch(ctx, `/calendars/primary/events/${encodeURIComponent(match.id)}?sendUpdates=none`, {
      method: 'PATCH',
      body: JSON.stringify({
        attendees: [
          ...(match.attendees ?? []),
          { email: botEmail, displayName: 'Cortex', responseStatus: 'accepted' },
        ],
      }),
    });
    ctx.logger.info({ eventId: match.id, botEmail }, 'bot added to calendar invite');
    return { added: true, eventId: match.id };
  } catch (err) {
    ctx.logger.warn({ err: (err as Error).message }, 'could not add bot to calendar invite');
    return { added: false, eventId: match.id };
  }
}

export const meetingsJoinLive = registerTool({
  id: 'meetings.join_live',
  description:
    'Entra a una reunión de Google Meet EN VIVO como invitado anónimo (un nombre visible para todos, sin usar la cuenta de Google del workspace), escucha en tiempo real y abre la sala en la pestaña «Llamadas» de la app (el menú, debajo de Chat), donde se ve todo lo que se dice en tiempo real y se puede preguntar sobre la llamada mientras pasa: «¿qué dijo Mateo del presupuesto?», «resúmeme lo que va», «¿quedó algún compromiso?». Úsala cuando te pidan «métete a esta reunión», «entra a este Meet y toma notas», «escucha esta llamada» y te den un link de meet.google.com. El bot aparece en la reunión con nombre propio y puede que alguien tenga que admitirlo. Al terminar el transcript queda guardado y alimenta los briefings. NO es para leer una transcripción vieja (meetings.get_transcript) ni para agendar (schedule): es para estar EN una reunión que ocurre ahora.',
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
    // Si el plan incluye voz, para que la sala muestre el control de «Voz
    // activa/silencio». Sin plan premium el bot solo escucha, y un botón de voz
    // que no puede hacer hablar a nadie es una promesa falsa: la tarjeta lo
    // oculta cuando esto es false.
    voiceEnabled: z.boolean().optional(),
    message: z.string(),
  }),
  // Visible ante otras personas: se aprueba, como abrir una pestaña. Y con la
  // concesión de conversación, no re-pregunta por cada reunión del mismo hilo.
  requiresConfirmation: true,
  conversationGrace: 15 * 60_000,
  rateLimit: { perMinute: 4 },
  requiredScopes: [{ provider: 'google', scopes: ['https://www.googleapis.com/auth/calendar.events'] }],
  handler: async (input, ctx) => {
    const svc = meetService();
    if (!svc) {
      return {
        ok: false,
        message:
          'El bot de reuniones no está conectado en este espacio de trabajo todavía. Alguien de operaciones tiene que apuntarlo primero.',
      };
    }
    // La voz es premium: se la decimos al bot solo si el plan la incluye. Sin
    // voz, el bot escucha y no habla — el default seguro. El plan se vuelve a
    // comprobar del lado que piensa la respuesta (voice-answer), así que esto es
    // una pista para la UI y el bot, no la única puerta.
    const voiceEnabled = await voiceAllowed(ctx.db);

    // ASEGURAR QUE EL BOT ESTÁ EN EL INVITE del Calendar event. Si el email del
    // bot está en el invite, Google Meet lo clasifica como participante conocido
    // y lo admite directo — sin sala de espera, sin cola de "riesgo potencial".
    // Sin proxy, sin stealth: es la solución que usan todos los vendors (Recall,
    // Claap, etc.). Si no hay MEET_GOOGLE_EMAIL configurado, se salta.
    const botEmail = process.env.MEET_GOOGLE_EMAIL?.trim();
    if (botEmail) {
      const invite = await ensureBotOnInvite(ctx, input.meetUrl, botEmail);
      if (invite.added) {
        ctx.logger.info({ meetUrl: input.meetUrl, eventId: invite.eventId }, 'bot invited to calendar event');
      }
    }

    let res: Response;
    try {
      res = await fetch(`${svc.base}/join`, {
        method: 'POST',
        headers: { authorization: `Bearer ${svc.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          owner: ctx.organizationId,
          userId: ctx.userId,
          meetUrl: input.meetUrl,
          botName: input.botName,
          voiceEnabled,
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
    const inviteNote = botEmail
      ? ' Me aseguré de estar en el invite del calendario, así que debería entrar directo.'
      : '';
    return {
      ok: true,
      sessionId,
      meetUrl: input.meetUrl,
      voiceEnabled,
      message: voiceEnabled
        ? `Voy entrando a la reunión — puede que alguien tenga que admitirme.${inviteNote} Síguela en la pestaña «Llamadas» (en el menú, debajo de Chat): ahí ves todo lo que se dice en tiempo real y puedes preguntarme sobre la llamada mientras pasa. Y como tienen voz activa, si alguien me nombra en la llamada («Cortex, …») respondo en voz alta ahí mismo; puedes silenciarme con un toque cuando quieras. Cuando termine, guardo el transcript y actualizo los briefings.`
        : `Voy entrando a la reunión — puede que alguien tenga que admitirme.${inviteNote} Síguela en la pestaña «Llamadas» (en el menú, debajo de Chat): ahí ves todo lo que se dice en tiempo real y puedes preguntarme sobre la llamada mientras pasa. Cuando termine, guardo el transcript y actualizo los briefings.`,
    };
  },
});
