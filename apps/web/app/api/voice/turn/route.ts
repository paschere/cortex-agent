import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { listTools, readWorkspacePlan, runTool, voiceModel } from '@cortex/agent-tools';
import { ConfirmationRequiredError, SecurityBlockedError } from '@cortex/core';
import { type CoreTool, streamText, tool } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * EL CEREBRO DEL MODO VOZ, EN STREAMING — Cortex piensa y HABLA por frases.
 *
 * ===========================================================================
 * POR QUÉ ESTO STREAMEA Y EL CHAT DE TEXTO PUEDE NO HACERLO
 * ===========================================================================
 * En una conversación hablada, el reloj es implacable: cada segundo antes de la
 * primera palabra se oye como un silencio incómodo. Así que aquí NO se espera a
 * que la respuesta esté entera para hablarla. El modelo emite texto; en cuanto
 * hay una FRASE completa, se sintetiza (Deepgram Aura-2) y se manda al cliente,
 * que la reproduce mientras el modelo sigue generando la siguiente. El «tiempo
 * hasta la primera palabra hablada» deja de ser «todo el turno» y pasa a ser
 * «la primera frase» — de segundos a ~un segundo.
 *
 * El transporte es SSE: un evento `text` por frase (para pintarla), un evento
 * `audio` con el mp3 en base64 (para reproducirla), y `done` al final. El
 * cliente encola el audio y lo reproduce sin cortes (ver VoiceMode.tsx).
 *
 * ===========================================================================
 * EL MODELO: SONNET SIN PENSAR
 * ===========================================================================
 * `voiceModel()` es Sonnet 5 con el `thinking` apagado — razonar en silencio es
 * justo el segundo muerto que la voz no perdona, y una respuesta de una o dos
 * frases no lo necesita. Ver la nota en packages/agent-tools/src/model.ts.
 *
 * ===========================================================================
 * MODO VOZ = AUTO-AUTORIZA (igual que en reuniones, y por lo mismo)
 * ===========================================================================
 * Hablando no hay tarjeta que tocar, así que las confirmaciones se AUTO-AUTORIZAN
 * (`confirmed: true`). Lo que NO se afloja: la capa de SEGURIDAD sigue bloqueando
 * lo que clasifica como `block`, la voz es premium, y todo lo ejecutado se
 * audita. Un `block` sigue siendo un `block`, y Cortex lo dice de viva voz en
 * vez de actuar.
 */

const Body = z.object({
  question: z.string().min(1).max(1_000),
  history: z
    .array(z.object({ role: z.enum(['you', 'cortex']), text: z.string().max(2_000) }))
    .max(20)
    .optional(),
});

type UUID = `${string}-${string}-${string}-${string}-${string}`;

const VOICE_FAMILIES_BLOCKED = new Set(['browser', 'screen', 'security', 'admin']);

const VOICE_PLANS = new Set(
  (process.env.VOICE_PLANS || process.env.MEET_VOICE_PLANS || 'business,enterprise').split(','),
);

const TTS_VOICE = process.env.VOICE_TTS_VOICE || 'aura-2-celeste-es';
const TTS_SPEED = process.env.VOICE_TTS_SPEED || '1';

/**
 * Una frase → mp3 en base64, o null si la voz no está configurada o falla. Un
 * fallo de síntesis no rompe el turno: el cliente igual pinta el texto.
 */
