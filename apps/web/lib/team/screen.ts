import {
  MIN_SAMPLE,
  type PersonWorkStats,
  type TeamBaseline,
  type TeamWorkReport,
  type WorkItem,
  type WorkPeriod,
  type WorkPerson,
  type WorkSignal,
  type WorkSignalKind,
  describePerson,
  personStats,
} from '@cortex/agent-tools';
import {
  PERIOD_OPTIONS,
  type PeriodKey,
  SOURCE_LABEL,
  type Trend,
  addDaysIso,
  bogotaDay,
  canMarkDone,
  daysBetweenIso,
  formatHours,
  formatNumber,
  formatOutput,
  formatPct,
  initials,
  isReassignable,
  mondayOfIso,
  rangeLabel,
  recognitionPrompt,
  shortDay,
  sourcePath,
  supportPrompt,
  trendOf,
} from './shape';

/**
 * DEL REPORTE DEL EQUIPO A LO QUE PINTAN LAS PANTALLAS DE «EQUIPO».
 *
 * Entra el `TeamWorkReport` del motor puro (work/report.ts) con los ítems que
 * lo respaldan; sale un modelo serializable, con las cifras ya escritas y los
 * enlaces ya armados, que los componentes de components/team sólo dibujan.
 * Así la pantalla real y la de prueba (/v/equipo-showcase) son la misma.
 *
 * Tres reglas que este archivo hace cumplir y no los componentes:
 *   - Nadie se ordena por una cifra: las personas van en el orden alfabético
 *     del reporte y no hay puntaje.
 *   - Cada cifra se compara primero con el período anterior de la MISMA
 *     persona (las flechas) y después, en voz baja, con la mediana del equipo
 *     en el mismo tipo de trabajo. Con menos de `MIN_SAMPLE` ítems no hay
 *     flechas: se dice que es una foto.
 *   - Quien no ve a todo el equipo no recibe señales con nombre de otros, ni
 *     lo que no tiene responsable, ni las notas del reporte (nombran gente).
 */

export type WorkItemLike = WorkItem & { assigneeLabel?: string | null };

export interface TeamHrefs {
  team(q: { periodo: PeriodKey; tipo: string | null }): string;
  person(id: string, q?: { periodo: PeriodKey }): string;
  me(q?: { periodo: PeriodKey }): string;
  settings: string;
  people: string;
  activity: string | null;
  chat(prompt: string): string;
  source(path: string): string;
}

export interface MetricCell {
  key: 'abiertos' | 'vencidos' | 'cerrados' | 'a_tiempo' | 'ciclo';
  label: string;
  value: string;
  /** Lo que aclara la cifra: «1,8 por día», «7 de 9». */
  sub: string | null;
  trend: Trend | null;
  /** La mediana del equipo en el mismo tipo, escrita. */
  team: string | null;
  attention: boolean;
}

export interface OutputCell {
  unit: string;
  value: string;
  trend: Trend | null;
}

export interface PersonCardModel {
  id: string;
  name: string;
  initials: string;
  team: string | null;
  role: string | null;
  awayToday: boolean;
  awayInPeriod: number;
  href: string | null;
  metrics: MetricCell[];
  output: OutputCell[];
  sample: number;
  note: string | null;
  empty: boolean;
}

export interface ItemRowModel {
  id: string;
  title: string;
  workType: string;
  owner: string | null;
  status: WorkItem['status'];
  dueOn: string | null;
  dueLabel: string | null;
  overdue: boolean;
  ageDays: number;
  sourceLabel: string;
  sourceHref: string | null;
  canMarkDone: boolean;
}

export interface MoveModel {
  toId: string;
  toName: string;
  toOpen: number;
  items: Array<{ id: string; title: string; overdue: boolean }>;
}

