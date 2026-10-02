import { ConfirmationRequiredError, SecurityBlockedError } from '@cortex/core';
import type { MandateGrant } from '../security/mandate';
import { toolErrorMessage } from '../tool-error';
import type { AutopilotSnapshot } from './collectors';
import { type PlanHistory, buildPlan, toolIdsOf } from './plan';
import type { PolicyContext, ToolFacts } from './policy';
import { type AutopilotSettings, GATE_REASON_TEXT, runGate } from './settings';
import type {
  AutopilotItemStatus,
  AutopilotPlan,
  AutopilotRunStatus,
  AutopilotVerification,
  DecidedItem,
} from './types';

/**
 * LA CORRIDA DE UNA EMPRESA, ORQUESTADA SIN SABER DE BASES NI DE REDES.
 *
 * Todo lo que toca el mundo llega en `RunDeps`: leer la configuración, armar la
 * fotografía, guardar, ejecutar una herramienta, proponer un correo, avisar al
 * dueño. Así la parte que decide el ORDEN y las GARANTÍAS se prueba con dobles
 * en Node (run.test.ts), y la de verdad (apps/web/inngest/functions/autopilot.ts)
 * sólo enchufa las piezas.
 *
 * ===========================================================================
 * LAS GARANTÍAS
 * ===========================================================================
 *   · UNA corrida por empresa y por día. `claimRun` la reclama con el índice
 *     único (organización, día); un reintento del trabajo retoma la misma
 *     corrida y ejecuta sólo lo que quedó en cola.
 *   · Cada acción se ejecuta con `idempotencyScope = autopilot:<día>:<clave>`
 *     (capa de acciones seguras, 0168): la misma cosa el mismo día no se hace
 *     dos veces aunque el trabajo se repita.
 *   · EL INTERRUPTOR: antes de cada acción se relee la configuración. Apagarlo
 *     detiene lo que falta en ese instante; lo pendiente queda «omitido».
 *   · Un fallo no bloquea a los demás: cada acción va en su propio try.
 *   · Topes: los de la política (acciones, mensajes, plata) y un techo de
 *     tiempo por corrida; lo que no alcanza queda «omitido», con la razón.
 *   · UN mensaje al dueño, al final, con la cuenta: «Hoy hice 6 cosas;
 *     necesito tu decisión en 3».
 */

export type ExecOutcome =
  | {
      status: 'done';
      summary: string;
      verification: AutopilotVerification;
      verificationDetail?: string | null;
    }
  | { status: 'asked'; reason: string }
  | { status: 'failed'; error: string };

export interface ItemPatch {
  status: AutopilotItemStatus;
  resultSummary?: string | null;
  verification?: AutopilotVerification;
  verificationDetail?: string | null;
  error?: string | null;
  actionId?: string | null;
  executedAt?: string | null;
  decisionReason?: string;
}

export interface SavedItem {
  id: string;
  dedupeKey: string;
  status: AutopilotItemStatus;
}

export interface RunSummary {
  runId: string;
  day: string;
  actorUserId: string;
  done: number;
  asked: number;
  told: number;
  failed: number;
  skipped: number;
  stillWaiting: number;
  stopped: boolean;
  /** Las primeras cosas de cada clase, para el mensaje. */
  highlights: { done: string[]; asked: string[] };
  message: string;
  /** Fuentes que no se pudieron leer: la corrida lo dice, no lo esconde. */
  sourceErrors: Array<{ source: string; message: string }>;
}

export interface RunDeps {
  day: string;
  now: () => Date;
  readSettings: () => Promise<AutopilotSettings>;
  /** ¿Puede este usuario seguir siendo en nombre de quien actúa el piloto? */
  actorAllowed: (userId: string) => Promise<boolean>;
  loadSnapshot: () => Promise<{
    snapshot: AutopilotSnapshot;
    errors: AutopilotPlan['sourceErrors'];
  }>;
  loadHistory: () => Promise<PlanHistory>;
  loadMandates: (toolIds: string[]) => Promise<MandateGrant[]>;
  tool: (id: string) => ToolFacts | undefined;
  claimRun: (input: { day: string; actorUserId: string }) => Promise<{
    runId: string;
    fresh: boolean;
    status: AutopilotRunStatus;
  }>;
  /** Guarda el plan de la corrida. Devuelve todas las filas de la corrida. */
  saveItems: (runId: string, items: DecidedItem[]) => Promise<SavedItem[]>;
  /** En un reintento: las filas que ya había. */
  loadItems: (runId: string) => Promise<Array<SavedItem & { item: DecidedItem }>>;
  updateItem: (itemId: string, patch: ItemPatch) => Promise<void>;
  execute: (item: DecidedItem, ctx: { idempotencyScope: string }) => Promise<ExecOutcome>;
  /**
   * Para lo que sale de la empresa y espera decisión: la propuesta en la cola de
   * aprobaciones de siempre (`actions`), aprobable con un clic. Devuelve su id.
   */
  proposeMessage: (item: DecidedItem) => Promise<string | null>;
  finishRun: (runId: string, summary: RunSummary, status: AutopilotRunStatus) => Promise<void>;
  notifyOwner: (summary: RunSummary) => Promise<void>;
  /** Techo de tiempo de la corrida. Por defecto, 8 minutos. */
  timeBudgetMs?: number;
}

