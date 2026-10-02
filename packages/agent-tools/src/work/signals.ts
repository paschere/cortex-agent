import { median, toDay } from '../ledger/forecast-shared';
import {
  MIN_SAMPLE,
  MIN_TEAM,
  MIN_WORKING_DAYS,
  agree,
  byGender,
  countOf,
  cycleHours,
  donePerDay,
  formatCount,
  hoursUntilSnapshot,
  idleHours,
  instantMs,
  isDoneIn,
  isOpenAt,
  isOverdueAt,
  pluralType,
  round1,
  snapshotDay,
  typeNoun,
} from './metrics';
import type {
  PersonWorkStats,
  TeamBaseline,
  WorkItem,
  WorkPeriod,
  WorkPerson,
  WorkSignal,
  WorkSignalKind,
} from './types';

/**
 * LAS SEÑALES: LO QUE VALE LA PENA MIRAR, CON SU EVIDENCIA.
 *
 * De las cifras (metrics.ts) a frases cortas en español, cada una con las
 * cifras que la respaldan (`evidence`) y algo concreto que se podría hacer
 * (`suggestion`). Reglas y plantillas, sin modelo: lo que dice una señal se
 * puede auditar número por número.
 *
 * ===========================================================================
 * LAS REGLAS
 * ===========================================================================
 *   overloaded       Abiertos ≥ máx(2 × mediana del equipo, mediana + 5) en
 *                    ESE tipo de trabajo (al menos 2 personas en el tipo).
 *                    Sugiere a quién pasarle cuántos: los de menor carga en
 *                    el mismo tipo, que no estén fuera, con su número.
 *                    warn; critical si ≥ 3 × mediana y ≥ mediana + 10, o si
 *                    la mitad o más de lo abierto ya venció.
 *   overdue_pile     Vencidos ≥ 5, o ≥ 3 y ≥ 50% de lo abierto (todos los
 *                    tipos). warn; critical si ≥ 10, o ≥ 5 y ≥ 50%.
 *   slowing          Cerrados por día trabajable bajaron ≥ 40% contra SU
 *                    período anterior, mismo tipo; el anterior con ≥ 8
 *                    cerrados, los dos con ≥ 3 días trabajables y algo
 *                    esperando (si no queda nada abierto, llegó menos trabajo:
 *                    no es frenarse). Siempre info, y como pregunta.
 *   improving        Contra su propia historia, mismo tipo, ≥ 8 cerrados en
 *                    ambos períodos: cerrados por día +40%, o a tiempo +20
 *                    puntos (≥ 8 con vencimiento en ambos), o ciclo −30%. Lo
 *                    de más cerrados no cuenta si el a tiempo cayó > 10 puntos.
 *                    info.
 *   standout         Sólo si no hubo `improving` (la propia historia va
 *                    primero). Contra la mediana del equipo (≥ 3 personas),
 *                    con ≥ 8 cerrados: ≥ 1,5 × la mediana de cerrados por día
 *                    sin estar por debajo en a tiempo, o ≥ 95% a tiempo
 *                    cuando la mediana es ≤ 80%. info.
 *   unassigned_pile  ≥ 5 abiertos sin responsable en un tipo. warn; critical
 *                    si ≥ 15 o si 5 o más ya vencieron.
 *   stale_item       Abiertos quietos (desde `lastActivityAt` o, si no hay,
 *                    desde que se abrieron) más del doble de la mediana de
 *                    ciclo de su tipo (mínimo 24 horas; la mediana necesita
 *                    ≥ 5 cerrados entre este período y el anterior). Una
 *                    señal por tipo con los más quietos. info; warn si son
 *                    ≥ 5 o alguno ya venció.
 *
 * ===========================================================================
 * CADA NÚMERO, EN LA EVIDENCIA
 * ===========================================================================
 * Todo número escrito en `message` o `suggestion` está también en `evidence`,
 * con el mismo redondeo (porcentajes como enteros: «60%» ↔ 60). Así un
 * chequeo de números puede verificar la frase sin leer el registro. Los
 * títulos de los ítems (que pueden traer números: «Pedido 4512») van en la
 * evidencia como texto.
 *
 * Nunca se ordena a las personas por una cifra única ni se resume a alguien en
 * un puntaje: cada señal es un hecho con su número y su contexto.
 */