export interface SignalCardModel {
  key: string;
  kind: WorkSignalKind;
  severity: WorkSignal['severity'];
  tone: 'rose' | 'amber' | 'sky' | 'emerald';
  title: string;
  personId: string | null;
  personName: string | null;
  workType: string | null;
  message: string;
  suggestion: string | null;
  evidence: Array<{ label: string; value: string }>;
  items: ItemRowModel[];
  moreItems: number;
  moves: MoveModel[];
  /** Ítems de la señal que no se pasan desde aquí (Gerencia, aprobaciones). */
  blocked: number;
  writeHref: string | null;
  personHref: string | null;
}

export interface UnassignedModel {
  count: number;
  overdue: number;
  byType: Array<{ workType: string; count: number }>;
  items: ItemRowModel[];
  more: number;
  signal: SignalCardModel | null;
}

export interface Choice {
  key: string;
  label: string;
  href: string;
  active: boolean;
}

export interface PeriodModel {
  key: PeriodKey;
  label: string;
  range: string;
  from: string;
  to: string;
  ongoing: boolean;
}

export interface TeamScreen {
  period: PeriodModel;
  periods: Choice[];
  types: Choice[];
  workType: string | null;
  seesAll: boolean;
  canReassign: boolean;
  canConfigure: boolean;
  attention: SignalCardModel[];
  recognitions: SignalCardModel[];
  people: PersonCardModel[];
  /** Con un tipo elegido: quienes no tuvieron ese trabajo. */
  withoutType: string[];
  unassigned: UnassignedModel | null;
  notes: string[];
  empty: boolean;
  truncated: boolean;
  links: { me: string; settings: string; people: string; activity: string | null };
}

const KIND_TITLE: Record<WorkSignalKind, string> = {
  overloaded: 'Mucha carga',
  overdue_pile: 'Vencidos acumulados',
  slowing: '¿Algo frenando?',
  unassigned_pile: 'Sin responsable',
  stale_item: 'Quietos hace rato',
  improving: 'Mejoró',
  standout: 'Destaca',
};

const RECOGNITION: ReadonlySet<WorkSignalKind> = new Set(['improving', 'standout']);

/** Las cifras de la evidencia que vale la pena mostrar, con su nombre. */
const EVIDENCE_LABEL: Record<string, string> = {
  openNow: 'abiertos',
  overdueNow: 'vencidos',
  teamMedianOpen: 'mediana del equipo',
  unassigned: 'sin responsable',
  overdue: 'vencidos',
  oldestDays: 'días el más viejo',
  donePerDayBefore: 'por día antes',
  donePerDayNow: 'por día ahora',
  onTimePctBefore: '% a tiempo antes',
  onTimePctNow: '% a tiempo ahora',
  cycleHoursBefore: 'horas de ciclo antes',
  cycleHoursNow: 'horas de ciclo ahora',
  teamMedianDonePerDay: 'mediana del equipo por día',
  teamMedianOnTimePct: '% a tiempo del equipo',
  stale: 'quietos',
};

// ---------------------------------------------------------------------------
// Piezas
// ---------------------------------------------------------------------------

function periodModel(key: PeriodKey, report: TeamWorkReport): PeriodModel {
  const label = PERIOD_OPTIONS.find((o) => o.key === key)?.label ?? 'Esta semana';
  return {
    key,
    label,
    range: rangeLabel(report.period),
    from: report.period.from,
    to: report.period.to,
    ongoing: Boolean(report.asOf && report.asOf < report.period.to),
  };
}

function cutOf(report: TeamWorkReport): string {
  return report.asOf && report.asOf < report.period.to ? report.asOf : report.period.to;
}

function baselineFor(report: TeamWorkReport, workType: string | null): TeamBaseline | null {
  const b = report.baselines.find((x) => x.workType === (workType ?? 'all'));
  return b && b.people >= 2 ? b : null;
}

const perDay = (s: PersonWorkStats): number | null =>
  s.workingDays > 0 ? Math.round((s.done / s.workingDays) * 10) / 10 : null;

