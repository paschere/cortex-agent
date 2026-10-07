import { type ViewRow, matches } from '../../views/compute';
import type { CatalogTracker } from '../../views/spec';
import { type AutomationEvent, type Values, fieldChanged, rowValue } from './match';
import {
  type AutomationAction,
  type AutomationCondition,
  type AutomationTrigger,
  type ChangedCondition,
  TRIGGER_LABEL,
} from './spec';

/**
 * EL MOTOR PURO de las automatizaciones (migración 0210): condiciones,
 * variables, franjas de horario, reintentos y topes. Sin base, sin red, sin
 * reloj propio (todo recibe `now`): por eso se prueba entero sin mocks y por
 * eso el simulador del editor («probar con una fila de ejemplo») usa EXACTAMENTE
 * lo que usa la corrida de verdad.
 */

export const TIMEZONE = 'America/Bogota';

/** Topes de uso: por app y por día. */
export const APP_DAILY_RUN_CAP = 500;
export const APP_DAILY_ASK_CORTEX_CAP = 20;
export const APP_DAILY_EMAIL_CAP = 300;

export const MAX_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Condiciones
// ---------------------------------------------------------------------------

export function isChanged(c: AutomationCondition): c is ChangedCondition {
  return 'type' in c && c.type === 'changed';
}

