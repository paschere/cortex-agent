import type { StatusTone } from '@/lib/status-chip';
import {
  AREA_HINT,
  AREA_LABEL,
  AUTOPILOT_AREAS,
  AUTOPILOT_LEVELS,
  type AutopilotArea,
  type AutopilotDecision,
  type AutopilotItemRow,
  type AutopilotItemStatus,
  type AutopilotLevel,
  type AutopilotPlan,
  type AutopilotRunRow,
  type AutopilotSettings,
  DECISION_LABEL,
  type DecidedItem,
  ITEM_STATUS_LABEL,
  LEVEL_LABEL,
  autopilotMoney,
  daysLabel,
  hourLabel,
  itemFingerprint,
  runGate,
} from '@cortex/agent-tools';

/**
 * LO QUE PINTAN /piloto Y /piloto/[corrida], ARMADO EN EL SERVIDOR.
 *
 * Las pantallas (components/autopilot) sólo reciben estas formas: texto ya
 * escrito, tonos ya decididos, enlaces ya resueltos. Así se pintan igual con
 * datos de verdad y en /v/piloto-showcase, y ningún componente de cliente
 * necesita importar valores de @cortex/agent-tools.
 */

export interface ItemView {
  id: string | null;
  area: AutopilotArea;
  areaLabel: string;
  title: string;
  why: string;
  decision: AutopilotDecision;
  decisionLabel: string;
  reason: string;
  status: AutopilotItemStatus | null;
  statusLabel: string | null;
  statusTone: StatusTone;
  /** «Bajo el mandato "Correos de cobro"» / «Rutinario». */
  authorityLabel: string | null;
  amountLabel: string | null;
  resultSummary: string | null;
  verification: 'verified' | 'not_verified' | 'unverifiable' | null;
  verificationLabel: string | null;
  error: string | null;
  href: string | null;
  undo: { href: string; label: string } | null;
  /** Lo que espera decisión y se aprueba en la cola de aprobaciones (un correo). */
  approvalsHref: string | null;
  /** La huella de lo que se ejecutará, para aprobar desde /piloto. */
  contentHash: string | null;
  /** Qué haría, en una línea: «Atar el pago a su factura». */
  actionLabel: string | null;
  /** Para un correo: a quién y con qué asunto. */
  preview: { to: string; subject: string; body: string } | null;
  decidedAt: string | null;
}

export interface PlanView {
  day: string;
  dayLabel: string;
  enabled: boolean;
  counts: { do: number; ask: number; tell: number };
  groups: Array<{ decision: AutopilotDecision; title: string; hint: string; items: ItemView[] }>;
  sourceErrors: string[];
  stillWaiting: number;
  suppressed: number;
}

export interface RunView {
  id: string;
  day: string;
  dayLabel: string;
  status: string;
  statusLabel: string;
  statusTone: StatusTone;
  summary: string;
  counts: { done: number; asked: number; told: number; failed: number; skipped: number };
  sections: Array<{
    key: 'asked' | 'done' | 'failed' | 'told' | 'skipped' | 'decided';
    title: string;
    hint: string;
    items: ItemView[];
  }>;
  sourceErrors: string[];
  startedLabel: string | null;
  finishedLabel: string | null;
}

export interface RunListEntry {
  id: string;
  dayLabel: string;
  summary: string;
  statusLabel: string;
  statusTone: StatusTone;
  href: string;
  done: number;
  asked: number;
}

export interface SettingsView {
  enabled: boolean;
  runHour: number;
  runDays: number[];
  skipHolidays: boolean;
  quietDays: string[];
  maxExternalMessages: number;
  maxAmountReferenced: number;
  maxActionsPerRun: number;
  notifyEmail: boolean;
  currency: string;
  areas: Array<{
    area: AutopilotArea;
    label: string;
    hint: string;
    level: AutopilotLevel;
    /** «hacer» no se ofrece en pagos: nunca se mueve plata solo. */
    levels: Array<{ level: AutopilotLevel; label: string; disabled: boolean }>;
  }>;
  scheduleLabel: string;
  /** «Hoy a las 7:00 a. m.», «Mañana…», o por qué no corre. */
  nextRunLabel: string;
  actorLabel: string | null;
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** «martes 6 de octubre». */
export function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const dow = new Date(Date.UTC(y, m - 1, d, 12)).getUTCDay();
  return `${WEEKDAYS[dow]} ${d} de ${MONTHS[m - 1]}`;
}

