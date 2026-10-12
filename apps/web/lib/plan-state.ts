/**
 * EL PLAN POR ADELANTADO, REDUCIDO DESDE LOS RESULTADOS DE HERRAMIENTA.
 *
 * `cortex.plan` y `cortex.plan_update` no guardan nada: devuelven lo que
 * recibieron (packages/agent-tools/src/cortex/plan.ts). El estado vigente del
 * plan es entonces un pliegue de esos resultados, en el orden en que llegaron.
 * Pura y sin dependencias: la importan componentes del navegador.
 */

export type PlanStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'skipped';

export interface PlanStep {
  id: string;
  label: string;
  status: PlanStatus;
  note?: string;
  /** Herramientas con confirmación que el paso piensa llamar (ids exactos). */
  tools?: string[];
  /** Qué cambia el paso, en una frase para la persona. */
  what?: string;
}

export interface PlanState {
  title: string;
  steps: PlanStep[];
  /** El id de la última llamada de plan: la que dibuja la tarjeta del chat. */
  lastCallId: string;
}

export interface PlanInvocation {
  toolCallId: string;
  toolName: string;
  state: string;
  result?: unknown;
}

const STATUSES: readonly PlanStatus[] = ['pending', 'in_progress', 'done', 'failed', 'skipped'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 160): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const statusOf = (v: unknown, fallback: PlanStatus = 'pending'): PlanStatus =>
  typeof v === 'string' && (STATUSES as readonly string[]).includes(v)
    ? (v as PlanStatus)
    : fallback;

export const isPlanTool = (toolName: string): boolean => {
  const id = toolName.replaceAll('.', '_');
  return id === 'cortex_plan' || id === 'cortex_plan_update';
};

function stepOf(raw: unknown): PlanStep | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id, 24);
  const label = text(raw.label, 90);
  if (!id || !label) return null;
  const note = text(raw.note);
  const what = text(raw.what, 140);
  const tools = (Array.isArray(raw.tools) ? raw.tools : [])
    .filter((t): t is string => typeof t === 'string' && /^[A-Za-z0-9_.-]{3,80}$/.test(t))
    .filter((t, i, all) => all.indexOf(t) === i)
    .slice(0, 8);
  return {
    id,
    label,
    status: statusOf(raw.status),
    ...(note ? { note } : {}),
    ...(what ? { what } : {}),
    ...(tools.length ? { tools } : {}),
  };
}

function usable(result: unknown): Record<string, unknown> | null {
  if (!isRecord(result)) return null;
  if ('__error' in result || result.__requires_confirmation === true) return null;
  return result;
}

/**
 * El plan vigente, o `null` si el turno no declaró ninguno. Una actualización
 * antes de que haya plan (o sobre un id que no existe) se ignora: no inventa
 * pasos. Los pasos nuevos de `added` se agregan al final sin repetir ids.
 */
export function planFromInvocations(invocations: readonly PlanInvocation[]): PlanState | null {
  let plan: PlanState | null = null;
  for (const inv of invocations) {
    if (inv.state !== 'result' || !isPlanTool(inv.toolName)) continue;
    const result = usable(inv.result);
    if (!result) continue;
    if (inv.toolName.replaceAll('.', '_') === 'cortex_plan') {
      const steps = (Array.isArray(result.steps) ? result.steps : [])
        .map(stepOf)
        .filter((s): s is PlanStep => s !== null);
      const title = text(result.title, 80);
      if (steps.length === 0) continue;
      plan = { title: title || 'Plan de la tarea', steps, lastCallId: inv.toolCallId };
      continue;
    }
    if (!plan) continue;
    const next: PlanStep[] = plan.steps.map((s) => ({ ...s }));
    for (const raw of Array.isArray(result.updates) ? result.updates : []) {
      if (!isRecord(raw)) continue;
      const target = next.find((s) => s.id === text(raw.id, 24));
      if (!target) continue;
      target.status = statusOf(raw.status, target.status);
      const note = text(raw.note);
      if (note) target.note = note;
      else if (target.status === 'done') delete target.note;
    }
    for (const raw of Array.isArray(result.added) ? result.added : []) {
      const step = stepOf(raw);
      if (step && !next.some((s) => s.id === step.id)) next.push(step);
    }
    plan = { ...plan, steps: next, lastCallId: inv.toolCallId };
  }
  return plan;
}

export function planProgress(plan: PlanState): { done: number; total: number; finished: boolean } {
  const total = plan.steps.length;
  const closed = plan.steps.filter(
    (s) => s.status === 'done' || s.status === 'failed' || s.status === 'skipped',
  ).length;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  return { done, total, finished: total > 0 && closed === total };
}

/** Los ids de herramienta que los pasos TODAVÍA POR HACER piensan llamar. */
export function planToolIds(plan: PlanState): string[] {
  const ids = plan.steps
    .filter((s) => s.status === 'pending' || s.status === 'in_progress')
    .flatMap((s) => s.tools ?? []);
  return [...new Set(ids)];
}
