import 'server-only';
import { buildToolContext } from '@/lib/agent';
import { sendApprovalRequestEmail } from '@/lib/approval-email';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildCompanyFactsBlock } from '@/lib/system-prompt';
import { createToolCallRepair } from '@/lib/tool-call-repair';
import {
  type AskCortexArgs,
  chatModel,
  classify,
  enabledModules,
  filterTools,
  runTool,
  toolAllowedByModules,
  toolErrorMessage,
} from '@cortex/agent-tools';
import { ConfirmationRequiredError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type CoreTool, generateText, tool } from 'ai';

/**
 * LA ACCIÓN «PEDIRLE ALGO A CORTEX» de una automatización (0210).
 *
 * Cortex corre SIN nadie delante, como una rutina (`surface: 'schedule'`: las
 * reglas de seguridad de la superficie desatendida aplican, incluidas las reglas
 * CEL de la empresa y los mandatos). Lo que se le deja hacer SOLO:
 *
 *   - leer (cualquier herramienta que la política clasifica como lectura);
 *   - escribir filas en LA TABLA de la regla (`trackers.upsert` sobre esa tabla).
 *
 * Todo lo demás —un correo, una fila en otra tabla, un cambio de rol, cualquier
 * escritura— NO se ejecuta: se deja como aprobación pendiente (`mcp_pending_actions`,
 * origen `schedule`) para quien creó la regla, con su correo de aviso, y sólo
 * corre cuando esa persona la aprueba en Cortex. Eso es independiente de lo que
 * la herramienta declare: aunque `requiresConfirmation` sea falso, escribir
 * fuera de la tabla pide aprobación. Y lo que SÍ declara `requiresConfirmation`
 * o la política marca como `confirm` sigue parándose en `runTool`, que es la
 * puerta de todas las llamadas.
 *
 * Tampoco se ofrecen las herramientas que cambian automatizaciones, apps o
 * permisos: una regla no se reescribe a sí misma.
 */

const APPROVAL_TTL_MS = 24 * 60 * 60_000;
const MAX_STEPS = 8;

/** Herramientas que una regla no usa jamás: tocar reglas, apps y accesos. */
const FORBIDDEN = /^(apps\.|security\.|mandates\.|billing\.|org\.)/;

/**
 * ¿El nombre de la herramienta suena a escribir? La política de riesgo
 * (`classify`) deja pasar como «lectura» verbos que escriben (p. ej. `upsert`),
 * y aquí NO se confía en eso: ante la duda, aprobación. Es una red más ancha que
 * la política a propósito; una lectura rara que caiga aquí sólo pide un clic.
 */
const WRITE_ACTION =
  /^(add|append|apply|approve|archive|assign|book|cancel|clear|close|connect|create|decide|define|delete|disable|dismiss|draft|edit|enable|enroll|export|fire|grant|import|invite|issue|link|log|mark|merge|move|open|pause|pay|post|publish|put|record|register|reject|remove|rename|reopen|reply|request|reset|restore|resume|revoke|run|save|schedule|send|set|share|snooze|start|stop|submit|sync|transfer|trigger|unlink|update|upsert|upload|write)(_|$)/;

export function looksLikeWrite(toolId: string): boolean {
  const action = toolId.slice(toolId.indexOf('.') + 1).replaceAll('.', '_');
  return WRITE_ACTION.test(action);
}

export function decideAutomationCall(
  toolDef: { id: string; requiresConfirmation?: boolean },
  input: unknown,
  ownTracker: string | null,
): 'run' | 'stage' | 'forbidden' {
  if (FORBIDDEN.test(toolDef.id)) return 'forbidden';
  if (
    toolDef.id === 'trackers.upsert' &&
    ownTracker &&
    (input as { tracker?: string } | null)?.tracker === ownTracker
  )
    return 'run';
  const { blastRadius } = classify({ tool: toolDef, input, surface: 'schedule' });
  return blastRadius === 'read' && !toolDef.requiresConfirmation && !looksLikeWrite(toolDef.id)
    ? 'run'
    : 'stage';
}

