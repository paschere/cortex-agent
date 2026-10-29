import { formatClock, formatLoose, formatMoney, formatNumber } from '../../format/display';
import { relationParts } from '../../trackers/computed';
import { type ViewRow, matches } from '../../views/compute';
import type { CatalogTracker } from '../../views/spec';
import { type AutomationEvent, type Values, fieldChanged, rowValue } from './match';
import { describeReportSource } from './report';
import { REPORT_FORMAT_LABEL } from './report-spec';
import {
  type AutomationAction,
  type AutomationCondition,
  type AutomationTrigger,
  type ChangedCondition,
  DEFAULT_RELATED_ROWS,
  ROLLUP_OP_LABEL,
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

/**
 * Topes de uso por app y por día. Son valores POR DEFECTO: cada app puede subir
 * o bajar los suyos (`custom_apps.automation_limits`, 0212) hasta los máximos
 * de `MAX_AUTOMATION_LIMITS`. Una corrida cuenta como una unidad del plan y cada
 * pedido a Cortex (que gasta modelo) cuenta además en el suyo.
 */
export interface AutomationLimits {
  runsPerDay: number;
  askCortexPerDay: number;
}
export const DEFAULT_AUTOMATION_LIMITS: AutomationLimits = {
  runsPerDay: 1000,
  askCortexPerDay: 100,
};
export const MAX_AUTOMATION_LIMITS: AutomationLimits = {
  runsPerDay: 5000,
  askCortexPerDay: 1000,
};
export const APP_DAILY_RUN_CAP = DEFAULT_AUTOMATION_LIMITS.runsPerDay;
export const APP_DAILY_ASK_CORTEX_CAP = DEFAULT_AUTOMATION_LIMITS.askCortexPerDay;
export const APP_DAILY_EMAIL_CAP = 300;

/** Lo guardado en la app, completado con los valores por defecto y acotado a los máximos. */
export function resolveLimits(raw: unknown): AutomationLimits {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const pick = (key: keyof AutomationLimits): number => {
    const n = Number(r[key]);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_AUTOMATION_LIMITS[key];
    return Math.min(Math.floor(n), MAX_AUTOMATION_LIMITS[key]);
  };
  return { runsPerDay: pick('runsPerDay'), askCortexPerDay: pick('askCortexPerDay') };
}

export const MAX_ATTEMPTS = 4;

// ---------------------------------------------------------------------------
// Condiciones
// ---------------------------------------------------------------------------

export function isChanged(c: AutomationCondition): c is ChangedCondition {
  return 'type' in c && c.type === 'changed';
}

export function dayInBogota(now: Date): string {
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
  /** La fila que despertó la regla: `{{fila}}` la da lista para un campo de relación. */
  rowId?: string;
  /** Etiquetas de los campos (para que `{{Guía}}` también funcione, no sólo la llave). */
  labels?: Record<string, string>;
  /** Tipo de cada campo (llave → tipo): `renderText` lo usa para leer dinero, números y fechas como se ven. */
  types?: Record<string, string>;
}

const VAR_RE = /\{\{\s*([^{}]{1,48}?)\s*\}\}/g;

export function lookupRaw(name: string, ctx: TemplateContext): unknown {
  const n = name.trim();
  const lower = n.toLowerCase();
  if (lower === 'nombre') return ctx.label ?? '';
  if (lower === 'app') return ctx.appName ?? '';
  if (lower === 'enlace') return ctx.link ?? '';
  if (lower === 'motivo') return ctx.reason ?? '';
  // La fecha de hoy en Bogotá (AAAA-MM-DD): «fecha de pago = {{hoy}}» (0232).
  if (lower === 'hoy') return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  // La hora de ahora en Bogotá (HH:MM): «hora de llegada = {{hora}}».
  if (lower === 'hora' && ctx.after.hora === undefined)
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Bogota',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date());
  // La fila que despertó la regla, como valor de un campo de relación: `{{fila}}`.
  if (lower === 'fila' && ctx.after.fila === undefined && ctx.rowId)
    return JSON.stringify({ id: ctx.rowId, label: ctx.label ?? '' });
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
  return value;
}

/** Cómo se lee un valor en un texto: una relación (JSON con id y nombre) se lee por su nombre. */
function readable(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' && value.startsWith('{')) {
    const rel = relationParts(value);
    if (rel?.label) return rel.label;
  }
  return String(value);
}

function lookup(name: string, ctx: TemplateContext): string {
  return readable(lookupRaw(name, ctx));
}

const WHOLE_VAR_RE = /^\s*\{\{\s*([^{}]{1,48}?)\s*\}\}\s*$/;

/**
 * Como `renderTemplate`, pero una plantilla de UNA sola variable conserva el
 * valor crudo (una relación sigue siendo el JSON con su id, para copiarla a
 * otro campo de relación); con texto alrededor se lee por su nombre.
 */
export function renderRaw(template: string, ctx: TemplateContext): string {
  const m = WHOLE_VAR_RE.exec(template);
  if (m) {
    const raw = lookupRaw(m[1] ?? '', ctx);
    return raw === undefined || raw === null ? '' : String(raw);
  }
  return renderTemplate(template, ctx);
}

/** Pinta `{{campo}}`. Un nombre desconocido queda vacío; nunca lanza. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(VAR_RE, (_m, name: string) => lookup(name, ctx));
}

/** El valor de una variable tal como lo lee una persona: «$ 240.000», «2 oct 2026», nunca «240000». */
function lookupText(name: string, ctx: TemplateContext): string {
  const n = name.trim();
  const prior = n.toLowerCase().startsWith('antes.');
  const key = prior ? n.slice(6).trim() : n;
  const raw = lookupRaw(name, ctx);
  if (raw === undefined || raw === null || raw === '') return '';
  let type = ctx.types?.[key];
  if (!type && ctx.labels && ctx.types) {
    const byLabel = Object.entries(ctx.labels).find(
      ([, label]) => label.trim().toLowerCase() === key.toLowerCase(),
    );
    if (byLabel) type = ctx.types[byLabel[0]];
  }
  if (type === 'money' || type === 'number') {
    const num = Number(raw);
    if (Number.isFinite(num) && String(raw).trim() !== '')
      return type === 'money' ? formatMoney(num) : formatNumber(num, 6);
  }
  if (type === 'date' || type === 'time' || typeof raw === 'string') {
    const text = String(raw);
    if (type === 'time') return formatClock(text);
    if (type === 'date' || /^\d{4}-\d{2}-\d{2}(T|$)/.test(text)) return formatLoose(text);
  }
  return readable(raw);
}

/**
 * Pinta `{{campo}}` para que lo LEA una persona (avisos, correos, asuntos): el
 * dinero con puntos y signo de pesos, las fechas en palabras. Para datos que
 * se copian a otro campo se usa `renderTemplate` / `renderRaw`, que dejan el valor crudo.
 */
export function renderText(template: string, ctx: TemplateContext): string {
  return template.replace(VAR_RE, (_m, name: string) => lookupText(name, ctx));
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
      const rendered = renderRaw(v, ctx);
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
  /** Con «si» / «si no»: con esta fila NO se haría. */
  skipped?: boolean;
  /** Lo que cambiaría, línea por línea (filas relacionadas, acumulados). */
  details?: string[];
}

// ---------------------------------------------------------------------------
// «Si» y «si no» por acción
// ---------------------------------------------------------------------------

export interface BranchState {
  /** El resultado de la última acción con condición (la que mira un «si no»). */
  lastIf: ConditionResult | null;
}

export function newBranchState(): BranchState {
  return { lastIf: null };
}

/**
 * ¿Toca hacer esta acción? Sin `if` ni `otherwise`, siempre. Con `if`, si la
 * fila cumple las condiciones. Con `otherwise` (la rama «si no»), justo cuando
 * la última acción con `if` NO se hizo por no cumplirse. Se llama en orden,
 * para TODAS las acciones (también las que ya salieron bien en un intento
 * anterior), así el estado de «si no» se rehace igual en cada reintento.
 */
export function branchDecision(
  action: Pick<AutomationAction, 'if' | 'otherwise'>,
  state: BranchState,
  evaluate: (conditions: AutomationCondition[]) => ConditionResult,
): { run: boolean; reason?: string } {
  if (action.otherwise) {
    if (!state.lastIf) return { run: false, reason: 'no hay una condición anterior' };
    if (state.lastIf.ok) return { run: false, reason: 'la condición anterior sí se cumplió' };
    return { run: true };
  }
  if (action.if?.length) {
    const r = evaluate(action.if);
    state.lastIf = r;
    return r.ok ? { run: true } : { run: false, reason: r.failed ?? 'la condición no se cumple' };
  }
  return { run: true };
}

const setText = (set: Record<string, string | number>, ctx: TemplateContext) =>
  Object.entries(renderValues(set, ctx))
    .map(([k, x]) => `${k} = ${x === '' ? '(vacío)' : x}`)
    .join(', ');

/** Qué diría o haría cada acción con esta fila: texto, sin tocar nada. */
export function previewActions(
  actions: AutomationAction[],
  ctx: TemplateContext,
  opts?: { event: AutomationEvent; tracker: CatalogTracker | null; now: Date },
): ActionPreview[] {
  const state = newBranchState();
  const evaluate = (conds: AutomationCondition[]) =>
    opts
      ? evaluateConditions(conds, { ...opts.event, after: ctx.after }, opts.tracker, opts.now)
      : ({ ok: true } as ConditionResult);
  return actions.map((a): ActionPreview => {
    const decision = branchDecision(a, state, evaluate);
    const base = previewAction(a, ctx);
    if (!decision.run)
      return {
        type: a.type,
        skipped: true,
        summary: `No se haría con esta fila (${decision.reason}). Si se hiciera: ${base.summary}`,
      };
    if (!opts && (a.if?.length || a.otherwise))
      return {
        ...base,
        summary: `${a.otherwise ? 'Si NO se cumple la condición anterior' : 'Si se cumple su condición'}: ${base.summary}`,
      };
    return base;
  });
}

function previewAction(a: AutomationAction, ctx: TemplateContext): ActionPreview {
  switch (a.type) {
    case 'set_field':
      return {
        type: a.type,
        summary: `Pondría «${a.field}» en «${typeof a.value === 'number' ? a.value : renderRaw(a.value, ctx)}».`,
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
        summary: `Avisaría en la campana${a.onShift ? ' (sólo a quienes tienen el turno abierto)' : ''}: «${renderTemplate(a.title, ctx)}».`,
      };
    case 'check_zone':
      return {
        type: a.type,
        summary: `Miraría ${a.from ? `la ubicación «${a.from}»` : 'dónde está quien lo hizo'} frente a ${a.zones?.length ? `las zonas ${a.zones.join(', ')}` : 'los lugares de la app'} y dejaría la zona${a.outsideField ? ` y «${a.outsideField}» (${a.outsideValue}/${a.insideValue}/${a.unknownValue})` : ''}.`,
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
        summary: `Le pediría a Cortex: «${renderTemplate(a.instruction, ctx).slice(0, 300)}». ${
          a.writes === undefined
            ? 'Lo que escriba fuera de esta tabla pasa por aprobación.'
            : a.writes === 'row'
              ? 'Podría cambiar cualquier campo de esta fila sin aprobación; lo demás pasa por aprobación.'
              : `Podría cambiar sólo ${a.writes.join(', ')} de esta fila sin aprobación; lo demás pasa por aprobación.`
        }`,
      };
    case 'update_related':
      return {
        type: a.type,
        summary: a.up
          ? `Cambiaría la fila a la que apunta «${a.up}»: ${setText(a.set, ctx)}.`
          : `Cambiaría las filas de «${a.down?.tracker}» cuyo «${a.down?.via}» apunta a esta fila${a.where?.length ? ' (y cumplan el filtro)' : ''}, hasta ${a.max ?? DEFAULT_RELATED_ROWS}: ${setText(a.set, ctx)}.`,
      };
    case 'update_rows':
      return {
        type: a.type,
        summary: `Cambiaría hasta ${a.max ?? DEFAULT_RELATED_ROWS} filas de «${a.tracker}» que cumplan ${a.where.length} filtro${a.where.length === 1 ? '' : 's'}: ${setText(a.set, ctx)}.`,
      };
    case 'link_rows':
      return {
        type: a.type,
        summary: a.up
          ? `Buscaría en la tabla de «${a.up}» la fila cuyo «${a.on}» coincide con «${renderTemplate(a.value, ctx) || '(vacío)'}»${a.tolerance !== undefined ? ` (monto, ±${a.tolerance})` : ''} y, si es UNA sola, dejaría puesta la relación; si hay varias o ninguna, la deja para casar a mano.`
          : `Buscaría en «${a.down?.tracker}» las filas libres cuyo «${a.on}» coincide con «${renderTemplate(a.value, ctx) || '(vacío)'}» y les pondría la relación «${a.down?.via}» hacia esta fila, hasta ${a.max ?? DEFAULT_RELATED_ROWS}.`,
      };
    case 'rollup':
      return {
        type: a.type,
        summary: `Dejaría en «${a.target}» de la fila padre (por «${a.up}») ${ROLLUP_OP_LABEL[a.op]}${a.field ? ` de «${a.field}»` : ''} de todas sus filas hijas.`,
      };
    case 'report':
      return {
        type: a.type,
        summary: `Armaría el reporte «${renderTemplate(a.title, ctx)}» (${describeReportSource(a.source)}) y lo mandaría por correo a ${[...a.to, ...a.roles.map((r) => `rol ${r}`)].join(', ')}${a.formats.length ? ` con ${a.formats.map((f) => REPORT_FORMAT_LABEL[f]).join(' y ')} adjunto` : ' (sólo la tabla en el cuerpo)'}.`,
      };
    case 'accounting_draft_invoice':
      return {
        type: a.type,
        summary: `Armaría una prefactura para el NIT ${renderTemplate(a.customer.taxId, ctx) || '(vacío)'} con ${a.items.length} ítem${a.items.length === 1 ? '' : 's'}${a.currency !== 'COP' ? ` en ${a.currency} (a pesos con la TRM)` : ''} ${a.send === 'siigo_sin_dian' ? 'y la CREARÍA en Siigo de una vez, SIN enviarla a la DIAN (el contador la revisa y la timbra en Siigo); quien causó el cambio firma como aprobador. Si Siigo rechaza, dejaría el motivo en la fila' : 'y la dejaría POR REVISAR; sólo al aprobarla una persona se crea en Siigo'}.`,
      };
    case 'accounting_upsert_customer':
      return {
        type: a.type,
        summary: `Armaría el cliente «${renderTemplate(a.name, ctx) || '(sin nombre)'}» (NIT ${renderTemplate(a.taxId, ctx) || '(vacío)'}, con su dígito de verificación calculado) para crearlo en Siigo si no existe, y lo dejaría POR REVISAR; nada llega a Siigo sin la aprobación de una persona.`,
      };
    case 'accounting_draft_receipt':
      return {
        type: a.type,
        summary: `Armaría un recibo de caja de ${typeof a.amount === 'number' ? formatMoney(a.amount) : `«${renderTemplate(a.amount, ctx)}»`} del NIT ${renderTemplate(a.customer.taxId, ctx) || '(vacío)'} contra ${a.invoices ? `las facturas ${renderTemplate(a.invoices, ctx) || '(vacío)'}` : 'sus facturas con saldo (la que vence primero primero)'} y lo dejaría POR REVISAR; el recibo sólo se registra en Siigo cuando una persona lo aprueba.`,
      };
    case 'accounting_draft_credit_note':
      return {
        type: a.type,
        summary: `Armaría una nota crédito (motivo DIAN ${a.reason}) a la factura ${renderTemplate(a.invoice, ctx) || '(vacío)'}, ${a.mode === 'total' ? 'por toda la factura' : `con ${(a.items ?? []).length} línea(s)`}, y la dejaría POR REVISAR; sólo se crea en Siigo cuando una persona la aprueba.`,
      };
    case 'wait':
      return {
        type: a.type,
        summary: `Esperaría ${waitText(a.minutes)} y volvería a revisar la fila${
          a.stillIf?.length === 0
            ? ' (seguiría siempre)'
            : a.stillIf
              ? ` (seguiría sólo si cumple ${a.stillIf.length} condición${a.stillIf.length === 1 ? '' : 'es'})`
              : ' (seguiría sólo si sigue cumpliendo las condiciones de la regla)'
        }; si no, la regla termina ahí.`,
      };
  }
}

export function waitText(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} día${minutes === 1440 ? '' : 's'}`;
  if (minutes % 60 === 0 && minutes >= 60)
    return `${minutes / 60} hora${minutes === 60 ? '' : 's'}`;
  return `${minutes} minuto${minutes === 1 ? '' : 's'}`;
}

export interface Simulation {
  triggerLabel: string;
  triggers: boolean;
  conditions: ConditionResult;
  /** Lo que haría si corriera: nunca lo hace. */
  actions: ActionPreview[];
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
    actions: previewActions(input.actions, ctx, { event, tracker, now }),
  };
}