/** Las cinco cifras de una persona, cada una contra su propio período anterior. */
export function metricCells(
  s: PersonWorkStats,
  prev: PersonWorkStats | null,
  baseline: TeamBaseline | null,
): MetricCell[] {
  const compare = Boolean(prev && prev.sample > 0 && s.sample >= MIN_SAMPLE);
  const p = compare ? prev : null;
  const rate = perDay(s);
  const withDue = s.withDue ?? 0;
  const pct = (r: number | null) => (r === null ? null : Math.round(r * 100));
  return [
    {
      key: 'abiertos',
      label: 'Abiertos',
      value: formatNumber(s.openNow),
      sub: null,
      trend: p ? trendOf(s.openNow, p.openNow, 'none') : null,
      team: baseline ? formatNumber(Math.round(baseline.medianOpen * 10) / 10) : null,
      attention: false,
    },
    {
      key: 'vencidos',
      label: 'Vencidos',
      value: formatNumber(s.overdueNow),
      sub: null,
      trend: p ? trendOf(s.overdueNow, p.overdueNow, 'down') : null,
      team: null,
      // Fuera todo el período: lo vencido se informa, pero no se marca en rojo.
      attention: s.overdueNow > 0 && s.workingDays > 0,
    },
    {
      key: 'cerrados',
      label: 'Cerrados',
      value: formatNumber(s.done),
      sub: rate === null ? null : `${formatNumber(rate)} por día`,
      trend: p
        ? trendOf(rate, perDay(p as PersonWorkStats), 'up', (n) => `${formatNumber(n)}/día`)
        : null,
      team: baseline
        ? `${formatNumber(Math.round(baseline.medianDonePerDay * 10) / 10)}/día`
        : null,
      attention: false,
    },
    {
      key: 'a_tiempo',
      label: 'A tiempo',
      value: formatPct(s.onTimeRate),
      sub:
        s.onTimeRate !== null && withDue > 0
          ? `${formatNumber(Math.round(s.onTimeRate * withDue))} de ${formatNumber(withDue)}`
          : 'sin fechas',
      trend: p ? trendOf(pct(s.onTimeRate), pct(p.onTimeRate), 'up', (n) => `${n}%`) : null,
      team:
        baseline && baseline.medianOnTimeRate !== null
          ? formatPct(baseline.medianOnTimeRate)
          : null,
      attention: false,
    },
    {
      key: 'ciclo',
      label: 'Tiempo de cierre',
      value: formatHours(s.medianCycleHours),
      sub: s.medianCycleHours === null ? null : 'lo típico',
      trend: p ? trendOf(s.medianCycleHours, p.medianCycleHours, 'down', formatHours) : null,
      team:
        baseline && baseline.medianCycleHours !== null
          ? formatHours(baseline.medianCycleHours)
          : null,
      attention: false,
    },
  ];
}

export function outputCells(s: PersonWorkStats, prev: PersonWorkStats | null): OutputCell[] {
  const compare = Boolean(prev && prev.sample > 0 && s.sample >= MIN_SAMPLE);
  return Object.keys(s.output)
    .sort((a, b) => a.localeCompare(b, 'es'))
    .map((unit) => {
      const v = s.output[unit] ?? 0;
      const before = compare ? (prev?.output[unit] ?? 0) : null;
      return {
        unit,
        value: formatOutput(unit, v),
        trend: before === null ? null : trendOf(v, before, 'up', (n) => formatOutput(unit, n)),
      };
    });
}

function awayIn(person: WorkPerson, from: string, to: string): number {
  return (person.awayDays ?? []).filter((d) => d >= from && d <= to).length;
}