export interface SignalInput {
  /** Cifras del período: cada persona en 'all' y en cada tipo. */
  current: readonly PersonWorkStats[];
  /** Las mismas, del período anterior (para la propia historia). */
  previous: readonly PersonWorkStats[];
  baselines: readonly TeamBaseline[];
  items: readonly WorkItem[];
  people: readonly WorkPerson[];
  /** El período actual; si falta, el de `current`. */
  period?: WorkPeriod;
  /** «Hoy», si el período no ha terminado. */
  asOf?: string | null;
}

// Umbrales (los mismos que dice el encabezado y docs/features/team-work.md).
export const OVERLOAD_FACTOR = 2;
export const OVERLOAD_MARGIN = 5;
export const OVERDUE_PILE = 5;
export const OVERDUE_SHARE = 0.5;
export const OVERDUE_SHARE_MIN = 3;
export const SLOWING_DROP = 0.4;
export const IMPROVING_RISE = 0.4;
export const IMPROVING_ON_TIME = 0.2;
export const IMPROVING_CYCLE = 0.3;
export const STANDOUT_FACTOR = 1.5;
export const UNASSIGNED_PILE = 5;
export const STALE_FACTOR = 2;
export const STALE_MIN_HOURS = 24;
export const STALE_MIN_BASE = 5;
export const STALE_LIST = 3;

const SEVERITY_ORDER = { critical: 0, warn: 1, info: 2 } as const;
const KIND_ORDER: Record<WorkSignalKind, number> = {
  overloaded: 0,
  overdue_pile: 1,
  unassigned_pile: 2,
  stale_item: 3,
  slowing: 4,
  improving: 5,
  standout: 6,
};

const pct = (fraction: number) => Math.round(fraction * 100);

interface Ctx {
  input: SignalInput;
  cut: string;
  period: WorkPeriod;
  names: Map<string, string>;
  awayToday: Set<string>;
  doers: Map<string, Set<string>>;
  current: Map<string, PersonWorkStats>;
  previous: Map<string, PersonWorkStats>;
  baselines: Map<string, TeamBaseline>;
}

const key = (personId: string, workType: string) => `${personId}|${workType}`;

function context(input: SignalInput): Ctx | null {
  const period = input.period ?? input.current[0]?.period;
  if (!period) return null;
  const cut = snapshotDay(period, input.asOf);
  const names = new Map(input.people.map((p) => [p.id, p.name.trim() || p.id]));
  const awayToday = new Set(
    input.people.filter((p) => (p.awayDays ?? []).map(toDay).includes(cut)).map((p) => p.id),
  );
  // Quién hace cada tipo de trabajo: tuvo alguna vez un ítem de ese tipo.
  const doers = new Map<string, Set<string>>();
  for (const i of input.items) {
    if (!i.assigneeId || !names.has(i.assigneeId)) continue;
    const set = doers.get(i.workType) ?? new Set<string>();
    set.add(i.assigneeId);
    doers.set(i.workType, set);
  }
  return {
    input,
    cut,
    period,
    names,
    awayToday,
    doers,
    current: new Map(input.current.map((s) => [key(s.personId, s.workType), s])),
    previous: new Map(input.previous.map((s) => [key(s.personId, s.workType), s])),
    baselines: new Map(input.baselines.map((b) => [b.workType, b])),
  };
}

function nameOf(ctx: Ctx, personId: string | null): string {
  if (!personId) return 'sin responsable';
  return ctx.names.get(personId) ?? personId;
}

function sortedPeople(ctx: Ctx): WorkPerson[] {
  return [...ctx.input.people].sort(
    (a, b) => a.name.localeCompare(b.name, 'es') || a.id.localeCompare(b.id),
  );
}

/**
 * A quién se le puede pasar trabajo de un tipo: hace ese tipo, no está fuera
 * hoy, tuvo días para trabajar. Primero quien menos abiertos tiene.
 */
