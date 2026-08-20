import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { listTools, readWorkspacePlan, runTool, voiceModel } from '@cortex/agent-tools';
import { ConfirmationRequiredError, SecurityBlockedError } from '@cortex/core';
import { type CoreTool, streamText, tool } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import WebSocket from 'ws';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * EL CEREBRO DEL MODO VOZ — Cortex piensa y habla en FLUJO CONTINUO.
 *
 * ===========================================================================
 * DOS STREAMS COSIDOS: EL MODELO Y LA VOZ
 * ===========================================================================
 * El modelo emite texto por tokens; Deepgram Aura, por su WebSocket de TTS,
 * sintetiza en flujo lo que se le va mandando y devuelve audio (PCM) en trozos
 * a medida que lo genera. Aquí se cosen los dos: cada cláusula que suelta el
 * modelo se empuja al WS, y cada trozo de audio que vuelve se reenvía al
 * cliente por SSE. No se espera a tener una frase entera ni su mp3 completo —
 * el audio empieza a fluir con las primeras palabras. Es el mínimo de latencia
 * que esta cadena permite.
 *
 * POR QUÉ EL WS Y NO EL REST. El /v1/speak REST devuelve el mp3 de una frase de
 * una sola vez: hay que esperar a que la frase entera esté sintetizada antes de
 * oír la primera sílaba. El WS emite audio conforme sintetiza, así que la
 * primera muestra sale en ~200ms en vez de en «toda la frase». La llave nunca
 * toca el navegador: el WS vive aquí, en el servidor, y el cliente solo recibe
 * PCM ya sintetizado.
 *
 * ===========================================================================
 * TRANSPORTE
 * ===========================================================================
 * SSE al cliente: `meta` (sample rate, una vez), `text` (la frase, para
 * pintarla), `audio` (PCM linear16 en base64, para reproducir en cola) y
 * `done`. El cliente reproduce el PCM con Web Audio (ver VoiceMode.tsx).
 *
 * Modelo: `voiceModel()` (Sonnet 5 sin thinking). Auto-autoriza las tools como
 * en reuniones; la capa de seguridad sigue bloqueando lo que clasifica `block`.
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
/** Deepgram Aura entrega PCM crudo por WS; el cliente lo reproduce a esta tasa. */
const SAMPLE_RATE = 24_000;

/** Corta el texto en cláusulas: mandarlas al TTS apenas listas baja la latencia. */
const CLAUSE = /^([\s\S]*?[.!?…,;:]+)(\s+)([\s\S]*)$/;

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'No entendí la pregunta.' }, { status: 400 });
  }
  const { question, history } = parsed.data;

  const orgId = user.organization.id;
  const db = getOrgScopedClient(orgId);

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

  const apiKey = process.env.DEEPGRAM_API_KEY;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };

      // Sin llave: se degrada a solo texto (el cliente pinta, no suena).
      if (!apiKey) {
        try {
          let buf = '';
          for await (const delta of result.textStream) {
            buf += delta;
            let m = buf.match(CLAUSE);
            while (m) {
              send('text', { text: (m[1] ?? '').trim() });
              buf = m[3] ?? '';
              m = buf.match(CLAUSE);
            }
          }
          if (buf.trim()) send('text', { text: buf.trim() });
          send('done', {});
        } catch {
          send('error', { message: 'No pude responder.' });
        } finally {
          controller.close();
        }
        return;
      }

      send('meta', { sampleRate: SAMPLE_RATE });

      const dgUrl = `wss://api.deepgram.com/v1/speak?encoding=linear16&sample_rate=${SAMPLE_RATE}&model=${encodeURIComponent(TTS_VOICE)}`;
      const ws = new WebSocket(dgUrl, { headers: { Authorization: `Token ${apiKey}` } });

      // El audio (binario) se reenvía al cliente; un `Flushed` de control marca
      // que Deepgram terminó de sintetizar todo lo que se le mandó.
      let resolveDone!: () => void;
      const audioDone = new Promise<void>((r) => {
        resolveDone = r;
      });
      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) {
          send('audio', { b64: (data as Buffer).toString('base64') });
          return;
        }
        try {
          const msg = JSON.parse(data.toString()) as { type?: string };
          if (msg.type === 'Flushed') resolveDone();
        } catch {
          /* metadatos no-JSON */
        }
      });
      ws.on('error', () => resolveDone());
      ws.on('close', () => resolveDone());

      const opened = new Promise<boolean>((resolve) => {
        ws.on('open', () => resolve(true));
        ws.on('error', () => resolve(false));
        setTimeout(() => resolve(false), 8_000);
      });

      try {
        const ok = await opened;
        if (!ok) {
          // El WS no abrió: caer a solo texto para no dejar el turno mudo.
          let buf = '';
          for await (const delta of result.textStream) {
            buf += delta;
            let m = buf.match(CLAUSE);
            while (m) {
              send('text', { text: (m[1] ?? '').trim() });
              buf = m[3] ?? '';
              m = buf.match(CLAUSE);
            }
          }
          if (buf.trim()) send('text', { text: buf.trim() });
          send('done', {});
          return;
        }

        // El modelo fluye; cada cláusula se pinta y se manda al TTS al instante.
        let buf = '';
        const speak = (text: string) => {
          const clean = text.trim();
          if (!clean) return;
          send('text', { text: clean });
          ws.send(JSON.stringify({ type: 'Speak', text: clean }));
        };
        for await (const delta of result.textStream) {
          buf += delta;
          let m = buf.match(CLAUSE);
          while (m) {
            speak(m[1] ?? '');
            buf = m[3] ?? '';
            m = buf.match(CLAUSE);
          }
        }
        if (buf.trim()) speak(buf);

        // Flush: síntetiza lo pendiente. Esperamos el `Flushed` (o el cierre).
        ws.send(JSON.stringify({ type: 'Flush' }));
        await Promise.race([audioDone, new Promise<void>((r) => setTimeout(r, 20_000))]);
        try {
          ws.send(JSON.stringify({ type: 'Close' }));
        } catch {
          /* ya cerrando */
        }
        send('done', {});
      } catch {
        send('error', { message: 'No pude terminar de responder.' });
      } finally {
        try {
          ws.close();
        } catch {
          /* ya cerrado */
        }
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