function sampleNote(s: PersonWorkStats, prev: PersonWorkStats | null, away: number): string | null {
  if (s.workingDays === 0 && away > 0)
    return 'Estuvo fuera todo el período: nada de esto cuenta en contra.';
  if (s.sample === 0) return 'Sin trabajo registrado en este período.';
  if (s.sample < MIN_SAMPLE)
    return `Pocos ítems (${s.sample}): las cifras son una foto, sin comparar.`;
  if (!prev || prev.sample === 0) return 'Sin período anterior para comparar todavía.';
  return null;
}

function sortOpen(a: ItemRowModel, b: ItemRowModel): number {
  return (
    Number(b.overdue) - Number(a.overdue) ||
    (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') ||
    b.ageDays - a.ageDays ||
    a.title.localeCompare(b.title, 'es') ||
    a.id.localeCompare(b.id)
  );
}

export function itemRow(
  i: WorkItemLike,
  ctx: { today: string; names: ReadonlyMap<string, string>; viewerId: string; hrefs: TeamHrefs },
): ItemRowModel {
  const due = bogotaDay(i.dueAt);
  const opened = bogotaDay(i.openedAt) ?? ctx.today;
  const overdue = i.status === 'open' && due !== null && due < ctx.today;
  const path = sourcePath(i);
  return {
    id: i.id,
    title: i.title,
    workType: i.workType,
    owner: i.assigneeId
      ? (ctx.names.get(i.assigneeId) ?? 'Alguien que ya no está')
      : i.assigneeLabel
        ? `${i.assigneeLabel} (sin cuenta)`
        : null,
    status: i.status,
    dueOn: due,
    dueLabel: due
      ? overdue
        ? `venció el ${shortDay(due)}`
        : due === ctx.today
          ? 'vence hoy'
          : `vence el ${shortDay(due)}`
      : null,
    overdue,
    ageDays: Math.max(0, daysBetweenIso(opened, ctx.today)),
    sourceLabel: SOURCE_LABEL[i.source.kind] ?? 'Registro',
    sourceHref: path ? ctx.hrefs.source(path) : null,
    canMarkDone: canMarkDone(i, ctx.viewerId),
  };
}

/**
 * Las movidas que sugiere una señal, ya con ítems concretos: a quién (de la
 * evidencia: `receiverN`, `receiverNTake`) y cuáles. Primero lo más urgente
 * (vence antes, lleva más tiempo), y nunca lo que no se pasa desde aquí.
 */
export function planMoves(
  signal: WorkSignal,
  people: readonly WorkPerson[],
  itemsById: ReadonlyMap<string, WorkItemLike>,
  today: string,
): { moves: MoveModel[]; blocked: number } {
  const ids = signal.itemIds ?? [];
  const items = ids.map((id) => itemsById.get(id)).filter((i): i is WorkItemLike => Boolean(i));
  const open = items.filter((i) => i.status === 'open');
  const blocked = open.filter((i) => !isReassignable(i)).length;
  const pool = open
    .filter(isReassignable)
    .sort(
      (a, b) =>
        (bogotaDay(a.dueAt) ?? '9999').localeCompare(bogotaDay(b.dueAt) ?? '9999') ||
        a.openedAt.localeCompare(b.openedAt) ||
        a.id.localeCompare(b.id),
    );
  const moves: MoveModel[] = [];
  const e = signal.evidence;
  for (let n = 1; n <= 6 && pool.length; n++) {
    const name = e[`receiver${n}`];
    const take = Number(e[`receiver${n}Take`]);
    if (typeof name !== 'string' || !Number.isFinite(take) || take <= 0) continue;
    const person = people.find((p) => p.name === name && p.id !== signal.personId);
    if (!person) continue;
    const chosen = pool.splice(0, take);
    if (!chosen.length) continue;
    moves.push({
      toId: person.id,
      toName: person.name,
      toOpen: Number(e[`receiver${n}Open`]) || 0,
      items: chosen.map((i) => {
        const due = bogotaDay(i.dueAt);
        return { id: i.id, title: i.title, overdue: due !== null && due < today };
      }),
    });
  }
  return { moves, blocked };
}

function evidenceList(signal: WorkSignal): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const [key, label] of Object.entries(EVIDENCE_LABEL)) {
    const v = signal.evidence[key];
    if (typeof v === 'number') out.push({ label, value: formatNumber(v) });
  }
  return out.slice(0, 6);
}