function receivers(
  ctx: Ctx,
  workType: string,
  exclude: string | null,
): Array<{ id: string; name: string; open: number }> {
  const doers = ctx.doers.get(workType) ?? new Set<string>();
  return sortedPeople(ctx)
    .filter((p) => p.id !== exclude && doers.has(p.id) && !ctx.awayToday.has(p.id))
    .map((p) => ({ p, s: ctx.current.get(key(p.id, workType)) }))
    .filter(({ s }) => s !== undefined && s.workingDays > 0)
    .map(({ p, s }) => ({ id: p.id, name: nameOf(ctx, p.id), open: s?.openNow ?? 0 }))
    .sort((a, b) => a.open - b.open || a.name.localeCompare(b.name, 'es'));
}

/**
 * Reparte hasta `n` ítems de uno en uno, siempre a quien menos tiene (contando
 * lo ya recibido). Si vienen de una persona (`sourceOpen`), se para cuando
 * pasar uno más ya no empareja: nadie termina con más que quien los cede.
 * Si vienen de la pila sin responsable (`null`), se reparten todos.
 */
function waterFill(
  pool: Array<{ id: string; name: string; open: number }>,
  n: number,
  sourceOpen: number | null,
): Array<{ id: string; name: string; open: number; take: number }> {
  const plan = pool.map((r) => ({ ...r, take: 0 }));
  let given = 0;
  while (given < n && plan.length) {
    let best = plan[0];
    for (const r of plan) {
      if (best && r.open + r.take < best.open + best.take) best = r;
    }
    if (!best) break;
    if (sourceOpen !== null && sourceOpen - given - 1 < best.open + best.take + 1) break;
    best.take++;
    given++;
  }
  return plan.filter((r) => r.take > 0);
}