async function synthesize(text: string): Promise<string | null> {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) return null;
  const params = new URLSearchParams({ model: TTS_VOICE, speed: TTS_SPEED, encoding: 'mp3' });
  try {
    const res = await fetch(`https://api.deepgram.com/v1/speak?${params}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer()).toString('base64');
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'No entendí la pregunta.' }, { status: 400 });
  }
  const { question, history } = parsed.data;

  const orgId = user.organization.id;
  const db = getOrgScopedClient(orgId);

  // El muro premium, del lado servidor: no se salta ocultando un botón.
  const plan = await readWorkspacePlan(db).catch(() => null);
  if (!plan || !VOICE_PLANS.has(plan.plan.code)) {
    return NextResponse.json({ error: 'voice-not-in-plan' }, { status: 402 });
  }

  const { data: agentRow } = await db
    .from('agents')
    .select('id, system_prompt')
    .eq('slug', 'cortex')
    .maybeSingle();
  if (!agentRow?.id) {
    return NextResponse.json({ error: 'No encontré al agente.' }, { status: 500 });
  }

  const scopedCtx = buildToolContext({
    organizationId: orgId,
    userId: user.id as UUID,
    agentId: agentRow.id as UUID,
    surface: 'web',
  });

  const historyText = history?.length
    ? history.map((m) => `${m.role === 'you' ? 'Persona' : 'Cortex'}: ${m.text}`).join('\n')
    : '(inicio de la conversación)';

  const { system } = await buildSystemPrompt({
    organizationId: orgId,
    userId: user.id,
    basePrompt:
      (agentRow.system_prompt as string) || 'Eres Cortex, el super-agente del espacio de trabajo.',
    audience: 'private',
    sections: [
      'Estás en MODO VOZ: la persona te habla y tú le respondes EN VOZ ALTA. Contesta para decirse, no para leerse: una o dos frases, natural, sin listas ni markdown ni emojis ni URLs largas. Puedes usar tus herramientas y el cerebro de la empresa. Si actúas (mandar algo, crear algo, registrar algo), dilo en la misma frase. Si algo no se puede o queda bloqueado, dilo corto y ofrece la alternativa.',
      `LO QUE VAN HABLADO EN ESTA CONVERSACIÓN DE VOZ:\n${historyText}`,
    ],
  }).catch(() => ({
    system: 'Eres Cortex, en modo voz. Responde corto, para decirse en voz alta, en español.',
  }));

  const aiTools: Record<string, CoreTool> = {};
  for (const def of listTools()) {
    const family = def.id.split('.')[0] ?? '';
    if (VOICE_FAMILIES_BLOCKED.has(family)) continue;
    aiTools[def.id.replaceAll('.', '_')] = tool({
      description: def.description,
      parameters: def.inputSchema,
      execute: async (args, { abortSignal }) => {
        try {
          return await runTool(
            def,
            args,
            { ...scopedCtx, signal: abortSignal },
            { confirmed: true },
          );
        } catch (err) {
          if (err instanceof ConfirmationRequiredError) {
            return {
              __error: true,
              message: 'necesitaba una confirmación que en voz no se puede pedir',
            };
          }
          if (err instanceof SecurityBlockedError) {
            return { __error: true, message: (err as Error).message };
          }
          return { __error: true, message: (err as Error).message };
        }
      },
    });
  }

  const result = streamText({
    model: voiceModel(),
    system,
    prompt: `TE DIJO LA PERSONA: ${question}`,
    tools: aiTools,
    maxSteps: 6,
  });

  // Corta una frase cuando ve puntuación final seguida de espacio. Un tope de
  // longitud fuerza el corte aunque no haya puntuación (una lista dictada, un
  // titubeo), para que la voz nunca se quede esperando un punto que no llega.
  const SENTENCE = /^([\s\S]*?[.!?…]+)(\s+)([\s\S]*)$/;
  const MAX_CHUNK = 220;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const flush = async (raw: string) => {
        const text = raw.trim();
        if (!text) return;
        send('text', { text });
        const b64 = await synthesize(text);
        if (b64) send('audio', { b64 });
      };

      let buf = '';
      try {
        for await (const delta of result.textStream) {
          buf += delta;
          // Saca todas las frases completas que haya en el buffer.
          let m = buf.match(SENTENCE);
          while (m) {
            await flush(m[1] ?? '');
            buf = m[3] ?? '';
            m = buf.match(SENTENCE);
          }
          if (buf.length > MAX_CHUNK) {
            await flush(buf);
            buf = '';
          }
        }
        if (buf.trim()) await flush(buf);
        send('done', {});
      } catch {
        send('error', { message: 'No pude terminar de responder.' });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    },
  });
}
