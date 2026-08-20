import { createHash, timingSafeEqual } from 'node:crypto';
import { buildToolContext } from '@/lib/agent';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import { buildSystemPrompt } from '@/lib/system-prompt';
import {
  ConfirmationRequiredError,
  chatModel,
  listTools,
  readWorkspacePlan,
  runTool,
} from '@cortex/agent-tools';
import { type CoreTool, generateText, tool } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 45;

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
});

const VOICE_PLANS = new Set((process.env.MEET_VOICE_PLANS || 'business,enterprise').split(','));

/**
 * Un conjunto CURADO de familias, no las 170 tools: una respuesta hablada no
 * navega ni radica trámites. Lee el cerebro y el CRM, mira compromisos y pagos,
 * y puede mandar un correo o agendar (auto-autorizado en voz). Chico a
 * propósito: el modelo elige mejor entre 30 que entre 170, y una reunión por
 * voz no es el sitio para las tools de más riesgo (browser, pagos que mueven
 * plata, etc.).
 */
const VOICE_FAMILIES = new Set([
  'kb',
  'clients',
  'commitments',
  'goals',
  'company',
  'cortex',
  'hubspot',
  'gmail',
  'gcal',
  'people',
  'reports',
  'inbox',
  'meetings',
  'payments',
]);

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

type UUID = `${string}-${string}-${string}-${string}-${string}`;

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

export async function POST(req: NextRequest) {
  if (!tokenOk(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'bad request' }, { status: 400 });
  const { owner, question, transcript } = parsed.data;

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

  const { system } = await buildSystemPrompt({
    organizationId: owner,
    userId: actor.userId,
    basePrompt:
      (agentRow?.system_prompt as string) || 'Eres Cortex, el super-agente del espacio de trabajo.',
    // 'group': hay más personas en la sala; no repitas de viva voz una nota
    // privada de alguien (el mismo guard que en un grupo de WhatsApp).
    audience: 'group',
    sections: [
      'Estás EN una reunión por voz, y alguien te acaba de nombrar. Responde para DECIRSE EN VOZ ALTA: una o dos frases, natural, sin listas ni markdown ni emojis. Puedes usar tus herramientas y el cerebro de la empresa. Si actúas (mandar algo, crear algo), dilo en la misma frase. Si no sabes, dilo corto.',
      `TRANSCRIPT RECIENTE DE LA REUNIÓN:\n${transcript || '(nada aún)'}`,
    ],
  }).catch(() => ({
    system: 'Eres Cortex, en una reunión por voz. Responde corto, para decirse en voz alta.',
  }));

  const aiTools: Record<string, CoreTool> = {};
  for (const def of listTools()) {
    const family = def.id.split('.')[0] ?? '';
    if (!VOICE_FAMILIES.has(family)) continue;
    aiTools[def.id.replaceAll('.', '_')] = tool({
      description: def.description,
      parameters: def.inputSchema,
      execute: async (args, { abortSignal }) => {
        try {
          // MODO VOZ: auto-autoriza. Ver la cabecera para lo que abre.
          return await runTool(def, args, { ...scopedCtx, signal: abortSignal }, { confirmed: true });
        } catch (err) {
          if (err instanceof ConfirmationRequiredError) {
            return { __error: true, message: 'necesitaba confirmación' };
          }
          return { __error: true, message: (err as Error).message };
        }
      },
    });
  }

  const { text } = await generateText({
    model: chatModel(),
    system,
    prompt: `TE DIJERON EN LA REUNIÓN: ${question}`,
    tools: aiTools,
    maxSteps: 6,
  });

  return NextResponse.json({ answer: text });
}