function signalCard(
  signal: WorkSignal,
  index: number,
  ctx: {
    report: TeamWorkReport;
    itemsById: ReadonlyMap<string, WorkItemLike>;
    names: ReadonlyMap<string, string>;
    today: string;
    viewerId: string;
    hrefs: TeamHrefs;
    canReassign: boolean;
    periodKey: PeriodKey;
  },
): SignalCardModel {
  const recognition = RECOGNITION.has(signal.kind);
  const personName = signal.personId ? (ctx.names.get(signal.personId) ?? null) : null;
  const rows = (signal.itemIds ?? [])
    .map((id) => ctx.itemsById.get(id))
    .filter((i): i is WorkItemLike => Boolean(i))
    .map((i) => itemRow(i, ctx))
    .sort(sortOpen);
  const plan =
    ctx.canReassign && (signal.kind === 'overloaded' || signal.kind === 'unassigned_pile')
      ? planMoves(
          signal,
          ctx.report.people.map((p) => p.person),
          ctx.itemsById,
          ctx.today,
        )
      : { moves: [], blocked: 0 };
  const context = [signal.message, signal.suggestion].filter(Boolean).join(' ');
  return {
    key: `${signal.kind}:${signal.personId ?? '-'}:${signal.workType ?? '-'}:${index}`,
    kind: signal.kind,
    severity: signal.severity,
    tone: recognition
      ? 'emerald'
      : signal.severity === 'critical'
        ? 'rose'
        : signal.severity === 'warn'
          ? 'amber'
          : 'sky',
    title: KIND_TITLE[signal.kind],
    personId: signal.personId ?? null,
    personName,
    workType: signal.workType ?? null,
    message: signal.message,
    suggestion: signal.suggestion ?? null,
    evidence: evidenceList(signal),
    items: rows.slice(0, 8),
    moreItems: Math.max(0, rows.length - 8),
    moves: plan.moves,
    blocked: plan.blocked,
    writeHref:
      personName && signal.personId
        ? ctx.hrefs.chat(
            recognition
              ? recognitionPrompt(personName, signal.message)
              : supportPrompt(personName, context),
          )
        : null,
    personHref: signal.personId
      ? ctx.hrefs.person(signal.personId, { periodo: ctx.periodKey })
      : null,
  };
}

// ---------------------------------------------------------------------------
// /team
// ---------------------------------------------------------------------------

export interface TeamScreenInput {
  report: TeamWorkReport;
  items: readonly WorkItemLike[];
  periodKey: PeriodKey;
  workType: string | null;
  today: string;
  viewer: {
    id: string;
    /** Ve a todo el equipo: administra o es dueño de la empresa. */
    seesAll: boolean;
    /** Puede pasar trabajo de otros (`org_admin`, la regla de work.assign). */
    canReassign: boolean;
    canConfigure: boolean;
  };
  /** Personas visibles; `null` = todas (y lo sin responsable). */
  visibleIds: ReadonlySet<string> | null;
  truncated?: boolean;
  hrefs: TeamHrefs;
}

