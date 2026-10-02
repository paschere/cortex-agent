import { formatDay, formatMoney, isoWeekday, toDay } from '../ledger/forecast-shared';
import {
  MIN_SAMPLE,
  MIN_TEAM,
  type PersonStatsOptions,
  awayWorkingDays,
  byGender,
  countOf,
  formatCount,
  holidaysIn,
  isDoneIn,
  isOpenAt,
  isOverdueAt,
  periodLength,
  personStats,
  pluralType,
  previousPeriod,
  snapshotDay,
  teamBaselines,
  typeNoun,
  workTypesOf,
} from './metrics';
import { detectSignals } from './signals';
import type {
  PersonWorkStats,
  TeamWorkReport,
  WorkItem,
  WorkPeriod,
  WorkPerson,
  WorkSignal,
} from './types';

/**
 * EL REPORTE DEL EQUIPO Y «MI SEMANA».
 *
 * `buildTeamReport` junta todo: las cifras de cada persona (en total y por tipo
 * de trabajo), las del período anterior del mismo largo, las medianas del
 * equipo, las señales y los límites dichos en palabras (`notes`). Las personas
 * van en orden alfabético, nunca por una cifra: el reporte no es un ranking.
 *
 * `describePerson` le habla a la persona (tú): lo que cerró, lo que la espera,
 * lo que mejoró. Tono de apoyo: sus propios números, sin compararla con nadie
 * salvo para reconocerle algo.
 *
 * Puro y determinista, como metrics.ts y signals.ts.
 */

export interface TeamReportInput {
  items: readonly WorkItem[];
  people: readonly WorkPerson[];
  period: WorkPeriod;
  /** Por defecto: el período del mismo largo inmediatamente anterior. */
  previous?: WorkPeriod | null;
  /** «Hoy», si el período no ha terminado. */
  asOf?: string | null;
  /** Descontar festivos de Colombia. Por defecto sí. */
  holidays?: boolean;
}

function byName(a: WorkPerson, b: WorkPerson): number {
  return a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id);
}

function normalize(period: WorkPeriod): WorkPeriod {
  return { from: toDay(period.from), to: toDay(period.to) };
}

/** «semana del 28 sep» si es lunes a domingo; si no, «del 1 sep al 15 sep». */
export function periodLabel(period: WorkPeriod): string {
  const p = normalize(period);
  if (periodLength(p) === 7 && isoWeekday(p.from) === 1)
    return `la semana del ${formatDay(p.from)}`;
  return `del ${formatDay(p.from)} al ${formatDay(p.to)}`;
}

export function buildTeamReport(input: TeamReportInput): TeamWorkReport {
  const period = normalize(input.period);
  const previous = normalize(input.previous ?? previousPeriod(period));
  const people = [...input.people].sort(byName);
  const types = workTypesOf(input.items);
  const opts: PersonStatsOptions = { asOf: input.asOf ?? null, holidays: input.holidays };
  const prevOpts: PersonStatsOptions = { holidays: input.holidays };

  const current: PersonWorkStats[] = [];
  const before: PersonWorkStats[] = [];
  const entries: TeamWorkReport['people'] = [];
  for (const person of people) {
    const all = personStats(input.items, person, period, 'all', opts);
    const prevAll = personStats(input.items, person, previous, 'all', prevOpts);
    current.push(all);
    before.push(prevAll);
    const byType: PersonWorkStats[] = [];
    for (const t of types) {
      const s = personStats(input.items, person, period, t, opts);
      current.push(s);
      before.push(personStats(input.items, person, previous, t, prevOpts));
      if (s.sample > 0) byType.push(s);
    }
    entries.push({
      person,
      current: all,
      previous: prevAll.sample > 0 ? prevAll : null,
      byType,
    });
  }

  const baselines = teamBaselines(current);
  const signals = detectSignals({
    current,
    previous: before,
    baselines,
    items: input.items,
    people,
    period,
    asOf: input.asOf ?? null,
  });

  return {
    period,
    previous,
    people: entries,
    baselines,
    signals,
    notes: reportNotes(input, period, previous, entries, baselines),
    ...(input.asOf ? { asOf: toDay(input.asOf) } : {}),
  };
}

