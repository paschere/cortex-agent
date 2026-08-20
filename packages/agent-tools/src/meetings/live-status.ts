import { z } from 'zod';
import { registerTool } from '../index';

/**
 * F2 — QUÉ ESTÁ PASANDO EN LA REUNIÓN, desde el chat normal de Cortex.
 *
 * La sala en vivo (MeetingLive) tiene su propio chat, pegado al transcript.
 * Pero a veces la persona está en el chat NORMAL de Cortex y quiere saber sin
 * cambiar de superficie: «¿qué va diciendo en la reunión?», «¿ya salió el tema
 * del presupuesto?». Esta tool trae el estado y la cola reciente del
 * transcript de las reuniones vivas de este workspace, para que el turno
 * normal pueda responder con lo que se está diciendo AHORA.
 *
 * Es de solo lectura y no confirma nada: mirar una reunión en curso no cambia
 * nada en el mundo. Actuar sobre lo que se dijo («mándale el resumen a Ana»)
 * sigue pasando por las tools que sí confirman.
 */

function meetService(): { base: string; token: string } | null {
  const base = process.env.MEET_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.MEET_SERVICE_TOKEN;
  return base && token ? { base, token } : null;
}

export const meetingsLiveStatus = registerTool({
  id: 'meetings.live_status',
  description:
    'Dice qué está pasando AHORA en las reuniones a las que Cortex entró en vivo: si sigue dentro, y las últimas frases de lo que se ha dicho. Úsala cuando pregunten desde el chat normal «¿qué va diciendo en la reunión?», «¿de qué están hablando?», «¿ya salió tal tema?», «resúmeme lo que va de la llamada» — sin tener que abrir la sala de la reunión. Solo lee; para entrar a una reunión es meetings.join_live.',
  inputSchema: z.object({
    sessionId: z
      .string()
      .optional()
      .describe('El id de una reunión concreta. Si se omite, trae todas las reuniones vivas.'),
    lines: z
      .number()
      .int()
      .min(1)
      .max(80)
      .default(30)
      .describe('Cuántas de las últimas frases del transcript traer.'),
  }),
  outputSchema: z.object({
    meetings: z.array(
      z.object({
        sessionId: z.string(),
        status: z.string(),
        recent: z.array(z.object({ speaker: z.string().nullable(), text: z.string() })),
      }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const svc = meetService();
    if (!svc) {
      return { meetings: [], guidance: 'El bot de reuniones no está conectado en este espacio.' };
    }
    // El bot indexa por organización; se le pide la lista de las vivas de este
    // dueño (o una concreta si vino el id).
    const path = input.sessionId
      ? `/session/${encodeURIComponent(input.sessionId)}`
      : `/live?owner=${encodeURIComponent(ctx.organizationId)}`;
    let res: Response;
    try {
      res = await fetch(`${svc.base}${path}`, {
        headers: { authorization: `Bearer ${svc.token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return { meetings: [], guidance: 'No pude comunicarme con el bot de reuniones.' };
    }
    if (!res.ok) {
      return { meetings: [], guidance: 'No hay ninguna reunión viva en este momento.' };
    }

    const data = (await res.json()) as
      | { transcript?: Array<{ speaker: string | null; text: string }>; status?: string }
      | { meetings?: Array<{ sessionId: string; status: string; transcript: Array<{ speaker: string | null; text: string }> }> };

    const list =
      'meetings' in data && data.meetings
        ? data.meetings
        : 'transcript' in data
          ? [{ sessionId: input.sessionId ?? '', status: data.status ?? 'live', transcript: data.transcript ?? [] }]
          : [];

    const meetings = list.map((m) => ({
      sessionId: m.sessionId,
      status: m.status,
      recent: (m.transcript ?? []).slice(-(input.lines ?? 30)).map((l) => ({ speaker: l.speaker, text: l.text })),
    }));

    return {
      meetings,
      guidance: meetings.length
        ? 'Estas son las últimas frases de la(s) reunión(es) en vivo. Responde con lo que se dijo; si la respuesta no está aquí, dilo.'
        : 'No hay ninguna reunión viva ahora mismo.',
    };
  },
});