/** «7:04 a. m.» en Bogotá, desde un instante. */
export function timeLabel(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleTimeString('es-CO', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Bogota',
  });
}

const STATUS_TONE: Record<AutopilotItemStatus, StatusTone> = {
  planned: 'primary',
  done: 'emerald',
  failed: 'rose',
  skipped: 'neutral',
  asked: 'amber',
  told: 'neutral',
  dismissed: 'neutral',
};

const VERIFICATION_LABEL = {
  verified: 'Verificado',
  not_verified: 'No cuadró al verificar',
  unverifiable: 'Sin verificación posible',
} as const;

function actionLabelOf(
  toolId: string | null | undefined,
  toolLabel: (id: string) => string,
): string | null {
  return toolId ? toolLabel(toolId) : null;
}

function previewOf(
  toolId: string | null | undefined,
  input: Record<string, unknown> | null | undefined,
): ItemView['preview'] {
  if (!toolId || !input || !toolId.endsWith('send_message')) return null;
  const to = Array.isArray(input.to) ? (input.to as string[]).join(', ') : '';
  if (!to) return null;
  return {
    to,
    subject: typeof input.subject === 'string' ? input.subject : '',
    body: typeof input.body === 'string' ? input.body : '',
  };
}

function authorityLabel(
  authority: 'mandate' | 'routine' | null,
  mandateLabel: string | null,
): string | null {
  if (authority === 'mandate')
    return mandateLabel ? `Bajo el mandato «${mandateLabel}»` : 'Bajo un mandato';
  // Lo rutinario ya lo dice la razón; repetirlo en una cápsula es ruido.
  return null;
}

/** Una cosa del plan (ensayo), sin fila todavía. */
export function viewOfPlanned(item: DecidedItem, toolLabel: (id: string) => string): ItemView {
  return {
    id: null,
    area: item.area,
    areaLabel: AREA_LABEL[item.area],
    title: item.title,
    why: item.why,
    decision: item.decision,
    decisionLabel: DECISION_LABEL[item.decision],
    reason: item.decisionReason,
    status: null,
    statusLabel: null,
    statusTone: item.decision === 'do' ? 'primary' : item.decision === 'ask' ? 'amber' : 'neutral',
    authorityLabel: authorityLabel(item.authority, item.mandateLabel),
    amountLabel: item.amount ? autopilotMoney(item.amount, item.currency ?? 'COP') : null,
    resultSummary: null,
    verification: null,
    verificationLabel: null,
    error: null,
    href: item.href ?? null,
    undo: null,
    approvalsHref: null,
    contentHash: null,
    actionLabel: actionLabelOf(item.proposedAction?.toolId, toolLabel),
    preview: previewOf(item.proposedAction?.toolId, item.proposedAction?.input),
    decidedAt: null,
  };
}