function reportNotes(
  input: TeamReportInput,
  period: WorkPeriod,
  previous: WorkPeriod,
  entries: TeamWorkReport['people'],
  baselines: TeamWorkReport['baselines'],
): string[] {
  const notes: string[] = [];
  const cut = snapshotDay(period, input.asOf);
  const known = new Set(input.people.map((p) => p.id));

  notes.push(
    `Cada persona se compara primero con su propio período anterior (${formatDay(
      previous.from,
    )} a ${formatDay(previous.to)}) y después con la mediana del equipo en el mismo tipo de trabajo, por día trabajable. No hay nota única ni ranking.`,
  );

  if (cut < period.to) {
    notes.push(
      `El período sigue en curso: la foto es al ${formatDay(cut)} y los días trabajables cuentan hasta ese día.`,
    );
  }

  const holidays = input.holidays === false ? [] : holidaysIn(period.from, cut);
  notes.push(
    holidays.length
      ? `Días trabajables: lunes a viernes, menos festivos de Colombia (${holidays
          .map(formatDay)
          .join(', ')}) y los días fuera de cada persona.`
      : 'Días trabajables: lunes a viernes, menos festivos de Colombia y los días fuera de cada persona.',
  );

  const away = entries
    .map((e) => ({
      name: e.person.name,
      days: awayWorkingDays(e.person, period.from, cut, { holidays: input.holidays }).length,
    }))
    .filter((a) => a.days > 0);
  if (away.length) {
    notes.push(
      `Días fuera descontados (no cuentan en contra): ${away
        .map((a) => `${a.name} (${countOf(a.days, 'día', 'días')})`)
        .join(', ')}.`,
    );
  }

  const doneInPeriod = input.items.filter((i) => isDoneIn(i, period.from, cut));
  const noDue = doneInPeriod.filter((i) => !i.dueAt).length;
  if (noDue > 0) {
    notes.push(
      `Sin vencimiento no se mide a tiempo: ${formatCount(noDue)} de ${formatCount(
        doneInPeriod.length,
      )} cerrados en el período no tenían fecha y no entran en la tasa de a tiempo.`,
    );
  }

  const small = entries.filter((e) => e.current.sample < MIN_SAMPLE);
  if (small.length) {
    notes.push(
      `Menos de ${MIN_SAMPLE} ítems: no se compara. Sus cifras se muestran tal cual: ${small
        .map((e) => `${e.person.name} (${countOf(e.current.sample, 'ítem', 'ítems')})`)
        .join(', ')}.`,
    );
  }
  const noHistory = entries.filter((e) => e.previous === null && e.current.sample > 0);
  if (noHistory.length) {
    notes.push(
      `Sin historia en el período anterior, no hay contra qué comparar a: ${noHistory
        .map((e) => e.person.name)
        .join(', ')}.`,
    );
  }

  const thinTypes = baselines.filter((b) => b.workType !== 'all' && b.people < MIN_TEAM);
  if (thinTypes.length) {
    notes.push(
      `Con menos de ${MIN_TEAM} personas en un tipo de trabajo, nadie se destaca contra la mediana del equipo: ${thinTypes
        .map((b) => `${pluralType(b.workType)} (${countOf(b.people, 'persona', 'personas')})`)
        .join(', ')}.`,
    );
  }

  const unassigned = input.items.filter((i) => i.assigneeId === null && isOpenAt(i, cut)).length;
  if (unassigned > 0) {
    notes.push(
      `${countOf(unassigned, 'abierto', 'abiertos')} sin responsable: no ${unassigned === 1 ? 'cuenta' : 'cuentan'} para nadie (ver «sin responsable»).`,
    );
  }
  const strangers = input.items.filter((i) => i.assigneeId && !known.has(i.assigneeId)).length;
  if (strangers > 0) {
    notes.push(
      `${countOf(strangers, 'ítem asignado', 'ítems asignados')} a alguien que no está en el equipo: no se miden.`,
    );
  }
  const doneNoDate = input.items.filter((i) => i.status === 'done' && !i.doneAt).length;
  if (doneNoDate > 0) {
    notes.push(
      `${countOf(doneNoDate, 'marcado como hecho', 'marcados como hechos')} sin fecha de cierre: no se sabe cuándo, así que no cuentan.`,
    );
  }
  const cancelled = input.items.filter((i) => i.status === 'cancelled').length;
  if (cancelled > 0) {
    notes.push(`Lo cancelado (${formatCount(cancelled)}) no cuenta en contra de nadie.`);
  }
  notes.push(
    'Se mide trabajo registrado (tareas, casos, cobros, despachos), no personas: nunca el contenido de chats o correos. Lo que no se registra aquí no aparece.',
  );
  return notes;
}