export async function askCortexForAutomation(
  _db: SupabaseClient,
  args: AskCortexArgs,
): Promise<{ summary: string; staged: number }> {
  if (!args.requesterId)
    throw new Error('La regla no tiene a quién pedirle las aprobaciones (su creador ya no está).');
  const orgDb = getOrgScopedClient(args.organizationId);
  const { data: agent, error } = await orgDb
    .from('agents')
    .select('id, system_prompt, default_model, allowed_tool_ids')
    .eq('slug', 'cortex')
    .eq('archived', false)
    .maybeSingle();
  if (error || !agent) throw new Error('No encuentro al agente de la empresa.');

  const ctx = buildToolContext({
    organizationId: args.organizationId,
    userId: args.requesterId,
    agentId: agent.id as string,
    surface: 'schedule',
  });
  // Una ejecución = una huella de idempotencia: un reintento no repite acciones seguras.
  ctx.idempotencyScope = `appauto:${args.run.id}`;
  const modulesOn = await enabledModules(ctx.db);
  const allowed = filterTools((agent.allowed_tool_ids as string[]) ?? []).filter(
    (t) => !FORBIDDEN.test(t.id) && toolAllowedByModules(t.id, modulesOn),
  );

  let staged = 0;
  const aiTools: Record<string, CoreTool> = Object.fromEntries(
    allowed.map((t) => [
      t.id.replaceAll('.', '_'),
      tool({
        description: t.description,
        parameters: t.inputSchema,
        execute: async (input, { abortSignal }) => {
          const verdict = decideAutomationCall(t, input, args.tracker?.slug ?? null);
          if (verdict === 'forbidden')
            return {
              __error: true,
              tool: t.id,
              message: 'Esta herramienta no se usa en automatizaciones.',
            } as unknown as never;
          const stage = async (validated: unknown) => {
            const expiresAt = new Date(Date.now() + APPROVAL_TTL_MS);
            const { data: pending, error: stageError } = await ctx.db
              .from('mcp_pending_actions')
              .insert({
                user_id: args.requesterId,
                agent_id: agent.id,
                tool_id: t.id,
                input: validated,
                expires_at: expiresAt.toISOString(),
                staged_via: 'schedule',
              })
              .select('id')
              .single();
            if (stageError || !pending)
              return {
                __error: true,
                tool: t.id,
                message: 'No se pudo dejar pendiente de aprobación.',
              } as unknown as never;
            staged += 1;
            void sendApprovalRequestEmail({
              organizationId: args.organizationId,
              userId: args.requesterId as string,
              toolId: t.id,
              input: validated,
              surface: 'schedule',
              pendingActionId: (pending as { id: string }).id,
              expiresAt,
            });
            return {
              __staged: true,
              tool: t.id,
              message:
                'No se ejecutó: quedó pendiente de aprobación de quien creó la automatización.',
            } as unknown as never;
          };
          try {
            if (verdict === 'stage') {
              const parsed = t.inputSchema.safeParse(input);
              if (!parsed.success)
                return {
                  __error: true,
                  tool: t.id,
                  message: 'Los datos de la herramienta no son válidos.',
                } as unknown as never;
              return await stage(parsed.data);
            }
            return await runTool(t, input, { ...ctx, signal: abortSignal }, { confirmed: false });
          } catch (err) {
            if (err instanceof ConfirmationRequiredError)
              return await stage((err as { input?: unknown }).input ?? input);
            logger.warn({ err, tool: t.id }, 'automation ask_cortex tool failed');
            return {
              __error: true,
              tool: t.id,
              message: toolErrorMessage(err),
            } as unknown as never;
          }
        },
      }),
    ]),
  );

  const companyBlock = await buildCompanyFactsBlock(args.organizationId);
  const system = `${agent.system_prompt as string}${companyBlock ? `\n\n${companyBlock}` : ''}

---
UNA AUTOMATIZACIÓN de la aplicación «${args.app.name}» te pide algo, sin nadie delante:
- No hagas preguntas ni esperes respuesta: nadie contestará.
- Puedes leer y escribir en la tabla «${args.tracker?.slug ?? 'ninguna'}». Cualquier otra escritura (correo, otras tablas, cambios) NO se ejecuta: queda pendiente de aprobación y una persona la aprueba después; si una herramienta devuelve __staged, dilo en tu informe y sigue.
- Termina con un informe breve de lo que hiciste y lo que quedó pendiente.`;

  const result = await generateText({
    model: chatModel(agent.default_model as string),
    system,
    messages: [
      {
        role: 'user',
        content: `${args.instruction}${args.rowId ? `\n\n(Fila de contexto: ${args.rowId} de la tabla ${args.tracker?.slug}.)` : ''}`,
      },
    ],
    tools: aiTools,
    toolChoice: 'auto',
    maxSteps: MAX_STEPS,
    experimental_repairToolCall: createToolCallRepair({ surface: 'routine' }),
  });
  const text = result.text.trim();
  return { summary: (text || 'Cortex no dejó informe.').slice(0, 400), staged };
}