/** Una cosa guardada de una corrida. */
export function viewOfRow(
  r: AutopilotItemRow,
  toolLabel: (id: string) => string,
  mandateNames: Map<string, string> = new Map(),
): ItemView {
  const amount = r.amount == null ? null : Number(r.amount);
  return {
    id: r.id,
    area: r.area,
    areaLabel: AREA_LABEL[r.area] ?? r.area,
    title: r.title,
    why: r.why,
    decision: r.decision,
    decisionLabel: DECISION_LABEL[r.decision],
    reason: r.decision_reason,
    status: r.status,
    statusLabel: ITEM_STATUS_LABEL[r.status] ?? r.status,
    statusTone: STATUS_TONE[r.status] ?? 'neutral',
    authorityLabel: authorityLabel(
      r.authority,
      r.mandate_id ? (mandateNames.get(r.mandate_id) ?? null) : null,
    ),
    amountLabel: amount ? autopilotMoney(amount, r.currency ?? 'COP') : null,
    resultSummary: r.result_summary,
    verification: r.verification,
    verificationLabel: r.verification ? VERIFICATION_LABEL[r.verification] : null,
    error: r.error,
    href: r.href,
    undo: r.status === 'done' ? r.undo : null,
    approvalsHref: r.action_id && r.status === 'asked' ? '/approvals' : null,
    contentHash: r.status === 'asked' && !r.action_id && r.tool_id ? itemFingerprint(r) : null,
    actionLabel: actionLabelOf(r.tool_id, toolLabel),
    preview: previewOf(r.tool_id, r.tool_input),
    decidedAt: r.decided_at,
  };
}

const GROUP_COPY: Record<AutopilotDecision, { title: string; hint: string }> = {
  do: {
    title: 'Lo hago solo',
    hint: 'Interno y rutinario, o cubierto por un mandato. Cada cosa queda en la auditoría.',
  },
  ask: {
    title: 'Necesita tu decisión',
    hint: 'Te lo dejo listo: lo apruebas o lo descartas con un clic.',
  },
  tell: {
    title: 'Para que sepas',
    hint: 'No hay nada que yo pueda hacer al respecto, o el área está en «sólo avisar».',
  },
};

export function buildPlanView(
  plan: AutopilotPlan & { stillWaiting?: number },
  settings: AutopilotSettings,
  toolLabel: (id: string) => string,
): PlanView {
  const order: AutopilotDecision[] = ['do', 'ask', 'tell'];
  return {
    day: plan.day,
    dayLabel: dayLabel(plan.day),
    enabled: settings.enabled,
    counts: plan.counts,
    groups: order
      .map((decision) => ({
        decision,
        ...GROUP_COPY[decision],
        items: plan.items
          .filter((i) => i.decision === decision)
          .map((i) => viewOfPlanned(i, toolLabel)),
      }))
      .filter((g) => g.items.length > 0),
    sourceErrors: plan.sourceErrors.map((e) => e.source),
    stillWaiting: plan.stillWaiting ?? 0,
    suppressed: plan.suppressed,
  };
}

const RUN_STATUS: Record<string, { label: string; tone: StatusTone }> = {
  running: { label: 'En curso', tone: 'primary' },
  done: { label: 'Terminó', tone: 'emerald' },
  stopped: { label: 'Detenido', tone: 'amber' },
  failed: { label: 'Falló', tone: 'rose' },
};

export function buildRunView(
  run: AutopilotRunRow,
  rows: AutopilotItemRow[],
  toolLabel: (id: string) => string,
  mandateNames: Map<string, string> = new Map(),
): RunView {
  const items = rows.map((r) => viewOfRow(r, toolLabel, mandateNames));
  const pick = (pred: (i: ItemView) => boolean) => items.filter(pred);
  const status = RUN_STATUS[run.status] ?? { label: run.status, tone: 'neutral' as StatusTone };
  const sections: RunView['sections'] = [
    {
      key: 'asked' as const,
      title: 'Necesita tu decisión',
      hint: 'Apruébalo y lo hago ahora, como tú; o descártalo y no te lo vuelvo a proponer esta semana.',
      items: pick((i) => i.status === 'asked'),
    },
    {
      key: 'done' as const,
      title: 'Lo que hice',
      hint: 'Con su razón, lo que pasó y cómo lo verifiqué.',
      items: pick((i) => i.status === 'done' && !i.decidedAt),
    },
    {
      key: 'decided' as const,
      title: 'Lo que decidiste',
      hint: 'Lo que aprobaste o descartaste desde aquí.',
      items: pick((i) => Boolean(i.decidedAt) && i.status !== 'asked'),
    },
    {
      key: 'failed' as const,
      title: 'No salió',
      hint: 'Lo intenté y falló. No bloqueó lo demás; mañana lo vuelvo a intentar si sigue haciendo falta.',
      items: pick((i) => i.status === 'failed' && !i.decidedAt),
    },
    {
      key: 'told' as const,
      title: 'Para que sepas',
      hint: 'Lo que vi y no me toca hacer.',
      items: pick((i) => i.status === 'told'),
    },
    {
      key: 'skipped' as const,
      title: 'Omitido',
      hint: 'Lo iba a hacer y no lo hice: apagaste el piloto o se acabó el tiempo de la corrida.',
      items: pick((i) => i.status === 'skipped' || i.status === 'planned'),
    },
  ].filter((s) => s.items.length > 0);
  return {
    id: run.id,
    day: run.run_on,
    dayLabel: dayLabel(run.run_on),
    status: run.status,
    statusLabel: status.label,
    statusTone: status.tone,
    summary: run.summary ?? (run.status === 'running' ? 'Estoy en eso…' : 'Sin resumen.'),
    counts: {
      done: run.done_count,
      asked: run.asked_count,
      told: run.told_count,
      failed: run.failed_count,
      skipped: run.skipped_count,
    },
    sections,
    sourceErrors: (run.source_errors ?? []).map((e) => e.source),
    startedLabel: timeLabel(run.started_at),
    finishedLabel: timeLabel(run.finished_at),
  };
}

