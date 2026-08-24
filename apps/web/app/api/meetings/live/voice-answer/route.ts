import { createHash, timingSafeEqual } from 'node:crypto';
import { buildToolContext } from '@/lib/agent';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { takeSpokenClauses, VOICE_LIVE_FACTS, wantsLiveLookup } from '@/lib/voice-spoken';
import { getTool, listTools, readWorkspacePlan, runTool, voiceModel } from '@cortex/agent-tools';
import { ConfirmationRequiredError, logger } from '@cortex/core';
import { type CoreTool, streamText, tool } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * LA CABEZA DE LA VOZ — Cortex piensa lo que el bot va a decir en la reunión,
 * con TODO su cerebro y sus herramientas.
 *
 * ===========================================================================
 * QUIÉN LLAMA
 * ===========================================================================
 * El bot de reuniones (services/meet-bot), cuando alguien nombra a Cortex en
 * la llamada. Autenticado con el token de servicio — infraestructura hablando
 * con infraestructura, no una sesión de usuario.
 *
 * ===========================================================================
 * UN TURNO DE VERDAD, NO UN Q&A DEL TRANSCRIPT
 * ===========================================================================
 * Corre un turno con el system prompt de Cortex (con memorias y hechos de la
 * empresa), un conjunto curado de herramientas, y el modelo — igual que el
 * chat, pero con la reunión como contexto y pensado para decirse en voz alta.
 * Así «Cortex, ¿cuánto le cotizamos a Acme?» mira el CRM y el cerebro, no solo
 * lo que se dijo en la llamada.
 *
 * ===========================================================================
 * STREAM, NO UN JSON AL FINAL
 * ===========================================================================
 * El bot de Meet pide `Accept: text/event-stream`. Cada cláusula (`text`) sale
 * apenas el modelo la cierra; el bot la manda al WebSocket de Deepgram Aura y
 * la sala oye la primera frase sin esperar el resto. `done` cierra el turno.
 *
 * ===========================================================================
 * MODO VOZ = AUTO-AUTORIZA. Y POR QUÉ ESO ES PELIGROSO Y AUN ASÍ CORRECTO.
 * ===========================================================================
 * En una reunión por voz no hay tarjeta que clickear: si una herramienta
 * pidiera confirmación, el turno se quedaría mudo esperando a nadie. Así que
 * en modo voz las confirmaciones se AUTO-AUTORIZAN (`confirmed: true`). Es una
 * decisión de producto explícita del dueño, y hay que decir lo que abre:
 * Cortex podría mandar un correo o crear algo con que se lo pidan de viva voz.
 * Lo que sigue en pie: la capa de SEGURIDAD (no la de confirmación) bloquea lo
 * que clasifica como `block`, la voz es premium (flag de plan), y todo lo
 * ejecutado queda en la auditoría. Un `block` sigue siendo un `block`.
 */

const Body = z.object({
  owner: z.string().min(1),
  sessionId: z.string().optional(),
  question: z.string().min(1).max(500),
  transcript: z.string().max(20_000),
  /** Saludo / «¿me oyes?»: sin tools, para no gastar 2–4 s mirando el catálogo. */
  quick: z.boolean().optional(),
});

type UUID = `${string}-${string}-${string}-${string}-${string}`;

const VOICE_PLANS = new Set((process.env.MEET_VOICE_PLANS || 'business,enterprise').split(','));

/**
 * Qué NO puede hacer la voz — una deny-list, no una allow-list. Por decisión
 * del dueño, en la reunión Cortex puede casi todo: leer el cerebro y el CRM,
 * mandar correos, RADICAR TRÁMITES, EJECUTAR PIPELINES, agendar, registrar
 * pagos. La voz auto-autoriza, así que el poder es real. Solo quedan fuera las
 * familias que no tienen sentido dichas en una llamada:
 *   - browser.*: abrir una pestaña viva que nadie mira en una reunión por voz.
 *   - screen/ask_choice: superficies del chat, no de la voz.
 *   - security/admin: administrar la seguridad no se hace de viva voz.
 * Todo lo demás entra. La capa de SEGURIDAD (no la de confirmación) sigue
 * bloqueando lo que clasifica como `block`; eso no lo afloja el modo voz.
 */
const VOICE_FAMILIES_BLOCKED = new Set(['browser', 'screen', 'security', 'admin']);

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

