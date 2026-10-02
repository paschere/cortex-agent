import 'server-only';
import { buildToolContext } from '@/lib/agent';
import { sendEmail } from '@/lib/email';
import { renderAutopilotReportEmail } from '@/lib/email-templates/autopilot-report';
import { defaultAgentId } from '@/lib/guided-setup/apply';
import { notify } from '@/lib/notifications/notify';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import {
  type AutopilotItemRow,
  type AutopilotSettings,
  type DecidedItem,
  type ExecOutcome,
  type RunDeps,
  type RunSummary,
  claimAutopilotItem,
  claimAutopilotRun,
  finishAutopilotRun,
  getAutopilotItem,
  getTool,
  isCompanyManager,
  itemFromRow,
  listAutopilotItems,
  markRunNotified,
  outcomeFromError,
  planToday,
  planningDeps,
  proposeAction,
  runTool,
  saveAutopilotItems,
  updateAutopilotItem,
} from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * EL PILOTO AUTOMÁTICO EN LA APP: enchufa las piezas de verdad (la base de la
 * empresa, `runTool`, la cola de aprobaciones, la campana y el correo) a la
 * orquestación pura de packages/agent-tools/src/autopilot/run.ts.
 *
 * Todo con el handle de la empresa (getOrgScopedClient). Las herramientas
 * corren como QUIEN ENCENDIÓ EL PILOTO (`actor_user_id`), con la superficie
 * `schedule`: la misma puerta de seguridad y los mismos mandatos que una
 * rutina. Lo rutinario pasa como confirmado porque el dueño lo encendió con el
 * área en «hacer» (igual que `allow_unattended_writes` de una rutina); lo que
 * se hace bajo un mandato NO pasa como confirmado: es el mandato quien levanta
 * la pregunta, y queda anotado en `mandate_uses`.
 */

/** El resultado de una herramienta, en una frase para la línea de tiempo. */
function summaryOf(result: unknown): string {
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.markdown === 'string' && r.markdown.trim()) return r.markdown.trim().slice(0, 900);
    if (typeof r.message === 'string' && r.message.trim()) return r.message.trim().slice(0, 900);
  }
  return 'Hecho.';
}

function verificationOf(result: unknown): {
  verification: 'verified' | 'not_verified' | 'unverifiable' | null;
  detail: string | null;
} {
  const v = (result as { _verification?: { status?: string; notice?: string } } | null)
    ?._verification;
  if (v?.status === 'verified' || v?.status === 'not_verified' || v?.status === 'unverifiable')
    return { verification: v.status, detail: v.notice ?? null };
  return { verification: null, detail: null };
}

/** Ejecuta una cosa del piloto como el actor, por `runTool`. Nunca lanza. */
async function executeAs(
  organizationId: string,
  actor: { userId: string; agentId: string },
  item: DecidedItem,
  opts: { idempotencyScope: string; surface: 'schedule' | 'web'; confirmed: boolean },
): Promise<ExecOutcome> {
  const action = item.proposedAction;
  if (!action) return { status: 'failed', error: 'No había nada que ejecutar.' };
  const tool = getTool(action.toolId);
  if (!tool) return { status: 'failed', error: `La herramienta ${action.toolId} ya no existe.` };
  const ctx = buildToolContext({
    organizationId,
    userId: actor.userId as UUID,
    agentId: actor.agentId as UUID,
    surface: opts.surface,
  });
  ctx.idempotencyScope = opts.idempotencyScope;
  try {
    const denied = await deniedToolPatterns(ctx.db, actor.userId, { failClosed: true });
    if (isToolDenied(action.toolId, denied))
      return {
        status: 'failed',
        error: 'Quien actúa por el piloto ya no tiene acceso a esa herramienta, así que no la usé.',
      };
    const result = await runTool(tool, action.input, ctx, { confirmed: opts.confirmed });
    const v = verificationOf(result);
    return {
      status: 'done',
      summary: summaryOf(result),
      verification: v.verification,
      verificationDetail: v.detail,
    };
  } catch (err) {
    return outcomeFromError(err);
  }
}