function dayInBogota(now: Date): string {
  return new Date(now.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
}

export interface ConditionResult {
  ok: boolean;
  /** Frase para el historial: la primera condición que no se cumplió. */
  failed?: string;
}

/**
 * ¿La fila cumple todas las condiciones? Los filtros son los de las vistas
 * (`matches` de compute.ts: la misma semántica que el filtro de una tabla);
 * «cambió de X a Y» compara antes y después del suceso.
 */
export function evaluateConditions(
  conditions: AutomationCondition[],
  event: AutomationEvent,
  tracker: CatalogTracker | null,
  now: Date,
): ConditionResult {
  if (!conditions.length) return { ok: true };
  const row: ViewRow = {
    id: event.rowId ?? 'sin-fila',
    label: event.label ?? '',
    values: event.after ?? {},
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
  const today = dayInBogota(now);
  for (const c of conditions) {
    if (isChanged(c)) {
      if (!fieldChanged(event, c.field)) return { ok: false, failed: `«${c.field}» no cambió` };
      const eq = (a: unknown, b: unknown) =>
        String(a ?? '')
          .trim()
          .toLowerCase() ===
        String(b ?? '')
          .trim()
          .toLowerCase();
      if (c.from !== undefined && !eq(rowValue(event.before, c.field), c.from))
        return { ok: false, failed: `«${c.field}» no venía de «${c.from}»` };
      if (c.to !== undefined && !eq(rowValue(event.after, c.field), c.to))
        return { ok: false, failed: `«${c.field}» no pasó a «${c.to}»` };
      continue;
    }
    const t: CatalogTracker = tracker ?? { slug: 'sin-tabla', name: '', fields: [] };
    if (!matches(t, row, c, today))
      return { ok: false, failed: `la condición sobre «${c.field}» no se cumple` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Variables {{campo}}
// ---------------------------------------------------------------------------

export interface TemplateContext {
  after: Values;
  before?: Values | null;
  label?: string;
  appName?: string;
  link?: string;
  reason?: string;
  /** Etiquetas de los campos (para que `{{Guía}}` también funcione, no sólo la llave). */
  labels?: Record<string, string>;
}

const VAR_RE = /\{\{\s*([^{}]{1,48}?)\s*\}\}/g;

function lookup(name: string, ctx: TemplateContext): string {
  const n = name.trim();
  const lower = n.toLowerCase();
  if (lower === 'nombre') return ctx.label ?? '';
  if (lower === 'app') return ctx.appName ?? '';
  if (lower === 'enlace') return ctx.link ?? '';
  if (lower === 'motivo') return ctx.reason ?? '';
  const prior = lower.startsWith('antes.');
  const key = prior ? n.slice(6).trim() : n;
  const source = prior ? (ctx.before ?? {}) : ctx.after;
  let value = source[key];
  if (value === undefined && ctx.labels) {
    const byLabel = Object.entries(ctx.labels).find(
      ([, label]) => label.trim().toLowerCase() === key.toLowerCase(),
    );
    if (byLabel) value = source[byLabel[0]];
  }
  return value === undefined || value === null ? '' : String(value);
}

/** Pinta `{{campo}}`. Un nombre desconocido queda vacío; nunca lanza. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(VAR_RE, (_m, name: string) => lookup(name, ctx));
}

/** Las variables que una plantilla nombra (para el editor y la validación). */
export function variablesIn(template: string): string[] {
  return [...template.matchAll(VAR_RE)].map((m) => (m[1] ?? '').trim());
}

/** Valores de una fila nueva: lo fijo se queda, `{{campo}}` se llena; los números se conservan. */
export function renderValues(
  values: Record<string, string | number>,
  ctx: TemplateContext,
): Values {
  const out: Values = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'number') out[k] = v;
    else {
      const rendered = renderTemplate(v, ctx);
      // Una plantilla de una sola variable que da un número sigue siendo número.
      out[k] =
        /^\s*\{\{[^{}]+\}\}\s*$/.test(v) && rendered !== '' && Number.isFinite(Number(rendered))
          ? Number(rendered)
          : rendered;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Horarios (zona Bogotá, sin horario de verano)
// ---------------------------------------------------------------------------

/**
 * El comienzo de la franja más reciente de un horario a o antes de `now`
 * (hora de Bogotá). Diario: hoy a `hour` (o ayer, si todavía no llega).
 * Semanal: el último `weekday` (1 = lunes) a `hour`.
 */
export function scheduleSlotStart(
  trigger: Extract<AutomationTrigger, { type: 'schedule' }>,
  now: Date,
): Date {
  const local = new Date(now.getTime() - 5 * 3_600_000);
  const slotLocal = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), trigger.hour, 0, 0),
  );
  if (trigger.cadence === 'weekly') {
    const jsDay = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
    const back = (jsDay - (trigger.weekday ?? 1) + 7) % 7;
    slotLocal.setUTCDate(slotLocal.getUTCDate() - back);
  }
  const slot = new Date(slotLocal.getTime() + 5 * 3_600_000);
  if (slot.getTime() > now.getTime()) {
    slot.setUTCDate(slot.getUTCDate() - (trigger.cadence === 'weekly' ? 7 : 1));
  }
  return slot;
}

/** ¿Toca correr el horario ahora? Toca si su franja más reciente aún no se reclamó. */
export function scheduleDue(
  trigger: Extract<AutomationTrigger, { type: 'schedule' }>,
  lastSlot: Date | null,
  now: Date,
  /** Pasada esta antigüedad la franja se da por perdida (no se recupera una de hace días). */
  graceMs = 6 * 3_600_000,
): Date | null {
  const slot = scheduleSlotStart(trigger, now);
  if (now.getTime() - slot.getTime() > graceMs) return null;
  if (lastSlot && lastSlot.getTime() >= slot.getTime()) return null;
  return slot;
}

// ---------------------------------------------------------------------------
// Reintentos
// ---------------------------------------------------------------------------

/** Una espera creciente: 1, 5 y 15 minutos. */
export function backoffMs(attempt: number): number {
  return [60_000, 300_000, 900_000][Math.min(Math.max(attempt - 1, 0), 2)] as number;
}

export class TransientActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransientActionError';
  }
}

/** Un error de red o un 5xx/429 se reintenta; una configuración mala o un 4xx no. */
export function isTransient(err: unknown): boolean {
  if (err instanceof TransientActionError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /timeout|timed out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|\b(429|500|502|503|504)\b/i.test(
    msg,
  );
}

// ---------------------------------------------------------------------------
// Simulación (sin efectos)
// ---------------------------------------------------------------------------

export interface ActionPreview {
  type: AutomationAction['type'];
  summary: string;
}

export interface Simulation {
  triggerLabel: string;
  triggers: boolean;
  conditions: ConditionResult;
  /** Lo que haría si corriera: nunca lo hace. */
  actions: ActionPreview[];
}

/** Qué diría o haría cada acción con esta fila: texto, sin tocar nada. */
export function previewActions(actions: AutomationAction[], ctx: TemplateContext): ActionPreview[] {
  return actions.map((a): ActionPreview => {
    switch (a.type) {
      case 'set_field':
        return {
          type: a.type,
          summary: `Pondría «${a.field}» en «${typeof a.value === 'number' ? a.value : renderTemplate(a.value, ctx)}».`,
        };
      case 'create_row': {
        const v = renderValues(a.values, ctx);
        return {
          type: a.type,
          summary: `Crearía una fila en «${a.tracker}» con ${Object.entries(v)
            .map(([k, x]) => `${k} = ${x}`)
            .join(', ')}.`,
        };
      }
      case 'notify_member':
        return {
          type: a.type,
          summary: `Avisaría en la campana: «${renderTemplate(a.title, ctx)}».`,
        };
      case 'notify_app_user':
        return {
          type: a.type,
          summary: `Mandaría a ${a.to === 'creator' ? 'quien creó la fila' : `los del rol ${a.to.role}`} (push, o correo si no tiene push): «${renderTemplate(a.title, ctx)}».`,
        };
      case 'email':
        return {
          type: a.type,
          summary: `Mandaría un correo a ${[...a.to, ...a.roles.map((r) => `rol ${r}`)].join(', ')}: «${renderTemplate(a.subject, ctx)}».`,
        };
      case 'webhook':
        return { type: a.type, summary: `Haría un POST firmado a ${a.url}.` };
      case 'ask_cortex':
        return {
          type: a.type,
          summary: `Le pediría a Cortex: «${renderTemplate(a.instruction, ctx).slice(0, 200)}». Lo que escriba fuera de esta tabla pasa por aprobación.`,
        };
    }
  });
}

export function simulateRule(
  input: {
    trigger: AutomationTrigger;
    conditions: AutomationCondition[];
    actions: AutomationAction[];
  },
  event: AutomationEvent,
  ctx: TemplateContext,
  tracker: CatalogTracker | null,
  now: Date,
  triggers: boolean,
): Simulation {
  return {
    triggerLabel: TRIGGER_LABEL[input.trigger.type],
    triggers,
    conditions: evaluateConditions(input.conditions, event, tracker, now),
    actions: previewActions(input.actions, ctx),
  };
}