export type RunResult =
  | { ran: false; reason: string }
  | { ran: true; summary: RunSummary; plan: AutopilotPlan | null };

const DEFAULT_TIME_BUDGET_MS = 8 * 60_000;

/** El alcance de idempotencia de una acción del piloto: el día y la cosa. */
export function idempotencyScopeFor(day: string, dedupeKey: string): string {
  return `autopilot:${day}:${dedupeKey}`.slice(0, 300);
}

/** De lo que lanzó `runTool` a lo que se anota. Nunca lanza. */
export function outcomeFromError(err: unknown): ExecOutcome {
  if (err instanceof ConfirmationRequiredError)
    return {
      status: 'asked',
      reason:
        'La capa de seguridad pidió que una persona lo confirme, así que te lo dejo para que decidas.',
    };
  if (err instanceof SecurityBlockedError)
    return {
      status: 'failed',
      error: `La capa de seguridad no lo deja hacer sin nadie mirando: ${err.message}`,
    };
  return { status: 'failed', error: toolErrorMessage(err) };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** «Hoy hice 6 cosas; necesito tu decisión en 3.» Escrita por reglas. */
export function ownerMessage(s: {
  done: number;
  asked: number;
  failed: number;
  stillWaiting: number;
  stopped?: boolean;
}): string {
  const did =
    s.done > 0 ? `Hoy hice ${plural(s.done, 'cosa', 'cosas')}` : 'Hoy no hice nada por mi cuenta';
  const waiting = s.asked + s.stillWaiting;
  const ask =
    waiting > 0 ? `necesito tu decisión en ${waiting}` : 'no necesito ninguna decisión tuya';
  const extra = [
    s.failed > 0 ? `${plural(s.failed, 'no salió', 'no salieron')}` : null,
    s.stopped ? 'me detuve porque apagaste el piloto' : null,
  ].filter(Boolean);
  return `${did}; ${ask}.${extra.length ? ` (${extra.join('; ')}.)` : ''}`;
}

/** El plan sin ejecutar nada: lo que usa «Probar sin hacer nada». */
export async function planToday(
  deps: Pick<
    RunDeps,
    'loadSnapshot' | 'loadHistory' | 'loadMandates' | 'tool' | 'now' | 'readSettings'
  >,
  overrides: { settings?: AutopilotSettings } = {},
): Promise<AutopilotPlan & { stillWaiting: number }> {
  const now = deps.now();
  const settings = overrides.settings ?? (await deps.readSettings());
  const [{ snapshot, errors }, history] = await Promise.all([
    deps.loadSnapshot(),
    deps.loadHistory(),
  ]);
  const mandates = await deps.loadMandates(toolIdsOf(snapshot, now));
  const ctx: PolicyContext = { settings, mandates, tool: deps.tool, now };
  return buildPlan(snapshot, { ...ctx, history, sourceErrors: errors });
}

export async function runAutopilot(deps: RunDeps): Promise<RunResult> {
  const settings = await deps.readSettings();
  const gate = runGate(settings, deps.day);
  if (!gate.run) return { ran: false, reason: GATE_REASON_TEXT[gate.reason] };
  const actor = settings.actorUserId;
  if (!actor) return { ran: false, reason: 'No hay nadie en nombre de quien actuar.' };
  if (!(await deps.actorAllowed(actor)))
    return {
      ran: false,
      reason:
        'Quien encendió el piloto ya no administra la empresa: un administrador tiene que volver a encenderlo.',
    };

  const claim = await deps.claimRun({ day: deps.day, actorUserId: actor });
  if (!claim.fresh && claim.status !== 'running')
    return { ran: false, reason: 'El piloto ya corrió hoy.' };

  const started = deps.now().getTime();
  const budget = deps.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;

  // --- El plan: nuevo, o el que ya estaba si esto es un reintento -----------
  let plan: (AutopilotPlan & { stillWaiting: number }) | null = null;
  let rows: Array<SavedItem & { item: DecidedItem }>;
  if (claim.fresh) {
    plan = await planToday(deps, { settings });
    const saved = await deps.saveItems(claim.runId, plan.items);
    const byKey = new Map(plan.items.map((i) => [i.dedupeKey, i]));
    rows = saved
      .map((r) => ({ ...r, item: byKey.get(r.dedupeKey) as DecidedItem }))
      .filter((r) => r.item);
  } else {
    rows = await deps.loadItems(claim.runId);
  }

  const tally = { done: 0, asked: 0, told: 0, failed: 0, skipped: 0 };
  const highlights = { done: [] as string[], asked: [] as string[] };
  let stopped = false;

  // --- Lo que sólo se cuenta, y lo que espera decisión ----------------------
  for (const row of rows) {
    if (row.status === 'told') tally.told += 1;
    if (row.status === 'asked') tally.asked += 1;
    if (row.status === 'done') tally.done += 1;
    if (row.status === 'failed') tally.failed += 1;
    if (row.status === 'skipped') tally.skipped += 1;
    if (row.status !== 'planned') continue;
    if (row.item.decision === 'tell') {
      await safely(() => deps.updateItem(row.id, { status: 'told' }));
      tally.told += 1;
    } else if (row.item.decision === 'ask') {
      let actionId: string | null = null;
      if (row.item.effect === 'external_message') {
        // Una propuesta que no se pudo guardar no tumba la corrida: queda
        // aprobable desde el piloto igual.
        actionId = await deps.proposeMessage(row.item).catch(() => null);
      }
      await safely(() => deps.updateItem(row.id, { status: 'asked', actionId }));
      tally.asked += 1;
      if (highlights.asked.length < 3) highlights.asked.push(row.item.title);
    }
  }

  // --- Lo que se hace -------------------------------------------------------
  for (const row of rows) {
    if (row.status !== 'planned' || row.item.decision !== 'do') continue;

    // EL INTERRUPTOR, releído antes de cada acción.
    const live = await deps.readSettings().catch(() => null);
    if (!live?.enabled) stopped = true;
    if (stopped) {
      await safely(() =>
        deps.updateItem(row.id, {
          status: 'skipped',
          resultSummary: 'No lo hice: apagaron el piloto antes de llegar aquí.',
        }),
      );
      tally.skipped += 1;
      continue;
    }
    if (deps.now().getTime() - started > budget) {
      await safely(() =>
        deps.updateItem(row.id, {
          status: 'skipped',
          resultSummary: 'No alcancé: se acabó el tiempo de la corrida. Vuelve mañana.',
        }),
      );
      tally.skipped += 1;
      continue;
    }

    let outcome: ExecOutcome;
    try {
      outcome = await deps.execute(row.item, {
        idempotencyScope: idempotencyScopeFor(deps.day, row.item.dedupeKey),
      });
    } catch (err) {
      outcome = outcomeFromError(err);
    }
    const at = deps.now().toISOString();
    if (outcome.status === 'done') {
      await safely(() =>
        deps.updateItem(row.id, {
          status: 'done',
          resultSummary: outcome.summary,
          verification: outcome.verification,
          verificationDetail: outcome.verificationDetail ?? null,
          executedAt: at,
        }),
      );
      tally.done += 1;
      if (highlights.done.length < 3) highlights.done.push(row.item.title);
    } else if (outcome.status === 'asked') {
      await safely(() =>
        deps.updateItem(row.id, { status: 'asked', decisionReason: outcome.reason }),
      );
      tally.asked += 1;
      if (highlights.asked.length < 3) highlights.asked.push(row.item.title);
    } else {
      await safely(() =>
        deps.updateItem(row.id, { status: 'failed', error: outcome.error, executedAt: at }),
      );
      tally.failed += 1;
    }
  }

  const summary: RunSummary = {
    runId: claim.runId,
    day: deps.day,
    actorUserId: actor,
    ...tally,
    stillWaiting: plan?.stillWaiting ?? 0,
    stopped,
    highlights,
    message: ownerMessage({ ...tally, stillWaiting: plan?.stillWaiting ?? 0, stopped }),
    sourceErrors: plan?.sourceErrors ?? [],
  };
  await deps.finishRun(claim.runId, summary, stopped ? 'stopped' : 'done');
  // El aviso al dueño no puede tumbar una corrida que ya hizo su trabajo.
  await safely(() => deps.notifyOwner(summary));
  return { ran: true, summary, plan };
}

/** Una escritura de rastro que falla no detiene el resto de la corrida. */
async function safely(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    /* el siguiente paso sigue; la fila quedará en su último estado */
  }
}