export function buildTeamScreen(input: TeamScreenInput): TeamScreen {
  const { report, items, periodKey, today, hrefs } = input;
  const seesAll = input.viewer.seesAll || input.visibleIds === null;
  const canSee = (id: string | null | undefined) =>
    seesAll ? true : Boolean(id && input.visibleIds?.has(id));
  const types = report.baselines
    .filter((b) => b.workType !== 'all')
    .map((b) => b.workType)
    .sort((a, b) => a.localeCompare(b, 'es'));
  const workType = input.workType && types.includes(input.workType) ? input.workType : null;
  const names = new Map(report.people.map((e) => [e.person.id, e.person.name]));
  const itemsById = new Map(items.map((i) => [i.id, i]));
  const cut = cutOf(report);
  const ctx = {
    report,
    itemsById,
    names,
    today,
    viewerId: input.viewer.id,
    hrefs,
    canReassign: input.viewer.canReassign,
    periodKey,
  };

  const baseline = baselineFor(report, workType);
  const people: PersonCardModel[] = [];
  const withoutType: string[] = [];
  for (const entry of report.people) {
    const { person } = entry;
    if (!canSee(person.id)) continue;
    const s = workType ? entry.byType.find((x) => x.workType === workType) : entry.current;
    if (!s) {
      withoutType.push(person.name);
      continue;
    }
    const prevRaw = workType
      ? personStats(items, person, report.previous, workType)
      : entry.previous;
    const prev = prevRaw && prevRaw.sample > 0 ? prevRaw : null;
    const away = awayIn(person, report.period.from, cut);
    people.push({
      id: person.id,
      name: person.name,
      initials: initials(person.name),
      team: person.team ?? null,
      role: person.role ?? null,
      awayToday: (person.awayDays ?? []).includes(today),
      awayInPeriod: away,
      href: hrefs.person(person.id, { periodo: periodKey }),
      metrics: metricCells(s, prev, baseline),
      output: outputCells(s, prev),
      sample: s.sample,
      note: sampleNote(s, prev, away),
      empty: s.sample === 0,
    });
  }

  const matchesType = (g: WorkSignal) => !workType || !g.workType || g.workType === workType;
  const signals = seesAll
    ? report.signals.filter(matchesType)
    : report.signals.filter((g) => matchesType(g) && g.personId === input.viewer.id);
  const cards = signals.map((g, i) => signalCard(g, i, ctx));
  const attention = cards.filter((c) => !RECOGNITION.has(c.kind) && c.kind !== 'unassigned_pile');
  const recognitions = cards.filter((c) => RECOGNITION.has(c.kind));

  let unassigned: UnassignedModel | null = null;
  if (seesAll) {
    const open = items.filter(
      (i) => i.assigneeId === null && i.status === 'open' && (!workType || i.workType === workType),
    );
    const rows = open.map((i) => itemRow(i, ctx)).sort(sortOpen);
    const byType = new Map<string, number>();
    for (const i of open) byType.set(i.workType, (byType.get(i.workType) ?? 0) + 1);
    unassigned = {
      count: open.length,
      overdue: rows.filter((r) => r.overdue).length,
      byType: [...byType]
        .map(([t, count]) => ({ workType: t, count }))
        .sort((a, b) => a.workType.localeCompare(b.workType, 'es')),
      items: rows.slice(0, 10),
      more: Math.max(0, rows.length - 10),
      signal: cards.find((c) => c.kind === 'unassigned_pile') ?? null,
    };
  }

  return {
    period: periodModel(periodKey, report),
    periods: PERIOD_OPTIONS.map((o) => ({
      key: o.key,
      label: o.label,
      href: hrefs.team({ periodo: o.key, tipo: workType }),
      active: o.key === periodKey,
    })),
    types: [
      {
        key: '',
        label: 'Todo el trabajo',
        href: hrefs.team({ periodo: periodKey, tipo: null }),
        active: workType === null,
      },
      ...types.map((t) => ({
        key: t,
        label: t.charAt(0).toUpperCase() + t.slice(1),
        href: hrefs.team({ periodo: periodKey, tipo: t }),
        active: t === workType,
      })),
    ],
    workType,
    seesAll,
    canReassign: input.viewer.canReassign,
    canConfigure: input.viewer.canConfigure,
    attention,
    recognitions,
    people,
    withoutType,
    unassigned,
    notes: seesAll ? report.notes : [],
    empty: items.length === 0,
    truncated: Boolean(input.truncated),
    links: {
      me: hrefs.me({ periodo: periodKey }),
      settings: hrefs.settings,
      people: hrefs.people,
      activity: hrefs.activity,
    },
  };
}

