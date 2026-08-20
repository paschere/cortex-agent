import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildSystemPrompt } from '@/lib/system-prompt';
import { chatModel, listTools, readWorkspacePlan, runTool } from '@cortex/agent-tools';
import { ConfirmationRequiredError, SecurityBlockedError } from '@cortex/core';
import { type CoreTool, generateText, tool } from 'ai';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 45;

/**
 * EL CEREBRO DEL MODO VOZ — Cortex piensa, en voz alta, hablándote a ti.
 *
 * ===========================================================================
 * QUÉ ES
 * ===========================================================================
 * El modo voz manos-libres (VoiceMode) te transcribe con el navegador y manda
 * aquí lo que dijiste. Esto corre un turno REAL de Cortex: su system prompt
 * (con memorias y hechos de la empresa), sus herramientas, su modelo — igual
 * que el chat de texto, pero devolviendo una respuesta corta pensada para
 * DECIRSE, no para leerse. Así «¿cuánto le cotizamos a Acme?» mira el CRM, no
 * solo lo que acabas de decir.
 *
 * NO es el endpoint del bot de reuniones (voice-answer): aquel habla por el
 * token de servicio, dentro de un Meet, y no sabe quién preguntó. Este corre
 * con TU sesión — eres tú hablándole a Cortex en tu propia app — así que
 * `audience: 'private'` (puede usar tus notas privadas, no hay nadie más
 * oyendo) y las tools actúan como tú.
 *
 * ===========================================================================
 * MODO VOZ = AUTO-AUTORIZA. LO MISMO QUE EN REUNIONES, Y POR LO MISMO.
 * ===========================================================================
 * Hablando no hay tarjeta que tocar: una tool que pidiera confirmación dejaría
 * el turno mudo esperando a nadie. Así que las confirmaciones se AUTO-AUTORIZAN
 * (`confirmed: true`). Lo que NO se afloja: la capa de SEGURIDAD sigue
 * bloqueando lo que clasifica como `block` (un `block` sigue siendo un
 * `block`), la voz es premium, y todo lo ejecutado queda en la auditoría. Si
 * algo se bloquea, Cortex lo dice de viva voz en vez de actuar.
 *
 * ===========================================================================
 * CONTINUIDAD SIN PERSISTIR UN HILO
 * ===========================================================================
 * El cliente manda un `history` corto (los últimos intercambios de ESTA sesión
 * de voz) para que «y eso mándaselo a Ana» sepa qué es «eso». No se escribe en
 * el hilo del chat de texto: una conversación hablada es su propia cosa, y
 * mezclarla con el hilo escrito ensuciaría ambos. Si de la charla sale algo que
 * merezca quedar, Cortex ya lo habrá hecho con una tool (que sí se audita).
 */

const Body = z.object({
  question: z.string().min(1).max(1_000),
  history: z
    .array(z.object({ role: z.enum(['you', 'cortex']), text: z.string().max(2_000) }))
    .max(20)
    .optional(),
});

type UUID = `${string}-${string}-${string}-${string}-${string}`;

/**
 * Igual que en el bot de reuniones: familias que no tienen sentido dichas de
 * viva voz. Todo lo demás entra, y la capa de seguridad sigue mandando.
 *   - browser/screen: superficies visuales, no de voz.
 *   - security/admin: administrar la seguridad no se hace hablando.
 */
const VOICE_FAMILIES_BLOCKED = new Set(['browser', 'screen', 'security', 'admin']);

/**
 * El modo voz es premium, como en reuniones. Reutiliza la misma lista de planes
 * (VOICE_PLANS, con MEET_VOICE_PLANS de respaldo para no duplicar config), así
 * que un workspace que ya tiene voz en reuniones la tiene también aquí.
 */
const VOICE_PLANS = new Set(
  (process.env.VOICE_PLANS || process.env.MEET_VOICE_PLANS || 'business,enterprise').split(','),
);

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'No entendí la pregunta.' }, { status: 400 });
  }
  const { question, history } = parsed.data;

  const orgId = user.organization.id;
  const db = getOrgScopedClient(orgId);

  // El muro premium, y del lado servidor: no se salta ocultando o mostrando un
  // botón. Sin plan de voz, 402 y el modo se cierra con un mensaje claro.
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
    // 1:1 con la persona de la sesión, nadie más oye: puede usar sus notas.
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
          // MODO VOZ: auto-autoriza. La capa de seguridad sigue bloqueando.
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

  try {
    const { text } = await generateText({
      model: chatModel(),
      system,
      prompt: `TE DIJO LA PERSONA: ${question}`,
      tools: aiTools,
      maxSteps: 6,
    });
    return NextResponse.json({ answer: text.trim() || 'No estoy seguro de eso.' });
  } catch {
    return NextResponse.json({ error: 'No pude pensar la respuesta.' }, { status: 500 });
  }
}