export function runListEntry(run: AutopilotRunRow): RunListEntry {
  const status = RUN_STATUS[run.status] ?? { label: run.status, tone: 'neutral' as StatusTone };
  return {
    id: run.id,
    dayLabel: dayLabel(run.run_on),
    summary: run.summary ?? (run.status === 'running' ? 'En curso…' : 'Sin resumen.'),
    statusLabel: status.label,
    statusTone: status.tone,
    href: `/piloto/${run.id}`,
    done: run.done_count,
    asked: run.asked_count,
  };
}

/** «Hoy a las 7:00 a. m.», «Mañana…», «El lunes…», o por qué no corre. */
export function nextRunLabel(settings: AutopilotSettings, today: string, hourNow: number): string {
  if (!settings.enabled) return 'Apagado: no corre hasta que lo enciendas.';
  for (let offset = 0; offset < 14; offset++) {
    const [y, m, d] = today.split('-').map(Number);
    const day = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + offset, 12))
      .toISOString()
      .slice(0, 10);
    if (offset === 0 && hourNow >= settings.runHour) continue;
    if (!runGate(settings, day).run) continue;
    const when = offset === 0 ? 'Hoy' : offset === 1 ? 'Mañana' : `El ${dayLabel(day)}`;
    return `${when} a las ${hourLabel(settings.runHour)}`;
  }
  return 'No hay ningún día de corrida en las próximas dos semanas.';
}

export function buildSettingsView(
  settings: AutopilotSettings,
  opts: { today: string; hourNow: number; actorLabel: string | null },
): SettingsView {
  return {
    enabled: settings.enabled,
    runHour: settings.runHour,
    runDays: settings.runDays,
    skipHolidays: settings.skipHolidays,
    quietDays: settings.quietDays,
    maxExternalMessages: settings.maxExternalMessages,
    maxAmountReferenced: settings.maxAmountReferenced,
    maxActionsPerRun: settings.maxActionsPerRun,
    notifyEmail: settings.notifyEmail,
    currency: settings.currency,
    areas: AUTOPILOT_AREAS.map((area) => ({
      area,
      label: AREA_LABEL[area],
      hint: AREA_HINT[area],
      level: settings.areaLevels[area],
      levels: AUTOPILOT_LEVELS.map((level) => ({
        level,
        label: LEVEL_LABEL[level],
        disabled: area === 'pagos' && level === 'hacer',
      })),
    })),
    scheduleLabel: `${hourLabel(settings.runHour)}, ${daysLabel(settings.runDays)}${settings.skipHolidays ? ', sin festivos' : ''}`,
    nextRunLabel: nextRunLabel(settings, opts.today, opts.hourNow),
    actorLabel: opts.actorLabel,
  };
}