async function ownerNotice(
  db: SupabaseClient,
  settings: AutopilotSettings,
  summary: RunSummary,
): Promise<void> {
  const waiting = summary.asked + summary.stillWaiting;
  await notify(db, {
    userId: summary.actorUserId,
    kind: 'management_attention',
    tone: waiting > 0 ? 'warning' : summary.failed > 0 ? 'bad' : 'good',
    title: `Piloto automático: ${summary.message}`.slice(0, 160),
    body: [
      summary.highlights.asked.length
        ? `Por decidir: ${summary.highlights.asked.join(' · ')}.`
        : null,
      summary.highlights.done.length ? `Hice: ${summary.highlights.done.join(' · ')}.` : null,
    ]
      .filter(Boolean)
      .join(' ')
      .slice(0, 600),
    href: `/piloto/${summary.runId}`,
    dedupeKey: `autopilot:run:${summary.runId}`,
  });
  if (settings.notifyEmail) {
    const { data, error } = await db
      .from('users')
      .select('email')
      .eq('id', summary.actorUserId)
      .maybeSingle();
    if (error) throw error;
    const to = (data as { email?: string } | null)?.email;
    if (to?.includes('@')) {
      const mail = renderAutopilotReportEmail({
        runId: summary.runId,
        day: summary.day,
        message: summary.message,
        done: summary.done,
        asked: summary.asked,
        failed: summary.failed,
        stillWaiting: summary.stillWaiting,
        doneTitles: summary.highlights.done,
        askedTitles: summary.highlights.asked,
      });
      const sent = await sendEmail({ to, subject: mail.subject, text: mail.text, html: mail.html });
      if (!sent.sent)
        logger.warn({ reason: sent.reason }, 'autopilot: el correo al dueño no salió');
    }
  }
  await markRunNotified(db, summary.runId);
}

/** Las dependencias de la corrida de verdad de una empresa, un día. */
export async function autopilotRunDeps(
  organizationId: string,
  day: string,
): Promise<RunDeps | null> {
  const db = getOrgScopedClient(organizationId);
  const agentId = await defaultAgentId(db);
  if (!agentId) return null;
  const planning = planningDeps(db, { day });
  let settingsForNotice: AutopilotSettings | null = null;
  return {
    ...planning,
    day,
    readSettings: async () => {
      const s = await planning.readSettings();
      settingsForNotice = s;
      return s;
    },
    actorAllowed: (userId) => isCompanyManager(db, userId),
    claimRun: (input) => claimAutopilotRun(db, input),
    saveItems: (runId, items) => saveAutopilotItems(db, runId, items),
    loadItems: async (runId) =>
      (await listAutopilotItems(db, runId))
        // Lo que una persona ya decidió desde /piloto no lo vuelve a tocar la
        // corrida, aunque esté en vuelo.
        .filter((r) => !r.decided_by)
        .map((r) => ({
          id: r.id,
          dedupeKey: r.dedupe_key,
          status: r.status,
          item: itemFromRow(r),
        })),
    updateItem: (itemId, patch) => updateAutopilotItem(db, itemId, patch),
    execute: async (item, { idempotencyScope }) => {
      const actor = settingsForNotice?.actorUserId;
      if (!actor) return { status: 'failed', error: 'No hay en nombre de quién actuar.' };
      return executeAs(organizationId, { userId: actor, agentId }, item, {
        idempotencyScope,
        surface: 'schedule',
        // Lo rutinario: el dueño lo encendió. Bajo mandato: que lo levante el mandato.
        confirmed: item.authority === 'routine',
      });
    },
    proposeMessage: async (item) => {
      const actor = settingsForNotice?.actorUserId;
      const input = item.proposedAction?.input as
        | { to?: string[]; cc?: string[]; subject?: string; body?: string }
        | undefined;
      if (!actor || item.proposedAction?.toolId !== 'gmail.send_message' || !input?.to?.length)
        return null;
      const outcome = await proposeAction(db, {
        userId: actor,
        agentId,
        kind: 'collect_payment',
        toolId: 'gmail.send_message',
        payload: {
          to: input.to,
          cc: input.cc,
          subject: input.subject ?? item.title,
          body: input.body ?? '',
        },
        originKind: 'manual',
        // No es un id de proceso de Gerencia (no es un uuid): ver
        // management/workflow.ts › assertCollectionActionCurrent.
        originId: `autopilot:${item.dedupeKey}`.slice(0, 200),
        rationale: item.why,
      });
      return outcome.action.id;
    },
    finishRun: (runId, summary, status) => finishAutopilotRun(db, runId, summary, status),
    notifyOwner: async (summary) => {
      if (!settingsForNotice) return;
      await ownerNotice(db, settingsForNotice, summary);
    },
  };
}