/** El agente `cortex` y un usuario dueño de la org, para escopar el turno. */
async function actorFor(orgId: string): Promise<{ userId: string; agentId: string } | null> {
  const db = getOrgScopedClient(orgId);
  const svc = getSupabaseServiceClient();
  const [{ data: agent }, { data: member }] = await Promise.all([
    db.from('agents').select('id').eq('slug', 'cortex').maybeSingle(),
    // El dueño (o el primer admin) — sus integraciones son las que el turno usa
    // para leer el CRM, el correo, etc. ba_* es la tabla de better-auth.
    svc
      .from('ba_member')
      .select('userId, role')
      .eq('organizationId', orgId)
      .order('role', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!agent?.id || !member?.userId) return null;
  return { userId: member.userId as string, agentId: agent.id as string };
}

async function liveWebBrief(
  question: string,
  ctx: ReturnType<typeof buildToolContext>,
): Promise<string> {
  const def = getTool('web.search');
  if (!def) return 'No hay buscador web. No inventes cifras.';
  try {
    const out = (await runTool(
      def,
      { query: question, searchDepth: 'basic', maxResults: 5, includeAnswer: true },
      ctx,
      { confirmed: true },
    )) as {
      answer: string | null;
      results: Array<{ title: string; content: string }>;
    };
    const lines = [
      out.answer ? `Resumen: ${out.answer}` : null,
      ...out.results.slice(0, 5).map((r) => `- ${r.title}: ${r.content.slice(0, 280)}`),
    ].filter(Boolean);
    return lines.join('\n') || 'La búsqueda no trajo nada. No inventes cifras.';
  } catch (err) {
    return `La consulta web falló (${(err as Error).message}). No inventes cifras.`;
  }
}

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  if (!tokenOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const { owner, question, transcript, quick } = parsed.data;

  // El flag de plan: sin voz en el plan, 403 y el bot se calla.
  const plan = await readWorkspacePlan(getOrgScopedClient(owner)).catch(() => null);
  if (!plan || !VOICE_PLANS.has(plan.plan.code)) {
    return NextResponse.json({ error: 'voice-not-in-plan' }, { status: 403 });
  }

  const actor = await actorFor(owner);
  if (!actor) return NextResponse.json({ error: 'no-actor' }, { status: 500 });

  const scopedCtx = buildToolContext({
    organizationId: owner,
    userId: actor.userId as UUID,
    agentId: actor.agentId as UUID,
    surface: 'web',
  });

  // El prompt base del agente, vivo de su fila (como el chat).
  const { data: agentRow } = await getOrgScopedClient(owner)
    .from('agents')
    .select('system_prompt')
    .eq('id', actor.agentId)
    .maybeSingle();

  const live = !quick && wantsLiveLookup(question);
  const brief = live ? await liveWebBrief(question, scopedCtx) : null;
  if (live) logger.info({ owner, sessionId: parsed.data.sessionId }, 'voice-answer live lookup');

  const { system } = await buildSystemPrompt({
    organizationId: owner,
    userId: actor.userId,
    basePrompt:
      (agentRow?.system_prompt as string) || 'Eres Cortex, el super-agente del espacio de trabajo.',
    // 'group': hay más personas en la sala; no repitas de viva voz una nota
    // privada de alguien (el mismo guard que en un grupo de WhatsApp).
    audience: 'group',
    sections: [
      `Estás EN una reunión por voz, y alguien te acaba de nombrar. Responde para DECIRSE EN VOZ ALTA: natural, sin listas ni markdown ni emojis. Puedes usar tus herramientas y el cerebro de la empresa. Si actúas (mandar algo, crear algo), dilo en la misma frase. ${VOICE_LIVE_FACTS}`,
      `TRANSCRIPT RECIENTE DE LA REUNIÓN:\n${transcript || '(nada aún)'}`,
      ...(brief
        ? [`CONSULTA WEB YA HECHA (fuente de las cifras; no uses un número que no esté aquí):\n${brief}`]
        : []),
    ],
  }).catch(() => ({
    system: 'Eres Cortex, en una reunión por voz. Responde corto, para decirse en voz alta.',
  }));

  const aiTools: Record<string, CoreTool> = {};
  if (!quick) {
    for (const def of listTools()) {
      const family = def.id.split('.')[0] ?? '';
      if (VOICE_FAMILIES_BLOCKED.has(family)) continue;
      aiTools[def.id.replaceAll('.', '_')] = tool({
        description: def.description,
        parameters: def.inputSchema,
        execute: async (args, { abortSignal }) => {
          try {
            // MODO VOZ: auto-autoriza. Ver la cabecera para lo que abre.
            return await runTool(
              def,
              args,
              { ...scopedCtx, signal: abortSignal },
              { confirmed: true },
            );
          } catch (err) {
            if (err instanceof ConfirmationRequiredError) {
              return { __error: true, message: 'necesitaba confirmación' };
            }
            return { __error: true, message: (err as Error).message };
          }
        },
      });
    }
  }

  // voiceModel(): sin thinking. Con chatModel() un «hola, ¿cómo estás?» tardaba
  // ~30 s y a veces volvía con text vacío (el bot callaba sin error, 21-08).
  const result = streamText({
    model: voiceModel(),
    system,
    prompt: `TE DIJERON EN LA REUNIÓN: ${question}`,
    ...(quick ? { maxSteps: 1 as const } : { tools: aiTools, maxSteps: 6 as const }),
  });

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      try {
        let buf = '';
        let sent = 0;
        for await (const delta of result.textStream) {
          buf += delta;
          const cut = takeSpokenClauses(buf);
          for (const clause of cut.clauses) {
            send('text', { text: clause });
            sent += 1;
          }
          buf = cut.rest;
        }
        if (buf.trim()) {
          send('text', { text: buf.trim() });
          sent += 1;
        }
        if (sent === 0) send('text', { text: 'Aquí estoy. ¿En qué te ayudo?' });
        send('done', {});
        logger.info(
          {
            owner,
            sessionId: parsed.data.sessionId,
            ms: Date.now() - startedAt,
            clauses: sent,
            quick: Boolean(quick),
            liveLookup: live,
          },
          'voice-answer',
        );
      } catch (err) {
        logger.error({ err }, 'voice-answer stream');
        send('error', { message: 'No pude responder.' });
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