// ---------------------------------------------------------------------------
// «Mi semana»
// ---------------------------------------------------------------------------

function outputPhrase(output: Record<string, number>): string | null {
  const parts = Object.keys(output)
    .sort((a, b) => a.localeCompare(b, 'es'))
    .map((unit) => {
      const v = output[unit] ?? 0;
      return unit.toUpperCase() === 'COP' ? formatMoney(v) : `${formatCount(v)} ${unit}`;
    });
  return parts.length ? parts.join(', ') : null;
}

function recognition(signal: WorkSignal): string | null {
  const e = signal.evidence;
  const type = pluralType(signal.workType ?? '');
  const n = (k: string) => (typeof e[k] === 'number' ? (e[k] as number) : null);
  if (signal.kind === 'improving') {
    const bits: string[] = [];
    const rn = n('donePerDayNow');
    const rb = n('donePerDayBefore');
    if (rn !== null && rb !== null)
      bits.push(`cierras ${formatCount(rn)} por día (antes ${formatCount(rb)})`);
    const on = n('onTimePctNow');
    const ob = n('onTimePctBefore');
    if (on !== null && ob !== null) bits.push(`${on}% a tiempo (antes ${ob}%)`);
    const cn = n('cycleHoursNow');
    const cb = n('cycleHoursBefore');
    if (cn !== null && cb !== null)
      bits.push(
        `tardas ${formatCount(cn)} horas en cerrar ${byGender(signal.workType ?? null, 'uno', 'una')} (antes ${formatCount(cb)})`,
      );
    return bits.length ? `Mejoraste en ${type}: ${bits.join('; ')}.` : null;
  }
  if (signal.kind === 'standout') {
    const rn = n('donePerDayNow');
    const tm = n('teamMedianDonePerDay');
    if (rn !== null && tm !== null)
      return `En ${type} cerraste ${formatCount(rn)} por día; la mediana del equipo es ${formatCount(tm)}.`;
    const on = n('onTimePctNow');
    const tp = n('teamMedianOnTimePct');
    if (on !== null && tp !== null)
      return `En ${type} cerraste a tiempo el ${on}%; la mediana del equipo es ${tp}%.`;
  }
  return null;
}

/**
 * Un párrafo corto para «Mi semana» de una persona: sus cifras, lo que la
 * espera y lo que mejoró. Con `items`, nombra lo primero que la espera.
 */