// ---------------------------------------------------------------------------
// /team/[persona] y /team/yo
// ---------------------------------------------------------------------------

export interface WeekPoint {
  from: string;
  label: string;
  done: number;
  open: number;
  overdue: number;
  current: boolean;
}

export interface TypeSection {
  workType: string | null;
  label: string;
  metrics: MetricCell[];
  output: OutputCell[];
  note: string | null;
  weeks: WeekPoint[];
}

export interface PersonScreen {
  self: boolean;
  person: {
    id: string;
    name: string;
    firstName: string;
    initials: string;
    team: string | null;
    role: string | null;
    awayToday: boolean;
    awayDays: string[];
  };
  period: PeriodModel;
  periods: Choice[];
  description: string;
  improved: string[];
  sections: TypeSection[];
  open: ItemRowModel[];
  openTotal: number;
  overdueTotal: number;
  doneTotal: number;
  canEditAway: boolean;
  today: string;
  links: { team: string | null; write: string | null; me: string };
}

/** Ocho semanas (lunes a domingo) que terminan en la de `today`. */
export function weeklySeries(
  items: readonly WorkItem[],
  person: WorkPerson,
  workType: string | 'all',
  today: string,
  weeks = 8,
): WeekPoint[] {
  const monday = mondayOfIso(today);
  const out: WeekPoint[] = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const from = addDaysIso(monday, -7 * k);
    const period: WorkPeriod = { from, to: addDaysIso(from, 6) };
    const current = k === 0;
    const s = personStats(items, person, period, workType, current ? { asOf: today } : {});
    out.push({
      from,
      label: shortDay(from),
      done: s.done,
      open: s.openNow,
      overdue: s.overdueNow,
      current,
    });
  }
  return out;
}

/** Lo que mejoró contra su propio período anterior, en segunda persona. Sin muestra, nada. */
export function improvements(s: PersonWorkStats, prev: PersonWorkStats | null): string[] {
  if (!prev || prev.sample === 0 || s.sample < MIN_SAMPLE) return [];
  const out: string[] = [];
  const now = perDay(s);
  const before = perDay(prev);
  if (now !== null && before !== null && before > 0 && now >= before * 1.1)
    out.push(`Cierras ${formatNumber(now)} por día (antes ${formatNumber(before)}).`);
  if (s.onTimeRate !== null && prev.onTimeRate !== null && s.onTimeRate - prev.onTimeRate >= 0.05)
    out.push(`A tiempo: ${formatPct(s.onTimeRate)} (antes ${formatPct(prev.onTimeRate)}).`);
  if (
    s.medianCycleHours !== null &&
    prev.medianCycleHours !== null &&
    s.medianCycleHours <= prev.medianCycleHours * 0.9
  )
    out.push(
      `Cierras en ${formatHours(s.medianCycleHours)} (antes ${formatHours(prev.medianCycleHours)}).`,
    );
  if (s.overdueNow < prev.overdueNow)
    out.push(
      `Tienes ${formatNumber(s.overdueNow)} vencidos (antes ${formatNumber(prev.overdueNow)}).`,
    );
  return out;
}

export interface PersonScreenInput {
  report: TeamWorkReport;
  /** El trabajo de esta persona desde hace ocho semanas (para las tendencias). */
  history: readonly WorkItemLike[];
  personId: string;
  periodKey: PeriodKey;
  today: string;
  viewer: { id: string; seesAll: boolean; canEditAway: boolean };
  hrefs: TeamHrefs;
  /** Para /team/yo: los enlaces de período apuntan a «Mi semana». */
  mode?: 'person' | 'self';
  /** Si la persona no está en el reporte (sin directorio aún), se pinta vacía con esto. */
  fallback?: WorkPerson;
}