/** «Reasignar 5 a Andrés (tiene 3 despachos pendientes) y 3 a Sofía (tiene 4)». */
function shareSentence(
  verb: string,
  workType: string,
  plan: Array<{ name: string; open: number; take: number }>,
  evidence: Record<string, number | string>,
): string {
  const parts = plan.map((r, idx) => {
    const n = idx + 1;
    evidence[`receiver${n}`] = r.name;
    evidence[`receiver${n}Open`] = r.open;
    evidence[`receiver${n}Take`] = r.take;
    const has =
      idx === 0
        ? `${formatCount(r.open)} ${typeNoun(workType, r.open)} ${
            r.open === 1 ? 'pendiente' : 'pendientes'
          }`
        : formatCount(r.open);
    return `${formatCount(r.take)} a ${r.name} (tiene ${has})`;
  });
  const joined =
    parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} y ${parts.at(-1)}`;
  return `${verb} ${joined}.`;
}

// ---------------------------------------------------------------------------
// Las reglas, una por una
// ---------------------------------------------------------------------------

function overloaded(ctx: Ctx): WorkSignal[] {
  const out: WorkSignal[] = [];
  for (const b of ctx.input.baselines) {
    if (b.workType === 'all' || b.people < 2) continue;
    const threshold = Math.max(OVERLOAD_FACTOR * b.medianOpen, b.medianOpen + OVERLOAD_MARGIN);
    const type = pluralType(b.workType);
    for (const p of sortedPeople(ctx)) {
      const s = ctx.current.get(key(p.id, b.workType));
      if (!s || s.openNow < threshold || s.openNow === 0) continue;
      const medianOpen = round1(b.medianOpen);
      const evidence: Record<string, number | string> = {
        person: p.name,
        workType: b.workType,
        openNow: s.openNow,
        overdueNow: s.overdueNow,
        teamMedianOpen: medianOpen,
        threshold: round1(threshold),
        teamPeople: b.people,
      };
      const away = ctx.awayToday.has(p.id);
      if (away) evidence.awayToday = 'sí';
      const message = `${p.name} tiene ${formatCount(s.openNow)} ${type} ${agree(
        'abierto',
        b.workType,
        s.openNow,
      )}, ${formatCount(s.overdueNow)} ${agree('vencido', b.workType, s.overdueNow)}; la mediana del equipo en ${type} es ${formatCount(medianOpen)}${
        away ? ' (y hoy está fuera)' : ''
      }.`;

      const excess = s.openNow - Math.ceil(b.medianOpen);
      const pool = receivers(ctx, b.workType, p.id);
      const below = pool.filter((r) => r.open <= b.medianOpen).slice(0, 2);
      const chosen = below.length ? below : pool.filter((r) => r.open < s.openNow / 2).slice(0, 1);
      const plan = waterFill(chosen, excess, s.openNow);
      let suggestion: string;
      if (plan.length) {
        const total = plan.reduce((sum, r) => sum + r.take, 0);
        evidence.reassign = total;
        suggestion = shareSentence('Reasignar', b.workType, plan, evidence);
      } else {
        suggestion = `Nadie más en ${type} tiene espacio hoy: revisar prioridades con ${p.name} y qué puede esperar.`;
      }

      const critical =
        (s.openNow >= 3 * b.medianOpen && s.openNow >= b.medianOpen + 10) ||
        s.overdueNow * 2 >= s.openNow;
      out.push({
        kind: 'overloaded',
        personId: p.id,
        workType: b.workType,
        severity: critical ? 'critical' : 'warn',
        message,
        evidence,
        suggestion,
        itemIds: openItems(ctx, p.id, b.workType).map((i) => i.id),
      });
    }
  }
  return out;
}

/** Abiertos al corte, los vencidos primero (más viejo primero), luego por apertura. */
function openItems(ctx: Ctx, assigneeId: string | null, workType: string | 'all'): WorkItem[] {
  return ctx.input.items
    .filter(
      (i) =>
        i.assigneeId === assigneeId &&
        (workType === 'all' || i.workType === workType) &&
        isOpenAt(i, ctx.cut),
    )
    .sort(
      (a, b) =>
        (a.dueAt ?? '9999').localeCompare(b.dueAt ?? '9999') ||
        a.openedAt.localeCompare(b.openedAt) ||
        a.id.localeCompare(b.id),
    );
}

function overduePile(ctx: Ctx): WorkSignal[] {
  const out: WorkSignal[] = [];
  for (const p of sortedPeople(ctx)) {
    const s = ctx.current.get(key(p.id, 'all'));
    if (!s || s.openNow === 0) continue;
    const share = s.overdueNow / s.openNow;
    const byCount = s.overdueNow >= OVERDUE_PILE;
    const byShare = s.overdueNow >= OVERDUE_SHARE_MIN && share >= OVERDUE_SHARE;
    if (!byCount && !byShare) continue;
    const overdue = openItems(ctx, p.id, 'all').filter((i) => isOverdueAt(i, ctx.cut));
    const away = ctx.awayToday.has(p.id);
    const evidence: Record<string, number | string> = {
      person: p.name,
      overdueNow: s.overdueNow,
      openNow: s.openNow,
      overduePct: pct(share),
    };
    if (away) evidence.awayToday = 'sí';
    out.push({
      kind: 'overdue_pile',
      personId: p.id,
      workType: null,
      severity: s.overdueNow >= 10 || (byCount && share >= OVERDUE_SHARE) ? 'critical' : 'warn',
      message: `${p.name} tiene ${formatCount(s.overdueNow)} vencidos de ${formatCount(
        s.openNow,
      )} abiertos (${pct(share)}%)${away ? ', y hoy está fuera' : ''}.`,
      evidence,
      suggestion: away
        ? `Mientras ${p.name} está fuera, que alguien cubra los vencidos o se avise a quien espera.`
        : `Revisar con ${p.name} cuáles se cierran ya, cuáles necesitan otra fecha y cuáles puede tomar alguien más.`,
      itemIds: overdue.map((i) => i.id),
    });
  }
  return out;
}

function slowingAndRecognition(ctx: Ctx): WorkSignal[] {
  const out: WorkSignal[] = [];
  for (const p of sortedPeople(ctx)) {
    for (const s of ctx.input.current) {
      if (s.personId !== p.id || s.workType === 'all') continue;
      const prev = ctx.previous.get(key(p.id, s.workType)) ?? null;
      const type = pluralType(s.workType);
      const rateNow = donePerDay(s);
      const ratePrev = prev ? donePerDay(prev) : null;
      const comparable =
        prev !== null &&
        rateNow !== null &&
        ratePrev !== null &&
        ratePrev > 0 &&
        prev.done >= MIN_SAMPLE &&
        s.workingDays >= MIN_WORKING_DAYS &&
        prev.workingDays >= MIN_WORKING_DAYS;

      // --- slowing --------------------------------------------------------
      if (comparable && prev && rateNow !== null && ratePrev !== null) {
        const drop = 1 - rateNow / ratePrev;
        if (drop >= SLOWING_DROP && s.openNow > 0) {
          const before = round1(ratePrev);
          const now = round1(rateNow);
          out.push({
            kind: 'slowing',
            personId: p.id,
            workType: s.workType,
            severity: 'info',
            message: `${byGender(s.workType, 'Los', 'Las')} ${type} que cierra ${p.name} bajaron de ${formatCount(
              before,
            )} a ${formatCount(now)} por día trabajable (${formatCount(prev.done)} en ${countOf(
              prev.workingDays,
              'día',
              'días',
            )}, ahora ${formatCount(s.done)} en ${countOf(
              s.workingDays,
              'día',
              'días',
            )}) y tiene ${formatCount(s.openNow)} esperando. ¿Hay algo frenando a ${p.name}?`,
            evidence: {
              person: p.name,
              workType: s.workType,
              donePerDayBefore: before,
              donePerDayNow: now,
              doneBefore: prev.done,
              workingDaysBefore: prev.workingDays,
              doneNow: s.done,
              workingDaysNow: s.workingDays,
              openNow: s.openNow,
              dropPct: pct(drop),
            },
            suggestion:
              'Preguntar antes de concluir: un bloqueo, trabajo que no se registra aquí, o algo que haga falta. Si es carga, repartir.',
          });
        }
      }

      // --- improving (contra su propia historia) ---------------------------
      const phrases: string[] = [];
      const evidence: Record<string, number | string> = { person: p.name, workType: s.workType };
      if (prev && prev.done >= MIN_SAMPLE && s.done >= MIN_SAMPLE) {
        const onTimeFell =
          s.onTimeRate !== null &&
          prev.onTimeRate !== null &&
          (s.withDue ?? 0) >= MIN_SAMPLE &&
          (prev.withDue ?? 0) >= MIN_SAMPLE &&
          prev.onTimeRate - s.onTimeRate > 0.1;
        if (
          comparable &&
          rateNow !== null &&
          ratePrev !== null &&
          rateNow >= ratePrev * (1 + IMPROVING_RISE) &&
          !onTimeFell
        ) {
          evidence.donePerDayBefore = round1(ratePrev);
          evidence.donePerDayNow = round1(rateNow);
          phrases.push(
            `cierra ${formatCount(round1(rateNow))} por día trabajable (antes ${formatCount(
              round1(ratePrev),
            )})`,
          );
        }
        if (
          s.onTimeRate !== null &&
          prev.onTimeRate !== null &&
          (s.withDue ?? 0) >= MIN_SAMPLE &&
          (prev.withDue ?? 0) >= MIN_SAMPLE &&
          s.onTimeRate - prev.onTimeRate >= IMPROVING_ON_TIME
        ) {
          evidence.onTimePctBefore = pct(prev.onTimeRate);
          evidence.onTimePctNow = pct(s.onTimeRate);
          phrases.push(`${pct(s.onTimeRate)}% a tiempo (antes ${pct(prev.onTimeRate)}%)`);
        }
        if (
          s.medianCycleHours !== null &&
          prev.medianCycleHours !== null &&
          prev.medianCycleHours > 0 &&
          s.medianCycleHours <= prev.medianCycleHours * (1 - IMPROVING_CYCLE)
        ) {
          evidence.cycleHoursBefore = round1(prev.medianCycleHours);
          evidence.cycleHoursNow = round1(s.medianCycleHours);
          phrases.push(
            `tarda ${formatCount(round1(s.medianCycleHours))} horas en cerrar ${byGender(
              s.workType,
              'uno',
              'una',
            )} (antes ${formatCount(round1(prev.medianCycleHours))})`,
          );
        }
      }
      if (phrases.length) {
        evidence.doneNow = s.done;
        evidence.doneBefore = prev?.done ?? 0;
        out.push({
          kind: 'improving',
          personId: p.id,
          workType: s.workType,
          severity: 'info',
          message: `${p.name} mejoró en ${type} frente a su período anterior: ${phrases.join(
            '; ',
          )}. Con ${formatCount(s.done)} cerrados ahora y ${formatCount(prev?.done ?? 0)} antes.`,
          evidence,
          suggestion:
            'Reconocérselo. Si cambió algo en cómo trabaja, puede servirle al resto del equipo.',
        });
        continue;
      }

      // --- standout (contra la mediana del equipo) -------------------------
      const b = ctx.baselines.get(s.workType);
      if (!b || b.people < MIN_TEAM || s.done < MIN_SAMPLE || s.workingDays < MIN_WORKING_DAYS)
        continue;
      const notBehindOnTime =
        s.onTimeRate === null || b.medianOnTimeRate === null || s.onTimeRate >= b.medianOnTimeRate;
      const st: Record<string, number | string> = {
        person: p.name,
        workType: s.workType,
        doneNow: s.done,
        teamPeople: b.people,
      };
      let message: string | null = null;
      if (
        rateNow !== null &&
        b.medianDonePerDay > 0 &&
        rateNow >= STANDOUT_FACTOR * b.medianDonePerDay &&
        notBehindOnTime
      ) {
        st.donePerDayNow = round1(rateNow);
        st.teamMedianDonePerDay = round1(b.medianDonePerDay);
        message = `${p.name} cerró ${formatCount(round1(rateNow))} ${type} por día trabajable (${formatCount(
          s.done,
        )} en total); la mediana del equipo es ${formatCount(round1(b.medianDonePerDay))}`;
        if (s.onTimeRate !== null && (s.withDue ?? 0) > 0) {
          st.onTimePctNow = pct(s.onTimeRate);
          message += `, con ${pct(s.onTimeRate)}% a tiempo`;
        }
        message += '.';
      } else if (
        s.onTimeRate !== null &&
        b.medianOnTimeRate !== null &&
        (s.withDue ?? 0) >= MIN_SAMPLE &&
        s.onTimeRate >= 0.95 &&
        b.medianOnTimeRate <= 0.8
      ) {
        st.onTimePctNow = pct(s.onTimeRate);
        st.teamMedianOnTimePct = pct(b.medianOnTimeRate);
        st.withDue = s.withDue ?? 0;
        message = `${p.name} cerró a tiempo el ${pct(s.onTimeRate)}% de sus ${type} con fecha (${formatCount(
          s.withDue ?? 0,
        )}); la mediana del equipo es ${pct(b.medianOnTimeRate)}%.`;
      }
      if (message) {
        out.push({
          kind: 'standout',
          personId: p.id,
          workType: s.workType,
          severity: 'info',
          message,
          evidence: st,
          suggestion: `Reconocérselo, y preguntarle qué le funciona: puede servirle al resto en ${type}.`,
        });
      }
    }
  }
  return out;
}

function unassignedPile(ctx: Ctx): WorkSignal[] {
  const out: WorkSignal[] = [];
  const types = [...new Set(ctx.input.items.map((i) => i.workType))].sort((a, b) =>
    a.localeCompare(b, 'es'),
  );
  for (const workType of types) {
    const open = openItems(ctx, null, workType);
    if (open.length < UNASSIGNED_PILE) continue;
    const type = pluralType(workType);
    const overdue = open.filter((i) => isOverdueAt(i, ctx.cut)).length;
    const oldestOpened = [...open].sort((a, b) => a.openedAt.localeCompare(b.openedAt))[0];
    const oldestDays = oldestOpened
      ? Math.floor((hoursUntilSnapshot(oldestOpened.openedAt, ctx.cut) ?? 0) / 24)
      : 0;
    const evidence: Record<string, number | string> = {
      workType,
      unassigned: open.length,
      overdue,
      oldestDays,
    };
    const pool = receivers(ctx, workType, null).slice(0, 2);
    const plan = waterFill(pool, open.length, null);
    out.push({
      kind: 'unassigned_pile',
      personId: null,
      workType,
      severity: open.length >= 15 || overdue >= 5 ? 'critical' : 'warn',
      message: `Hay ${formatCount(open.length)} ${type} sin responsable, ${formatCount(
        overdue,
      )} ya ${agree('vencido', workType, overdue)}; ${byGender(
        workType,
        'el más viejo',
        'la más vieja',
      )} lleva ${countOf(oldestDays, 'día', 'días')} ${agree('abierto', workType, 1)}.`,
      evidence,
      suggestion: plan.length
        ? shareSentence(
            byGender(workType, 'Repartirlos:', 'Repartirlas:'),
            workType,
            plan,
            evidence,
          )
        : `Nadie en el equipo ha tenido ${type}: definir quién responde por ${byGender(
            workType,
            'ellos',
            'ellas',
          )}.`,
      itemIds: open.map((i) => i.id),
    });
  }
  return out;
}

function staleItems(ctx: Ctx): WorkSignal[] {
  const out: WorkSignal[] = [];
  const from = ctx.input.previous[0]?.period.from ?? ctx.period.from;
  const types = [...new Set(ctx.input.items.map((i) => i.workType))].sort((a, b) =>
    a.localeCompare(b, 'es'),
  );
  for (const workType of types) {
    const ofType = ctx.input.items.filter((i) => i.workType === workType);
    const cycles = ofType
      .filter((i) => isDoneIn(i, from < ctx.period.from ? from : ctx.period.from, ctx.cut))
      .map(cycleHours)
      .filter((h): h is number => h !== null);
    if (cycles.length < STALE_MIN_BASE) continue;
    const typical = round1(median(cycles));
    const threshold = Math.max(STALE_MIN_HOURS, Math.round(STALE_FACTOR * typical));
    // Más de tres días se dice en días («5,8 días»), menos en horas.
    const inDays = threshold >= 72;
    const shown = (hours: number) => (inDays ? round1(hours / 24) : round1(hours));
    const unit = inDays ? 'días' : 'horas';
    const stale = ofType
      .filter((i) => isOpenAt(i, ctx.cut))
      .map((i) => ({ i, idle: idleHours(i, ctx.cut) ?? 0 }))
      .filter((x) => x.idle > threshold)
      .sort(
        (a, b) =>
          b.idle - a.idle ||
          instantMs(a.i.openedAt) - instantMs(b.i.openedAt) ||
          a.i.id.localeCompare(b.i.id),
      );
    if (!stale.length) continue;
    const type = pluralType(workType);
    const top = stale.slice(0, STALE_LIST);
    const stillestDays = Math.floor((top[0]?.idle ?? 0) / 24);
    const anyOverdue = stale.some((x) => isOverdueAt(x.i, ctx.cut));
    const evidence: Record<string, number | string> = {
      workType,
      stale: stale.length,
      thresholdHours: threshold,
      typicalCycleHours: typical,
      [inDays ? 'thresholdDays' : 'thresholdShown']: shown(threshold),
      [inDays ? 'typicalCycleDays' : 'typicalShown']: shown(typical),
      cycleSample: cycles.length,
      stillestDays,
    };
    const listed = top.map((x, idx) => {
      evidence[`item${idx + 1}`] = x.i.title;
      evidence[`item${idx + 1}Owner`] = nameOf(ctx, x.i.assigneeId);
      return `«${x.i.title}» (${nameOf(ctx, x.i.assigneeId)})`;
    });
    const n = stale.length;
    out.push({
      kind: 'stale_item',
      personId: null,
      workType,
      severity: n >= 5 || anyOverdue ? 'warn' : 'info',
      message: `${formatCount(n)} ${typeNoun(workType, n)} ${
        n === 1 ? 'lleva' : 'llevan'
      } más de ${formatCount(shown(threshold))} ${unit} sin moverse (cerrar ${byGender(
        workType,
        'uno',
        'una',
      )} suele tardar ${formatCount(shown(typical))} ${unit}); ${byGender(
        workType,
        'el más quieto',
        'la más quieta',
      )}, ${countOf(stillestDays, 'día', 'días')}.`,
      evidence,
      suggestion: `Revisar si siguen vigentes: cerrar, cancelar o pedir ayuda. Empezar por ${listed.join(
        ', ',
      )}.`,
      itemIds: stale.map((x) => x.i.id),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Todas juntas
// ---------------------------------------------------------------------------

/** Las señales del período, ordenadas: gravedad, tipo de señal, persona, tipo de trabajo. */
export function detectSignals(input: SignalInput): WorkSignal[] {
  const ctx = context(input);
  if (!ctx) return [];
  const all = [
    ...overloaded(ctx),
    ...overduePile(ctx),
    ...unassignedPile(ctx),
    ...staleItems(ctx),
    ...slowingAndRecognition(ctx),
  ];
  return all.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      nameOf(ctx, a.personId ?? null).localeCompare(nameOf(ctx, b.personId ?? null), 'es') ||
      (a.workType ?? '').localeCompare(b.workType ?? '', 'es'),
  );
}