export function describePerson(
  report: TeamWorkReport,
  personId: string,
  items?: readonly WorkItem[],
): string {
  const entry = report.people.find((e) => e.person.id === personId);
  if (!entry) return 'No hay trabajo registrado a tu nombre en este período.';
  const { current: s, byType } = entry;
  const label = periodLabel(report.period);
  const cut = snapshotDay(report.period, report.asOf);
  const parts: string[] = [];

  const away = awayWorkingDays(entry.person, report.period.from, cut).length;
  const awayText = away ? `; ${countOf(away, 'día fuera no cuenta', 'días fuera no cuentan')}` : '';
  if (s.workingDays === 0 && away > 0) {
    parts.push(
      `En ${label} estuviste fuera todos los días trabajables: nada de esto cuenta en contra.`,
    );
  } else if (s.done === 0) {
    parts.push(
      `En ${label} no cerraste ítems registrados, en ${countOf(
        s.workingDays,
        'día trabajable',
        'días trabajables',
      )}${awayText}.`,
    );
  } else {
    const doneTypes = byType.filter((t) => t.done > 0);
    const split =
      doneTypes.length > 1
        ? ` (${doneTypes.map((t) => `${pluralType(t.workType)} ${formatCount(t.done)}`).join(', ')})`
        : doneTypes[0]
          ? ` ${typeNoun(doneTypes[0].workType, doneTypes[0].done)}`
          : '';
    parts.push(
      `En ${label} cerraste ${formatCount(s.done)}${split} en ${countOf(
        s.workingDays,
        'día trabajable',
        'días trabajables',
      )}${awayText}.`,
    );
  }

  if (s.onTimeRate !== null && (s.withDue ?? 0) > 0) {
    const withDue = s.withDue ?? 0;
    const onTime = Math.round(s.onTimeRate * withDue);
    parts.push(
      `De los que tenían fecha, ${formatCount(onTime)} de ${formatCount(withDue)} a tiempo (${Math.round(
        s.onTimeRate * 100,
      )}%).`,
    );
  }

  const produced = outputPhrase(s.output);
  if (produced) parts.push(`Lo producido: ${produced}.`);

  if (s.openNow > 0) {
    let waiting = `Te ${s.openNow === 1 ? 'espera' : 'esperan'} ${countOf(
      s.openNow,
      'abierto',
      'abiertos',
    )}${s.overdueNow ? `, ${formatCount(s.overdueNow)} ya ${s.overdueNow === 1 ? 'vencido' : 'vencidos'}` : ''}.`;
    if (items) {
      const first = items
        .filter((i) => i.assigneeId === personId && isOpenAt(i, cut))
        .sort(
          (a, b) =>
            Number(isOverdueAt(b, cut)) - Number(isOverdueAt(a, cut)) ||
            (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') ||
            a.openedAt.localeCompare(b.openedAt) ||
            a.id.localeCompare(b.id),
        )
        .slice(0, 2)
        .map((i) => `«${i.title}»`);
      if (first.length) waiting += ` Lo primero: ${first.join(' y ')}.`;
    }
    parts.push(waiting);
  } else {
    parts.push('No tienes nada abierto esperándote.');
  }

  const mine = report.signals.filter((g) => g.personId === personId);
  for (const g of mine) {
    const r = recognition(g);
    if (r) parts.push(r);
  }
  for (const g of mine) {
    const type = pluralType(g.workType ?? '');
    if (g.kind === 'overloaded') {
      parts.push(
        `En ${type} tienes más abiertos que la mayoría del equipo (${formatCount(
          Number(g.evidence.openNow),
        )}; la mediana es ${formatCount(Number(g.evidence.teamMedianOpen))}): se sugirió repartir, no es un reclamo.`,
      );
    } else if (g.kind === 'slowing') {
      parts.push(
        `En ${type} cerraste ${formatCount(Number(g.evidence.donePerDayNow))} por día (antes ${formatCount(
          Number(g.evidence.donePerDayBefore),
        )}). Si algo te está frenando, dilo y se busca cómo ayudarte.`,
      );
    }
  }

  if (entry.previous === null && s.sample > 0) {
    parts.push(
      'Todavía no hay un período anterior tuyo para comparar: esto es sólo la foto de hoy.',
    );
  } else if (s.sample > 0 && s.sample < MIN_SAMPLE) {
    parts.push(
      `Con ${countOf(s.sample, 'ítem', 'ítems')}, estas cifras son una foto, no una comparación.`,
    );
  } else if (entry.previous && !mine.some((g) => g.kind === 'improving' || g.kind === 'slowing')) {
    parts.push(
      `El período anterior: ${formatCount(entry.previous.done)} cerrados en ${countOf(
        entry.previous.workingDays,
        'día trabajable',
        'días trabajables',
      )}.`,
    );
  }

  return parts.join(' ');
}