/** «Probar sin hacer nada»: el plan de hoy, sin escribir ni ejecutar. */
export async function autopilotDryRun(organizationId: string, day: string) {
  const db = getOrgScopedClient(organizationId);
  const deps = planningDeps(db, { day });
  const settings = await deps.readSettings();
  const plan = await planToday(deps, { settings });
  return { settings, plan };
}

export type DecideItemResult =
  | { ok: true; status: 'done' | 'dismissed' | 'failed' | 'asked'; message: string }
  | { ok: false; message: string };

/**
 * Aprobar o descartar UNA cosa que esperaba decisión, desde /piloto.
 *
 * El reclamo es un update condicional con la huella de lo que la persona vio
 * (store.ts › claimAutopilotItem); se ejecuta como QUIEN APRUEBA, con la
 * superficie web y confirmado — la misma forma que una aprobación de siempre
 * (lib/approvals/decide.ts). Los correos a clientes NO se aprueban aquí: van a
 * la cola de aprobaciones (`actions`), con su propia huella.
 */
export async function decideAutopilotItem(input: {
  organizationId: string;
  userId: string;
  itemId: string;
  decision: 'approve' | 'dismiss';
  contentHash: string;
}): Promise<DecideItemResult> {
  const db = getOrgScopedClient(input.organizationId);
  if (!(await isCompanyManager(db, input.userId)))
    return { ok: false, message: 'Sólo un administrador o el dueño decide lo del piloto.' };
  const before = await getAutopilotItem(db, input.itemId);
  if (before?.action_id && input.decision === 'approve')
    return {
      ok: false,
      message: 'Este correo se aprueba en Aprobaciones, donde ves el texto exacto.',
    };
  const claim = await claimAutopilotItem(db, input);
  if (claim.status === 'unknown') return { ok: false, message: 'Esa cosa ya no existe.' };
  if (claim.status === 'already_decided')
    return { ok: false, message: 'Alguien ya la decidió. Actualiza la página.' };
  if (claim.status === 'content_changed')
    return {
      ok: false,
      message: 'Cambió desde que la viste. Actualiza la página y vuelve a mirarla.',
    };
  const row: AutopilotItemRow = claim.item;
  if (input.decision === 'dismiss')
    return {
      ok: true,
      status: 'dismissed',
      message: 'Descartado. No te lo vuelvo a proponer esta semana.',
    };

  const agentId = await defaultAgentId(db);
  if (!agentId) {
    await updateAutopilotItem(db, row.id, { status: 'asked' });
    return { ok: false, message: 'Este espacio no tiene un agente configurado.' };
  }
  const outcome = await executeAs(
    input.organizationId,
    { userId: input.userId, agentId },
    itemFromRow(row),
    { idempotencyScope: `autopilot:aprobado:${row.id}`, surface: 'web', confirmed: true },
  );
  const at = new Date().toISOString();
  if (outcome.status === 'done') {
    await updateAutopilotItem(db, row.id, {
      status: 'done',
      resultSummary: outcome.summary,
      verification: outcome.verification,
      verificationDetail: outcome.verificationDetail ?? null,
      executedAt: at,
    });
    return { ok: true, status: 'done', message: outcome.summary };
  }
  if (outcome.status === 'asked') {
    await updateAutopilotItem(db, row.id, { status: 'asked', decisionReason: outcome.reason });
    return { ok: false, message: outcome.reason };
  }
  await updateAutopilotItem(db, row.id, { status: 'failed', error: outcome.error, executedAt: at });
  return { ok: true, status: 'failed', message: outcome.error };
}