export function buildPersonScreen(input: PersonScreenInput): PersonScreen | null {
  const { report, history, personId, today, hrefs, periodKey } = input;
  const entry =
    report.people.find((e) => e.person.id === personId) ??
    (input.fallback
      ? {
          person: input.fallback,
          current: personStats([], input.fallback, report.period, 'all', {
            asOf: report.asOf ?? null,
          }),
          previous: null,
          byType: [],
        }
      : null);
  if (!entry) return null;
  const { person } = entry;
  const self = input.viewer.id === personId;
  const names = new Map(report.people.map((e) => [e.person.id, e.person.name]));
  const ctx = { today, names, viewerId: input.viewer.id, hrefs };
  const cut = cutOf(report);

  const mine = history.filter((i) => i.assigneeId === personId);
  const typesSeen = [
    ...new Set([...entry.byType.map((s) => s.workType), ...mine.map((i) => i.workType)]),
  ].sort((a, b) => a.localeCompare(b, 'es'));

  const section = (workType: string | null): TypeSection => {
    const s =
      workType === null
        ? entry.current
        : (entry.byType.find((x) => x.workType === workType) ??
          personStats(mine, person, report.period, workType, {
            asOf: report.asOf ?? null,
          }));
    const prevRaw =
      workType === null ? entry.previous : personStats(mine, person, report.previous, workType);
    const prev = prevRaw && prevRaw.sample > 0 ? prevRaw : null;
    return {
      workType,
      label:
        workType === null
          ? 'Todo el trabajo'
          : workType.charAt(0).toUpperCase() + workType.slice(1),
      metrics: metricCells(s, prev, baselineFor(report, workType)),
      output: outputCells(s, prev),
      note: sampleNote(s, prev, awayIn(person, report.period.from, cut)),
      weeks: weeklySeries(mine, person, workType ?? 'all', today),
    };
  };

  const open = mine
    .filter((i) => i.status === 'open')
    .map((i) => itemRow(i, ctx))
    .sort(sortOpen);
  const firstName = person.name.split(/\s+/)[0] ?? person.name;
  const mySignals = report.signals.filter(
    (g) => g.personId === personId && !RECOGNITION.has(g.kind),
  );
  const context = mySignals.map((g) => g.message).join(' ') || `${entry.current.openNow} abiertos.`;
  const periodsHref = (key: PeriodKey) =>
    input.mode === 'self' ? hrefs.me({ periodo: key }) : hrefs.person(personId, { periodo: key });

  return {
    self,
    person: {
      id: person.id,
      name: person.name,
      firstName,
      initials: initials(person.name),
      team: person.team ?? null,
      role: person.role ?? null,
      awayToday: (person.awayDays ?? []).includes(today),
      awayDays: [...(person.awayDays ?? [])].sort(),
    },
    period: periodModel(periodKey, report),
    periods: PERIOD_OPTIONS.map((o) => ({
      key: o.key,
      label: o.label,
      href: periodsHref(o.key),
      active: o.key === periodKey,
    })),
    description: describePerson(report, personId, mine),
    improved: improvements(entry.current, entry.previous),
    sections: [section(null), ...(typesSeen.length > 1 ? typesSeen.map(section) : [])],
    open: open.slice(0, 60),
    openTotal: open.length,
    overdueTotal: open.filter((r) => r.overdue).length,
    doneTotal: entry.current.done,
    canEditAway: input.viewer.canEditAway,
    today,
    links: {
      team: input.viewer.seesAll ? hrefs.team({ periodo: periodKey, tipo: null }) : null,
      write: !self && input.viewer.seesAll ? hrefs.chat(supportPrompt(person.name, context)) : null,
      me: hrefs.me({ periodo: periodKey }),
    },
  };
}
