import { z } from 'zod';
import { registerTool } from '../index';

/**
 * DECIR ALGO EN VOZ ALTA en la reunión en vivo, pedido desde el chat
 * («Cortex, háblale», «dile hola a todos»).
 *
 * Nombrar a Cortex DENTRO de la llamada ya dispara la voz sola. Esto es el
 * otro camino: la persona está en el chat y quiere que se oiga en el Meet.
 */

function meetService(): { base: string; token: string } | null {
  const base = process.env.MEET_SERVICE_URL?.replace(/\/+$/, '');
  const token = process.env.MEET_SERVICE_TOKEN;
  return base && token ? { base, token } : null;
}

export const meetingsSpeak = registerTool({
  id: 'meetings.speak',
  description:
    'Dice una frase EN VOZ ALTA dentro de la reunión de Google Meet a la que Cortex ya entró. Úsala cuando te pidan «háblale», «dile hola a todos», «enciende el micrófono y preséntate», «diles que ya te uniste». No entra a la reunión (eso es meetings.join_live); solo habla si ya estás dentro.',
  inputSchema: z.object({
    text: z
      .string()
      .min(1)
      .max(400)
      .describe('Lo que hay que decir, en una o dos frases, para oírse en la llamada.'),
    sessionId: z
      .string()
      .optional()
      .describe('La reunión concreta. Si se omite, habla en la única que esté viva.'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    message: z.string(),
  }),
  rateLimit: { perMinute: 8 },
  handler: async (input, ctx) => {
    const svc = meetService();
    if (!svc) {
      return { ok: false, message: 'El bot de reuniones no está conectado en este espacio.' };
    }

    let sessionId = input.sessionId?.trim() || '';
    if (!sessionId) {
      let list: Response;
      try {
        list = await fetch(`${svc.base}/live?owner=${encodeURIComponent(ctx.organizationId)}`, {
          headers: { authorization: `Bearer ${svc.token}` },
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        return { ok: false, message: 'No pude comunicarme con el bot de reuniones.' };
      }
      if (!list.ok) return { ok: false, message: 'No hay ninguna reunión viva ahora mismo.' };
      const data = (await list.json()) as {
        meetings?: Array<{ sessionId: string; status: string }>;
      };
      const live = (data.meetings ?? []).filter(
        (m) => m.status === 'live' || m.status === 'waiting-admit',
      );
      if (live.length === 0)
        return { ok: false, message: 'No hay ninguna reunión viva ahora mismo.' };
      if (live.length > 1) {
        return { ok: false, message: 'Hay más de una reunión viva. Dime en cuál hablar.' };
      }
      sessionId = live[0]?.sessionId ?? '';
    }

    let res: Response;
    try {
      res = await fetch(
        `${svc.base}/session/${encodeURIComponent(sessionId)}/speak?owner=${encodeURIComponent(ctx.organizationId)}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${svc.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text: input.text }),
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch {
      return { ok: false, message: 'No pude comunicarme con el bot de reuniones.' };
    }
    if (res.status === 404) {
      return { ok: false, message: 'Esa reunión ya no está en vivo.' };
    }
    if (!res.ok) {
      return { ok: false, message: 'No pude hablar en la reunión. Prueba otra vez en un momento.' };
    }
    return { ok: true, message: 'Lo dije en la reunión.' };
  },
});
