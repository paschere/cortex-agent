import 'server-only';
import { buildToolContext } from '@/lib/agent';
import { sendApprovalRequestEmail } from '@/lib/approval-email';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { buildCompanyFactsBlock } from '@/lib/system-prompt';
import { createToolCallRepair } from '@/lib/tool-call-repair';
import {
  type AskCortexArgs,
  type WaitInfo,
  WaitingForPersonError,
  askRules,
  buildAskUserPrompt,
  chatModel,
  classify,
  enabledModules,
  filterTools,
  getTrackerBySlug,
  latestResolvedWait,
  resumedPromptBlock,
  runTool,
  toolAllowedByModules,
  toolErrorMessage,
  upsertRow,
  waitFromRunFlow,
  writableFields,
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
const MAX_STEPS = 10;

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

/**
 * El permiso de escritura de la instrucción (`ask_cortex.writes`): la fila de
 * contexto y los campos que puede cambiar SIN aprobación. `null` = el permiso de
 * siempre (la tabla de la regla).
 */
export interface RowWriteScope {
  rowId: string;
  fields: ReadonlySet<string>;
}

export function decideAutomationCall(
  toolDef: { id: string; requiresConfirmation?: boolean },
  input: unknown,
  ownTracker: string | null,
  scope: RowWriteScope | null = null,
  /** Herramientas externas que la regla declaró (`ask_cortex.allow`): corren sin aprobación. */
  declared: ReadonlySet<string> = new Set(),
): 'run' | 'declared' | 'row_write' | 'stage' | 'forbidden' {
  if (FORBIDDEN.test(toolDef.id)) return 'forbidden';
  // Consultar un portal con un trámite aprendido: browser.run_flow sólo corre
  // trámites de lectura (los que escriben los rechaza) y sólo los que un
  // administrador habilitó para trabajos desatendidos (`errandAllowed`). Si el
  // portal pide una persona, la corrida espera (waits.ts) en vez de pedir aprobación.
  if (toolDef.id === 'browser.run_flow') return 'run';
  if (declared.has(toolDef.id)) return 'declared';
  if (scope && toolDef.id === 'trackers.upsert') {
    const i = input as {
      tracker?: string;
      rowId?: string;
      values?: Record<string, unknown>;
    } | null;
    const keys = Object.keys(i?.values ?? {});
    // Sólo ESA fila y sólo los campos declarados; todo lo demás pide aprobación.
    return i?.tracker === ownTracker &&
      i?.rowId === scope.rowId &&
      keys.length > 0 &&
      keys.every((k) => scope.fields.has(k))
      ? 'row_write'
      : 'stage';
  }
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
  const waited: { info: WaitInfo | null } = { info: null };
  const stop = new AbortController();
  const applied: string[] = [];
  const trackerRow = args.tracker ? await getTrackerBySlug(orgDb, args.tracker.slug) : null;
  const writable = writableFields(args.writes, args.fields ?? []);
  const scope: RowWriteScope | null =
    args.rowId && args.tracker && writable !== 'legacy'
      ? { rowId: args.rowId, fields: writable }
      : null;
  const declared = new Set(args.allow ?? []);
  const aiTools: Record<string, CoreTool> = Object.fromEntries(
    allowed.map((t) => [
      t.id.replaceAll('.', '_'),
      tool({
        description: t.description,
        parameters: t.inputSchema,
        execute: async (input, { abortSignal }) => {
          const verdict = decideAutomationCall(
            t,
            input,
            args.tracker?.slug ?? null,
            scope,
            declared,
          );
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
            if (verdict === 'row_write' && scope && trackerRow) {
              const wanted = (input as { values: Record<string, string | number | boolean> })
                .values;
              const { data: current, error: readError } = await ctx.db
                .from('tracker_rows')
                .select('id, values')
                .eq('id', scope.rowId)
                .eq('tracker_id', trackerRow.id)
                .maybeSingle();
              if (readError || !current)
                return {
                  __error: true,
                  tool: t.id,
                  message: 'La fila ya no existe.',
                } as unknown as never;
              const before = (current as { values: Record<string, string | number> }).values;
              const saved = await upsertRow(ctx.db, {
                tracker: trackerRow,
                rowId: scope.rowId,
                values: { ...before, ...wanted },
                userId: args.requesterId,
                only: new Set(Object.keys(wanted)),
              });
              for (const k of Object.keys(wanted))
                if (String(before[k] ?? '') !== String(saved.values[k] ?? ''))
                  applied.push(
                    `${k}: «${String(before[k] ?? '')}» → «${String(saved.values[k] ?? '')}»`,
                  );
              return { ok: true, row: { id: saved.id, values: saved.values } } as unknown as never;
            }
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
            // Una herramienta declarada en la regla (`allow`) corre sin aprobación: quien
            // escribió la regla la soltó a conciencia. La política de seguridad, los
            // topes y las reglas de la empresa se aplican igual dentro de `runTool`.
            const out = await runTool(
              t,
              input,
              { ...ctx, signal: abortSignal },
              { confirmed: verdict === 'declared' },
            );
            // El portal pidió una persona (código, captcha, sesión vencida): se
            // corta aquí, la corrida queda esperando y se retoma al resolverse.
            if (t.id === 'browser.run_flow') {
              const info = await waitFromRunFlow(ctx.db, out);
              if (info) {
                waited.info = info;
                stop.abort();
                return {
                  __waiting: true,
                  tool: t.id,
                  message: 'El trámite quedó esperando a una persona. Termina.',
                } as unknown as never;
              }
            }
            return out;
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
${askRules(args.app.name, args.tracker?.slug ?? null)}`;
  const today = new Date(Date.now() - 5 * 3_600_000).toISOString().slice(0, 10);

  // Si la acción ya esperó a una persona y se resolvió, el modelo recibe lo que
  // devolvió el trámite y NO lo vuelve a correr (idempotente con la corrida).
  const resumed =
    args.actionIndex !== undefined
      ? resumedPromptBlock(await latestResolvedWait(orgDb, args.run.id, args.actionIndex))
      : null;
  const userPrompt = buildAskUserPrompt({
    instruction: args.instruction,
    ctx: args.templateContext ?? { after: args.rowValues ?? {} },
    trackerSlug: args.tracker?.slug ?? null,
    rowId: args.rowId,
    fields: args.fields ?? [],
    writes: args.writes,
    allow: args.allow,
    today,
  });

  let result: Awaited<ReturnType<typeof generateText>>;
  try {
    result = await generateText({
      abortSignal: stop.signal,
      model: chatModel(agent.default_model as string),
      system,
      messages: [
        {
          role: 'user',
          content: resumed ? `${userPrompt}\n\n${resumed}` : userPrompt,
        },
      ],
      tools: aiTools,
      toolChoice: 'auto',
      maxSteps: MAX_STEPS,
      experimental_repairToolCall: createToolCallRepair({ surface: 'routine' }),
    });
  } catch (err) {
    // El trámite pidió una persona: la corrida queda esperando (engine: run.ts).
    if (waited.info) throw new WaitingForPersonError(waited.info);
    throw err;
  }
  if (waited.info) throw new WaitingForPersonError(waited.info);
  const text = result.text.trim();
  // Lo que de verdad cambió va primero y lo cuenta el código, no el modelo: el
  // historial de la corrida no depende de que el informe sea fiel.
  const changes = applied.length ? `Cambios: ${applied.join('; ')}. ` : '';
  return { summary: `${changes}${text || 'Cortex no dejó informe.'}`.slice(0, 1500), staged };
}
