import {
  type FollowEvidence,
  type OutcomeEvidence,
  type RecommendationOutcome,
  type RecommendationRecord,
  type RecommendationStatus,
  UNMEASURABLE_KINDS,
} from './shape';

/**
 * ¿SE SIGUIÓ? ¿Y QUÉ PASÓ DESPUÉS? — CON EVIDENCIA, Y NADA MÁS QUE «DESPUÉS».
 *
 * Para cada recomendación se miran dos cosas, por separado y en este orden:
 *
 *   1. SEGUIMIENTO. ¿Hay un hecho que la cumpla, posterior a ella? Un cobro a
 *      ese cliente que salió aprobado, una reasignación del trabajo de esa
 *      persona, una rutina que alguien cambió. Si lo hay: `followed`, con el
 *      hecho y su fecha. Si está a medias (el cobro redactado, sin aprobar):
 *      `in_progress`. Si pasó una semana sin nada: `not_followed`. Antes de
 *      eso, sigue `open` — no se acusa a nadie de ignorar un consejo de ayer.
 *
 *   2. DESENLACE. ¿Qué cifra se movió después? El pago de ese cliente en los
 *      treinta días siguientes, los vencidos de esa persona hoy contra los del
 *      día de la recomendación, la alerta de caja que ya no aparece. `good`,
 *      `none` o `worse`; `pending` mientras la ventana siga abierta.
 *
 * LO QUE ESTO NUNCA DICE es que una cosa causó la otra. Nexa pudo pagar porque
 * ya iba a pagar. Por eso el desenlace se mide aunque la recomendación NO se
 * haya seguido («no se envió el cobro; igual pagó»): es la única manera honesta
 * de que la tasa de acierto no se atribuya lo que habría pasado de todos modos.
 * Y por eso la frase final dice «después de», nunca «gracias a».
 *
 * CONSERVADOR EN LA DUDA. Un cliente se empareja por su nombre normalizado
 * completo dentro del texto del cobro, no por una palabra suelta; un nombre de
 * menos de tres letras no empareja nada. Un hecho anterior a la recomendación
 * no la cumple. Una fecha ilegible no cuenta.
 *
 * Puro: la recomendación y una bolsa de hechos ya leídos entran; el veredicto
 * sale. La bolsa la arma store.ts una vez por empresa.
 */

/** Días sin un solo hecho para declarar que no se siguió. */
export const FOLLOW_GRACE_DAYS = 7;
/** Días en los que se busca el desenlace (el pago, la baja de vencidos). */
export const OUTCOME_WINDOW_DAYS = 30;
/** Pasado esto, la recomendación ya no se vuelve a evaluar. */
export const EVALUATION_HORIZON_DAYS = 40;

const DAY_MS = 86_400_000;

export interface CollectionFact {
  id: string;
  state: string;
  createdAt: string;
  executedAt: string | null;
  /** El envío salió bien. */
  sentOk: boolean;
  /** Asunto, destinatario y razón, normalizados con `subjectKeyOf`. */
  haystack: string;
}

export interface InflowFact {
  /** Día (YYYY-MM-DD). */
  on: string;
  counterpartyKey: string;
  amount: number;
  currency: string;
}

export interface RoutineFact {
  /** Inicios de las corridas con error. */
  errors: string[];
  /** Inicios de todas las corridas terminadas. */
  runs: string[];
}

export interface CaseFact {
  revision: number;
  state: string;
  updatedAt: string;
}

export interface ItemFact {
  status: string;
  doneAt: string | null;
  lastActivityAt: string | null;
}

/** Los hechos de una empresa, leídos una vez. Null: esa lectura falló. */
export interface FollowThroughEvidence {
  now: string;
  collections: CollectionFact[] | null;
  inflows: InflowFact[] | null;
  /** Cuándo se reasignó trabajo (auditoría `work.assign` correcta). */
  reassignments: string[] | null;
  /**
   * Carga de hoy por persona: `userId` (todos los tipos) y `userId|tipo`.
   * Sólo los tipos que la empresa mide, como las señales que la recomendaron.
   */
  personLoad: Record<string, { open: number; overdue: number }> | null;
  /** Abiertos sin responsable hoy, por tipo de trabajo, y '*' el total. */
  unassigned: Record<string, number> | null;
  items: Record<string, ItemFact> | null;
  /** Cuándo y quién decidió algo que esperaba aprobación (borradores y llamadas). */
  decisions: Array<{ at: string; userId: string }> | null;
  /** Lo que espera aprobación hoy, por persona. */
  pendingApprovals: Record<string, number> | null;
  /** Por `subjectKeyOf(nombre de la rutina)`. */
  routines: Record<string, RoutineFact> | null;
  /**
   * Cuándo alguien cambió una rutina (auditoría `schedule.update`). No se usa
   * `scheduled_jobs.updated_at`: cada corrida lo toca.
   */
  routineEdits: string[] | null;
  overdueCommitments: number | null;
  openCases: number | null;
  cases: Record<string, CaseFact> | null;
  /** Las clases de alerta que la proyección de caja da HOY. */
  cashAlertKinds: string[] | null;
}

export interface Verdict {
  status: RecommendationStatus;
  followedAt: string | null;
  followEvidence: FollowEvidence;
  outcome: RecommendationOutcome | null;
  outcomeEvidence: OutcomeEvidence;
}

type Rec = Pick<
  RecommendationRecord,
  'kind' | 'subjectKey' | 'createdAt' | 'baseline' | 'severity' | 'createdFor'
>;

function ms(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00-05:00` : iso);
}

function after(iso: string | null | undefined, since: number): boolean {
  const t = ms(iso);
  return Number.isFinite(t) && t >= since;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** El día de Bogotá de un instante. */
function bogotaDay(t: number): string {
  return new Date(t - 5 * 3_600_000).toISOString().slice(0, 10);
}

/** Lo que no se puede ver todavía: ni seguida ni no seguida. */
function waiting(
  ageDays: number,
  nothing: FollowEvidence,
): Pick<Verdict, 'status' | 'followedAt' | 'followEvidence'> {
  return {
    status: ageDays >= FOLLOW_GRACE_DAYS ? 'not_followed' : 'open',
    followedAt: null,
    followEvidence: nothing,
  };
}

/** Una cifra que debería bajar: de cuánto a cuánto, y qué significa. */
function countOutcome(
  from: number | null,
  to: number | null,
): Pick<Verdict, 'outcome' | 'outcomeEvidence'> {
  if (from === null || to === null) return { outcome: 'pending', outcomeEvidence: {} };
  return {
    outcome: to < from ? 'good' : to > from ? 'worse' : 'none',
    outcomeEvidence: { what: 'count', from, to },
  };
}

function matchesSubject(haystack: string, key: string): boolean {
  if (key.length < 3) return false;
  return ` ${haystack} `.includes(` ${key} `);
}

/** El veredicto de una recomendación con los hechos de hoy. */
export function judgeRecommendation(rec: Rec, ev: FollowThroughEvidence): Verdict {
  const now = ms(ev.now);
  const created = ms(rec.createdAt);
  const unmeasurable: Verdict = {
    status: 'unmeasurable',
    followedAt: null,
    followEvidence: {},
    outcome: null,
    outcomeEvidence: {},
  };
  if (!Number.isFinite(now) || !Number.isFinite(created)) return unmeasurable;
  if (UNMEASURABLE_KINDS.has(rec.kind)) return unmeasurable;

  const ageDays = Math.max(0, (now - created) / DAY_MS);
  const windowEnd = created + OUTCOME_WINDOW_DAYS * DAY_MS;
  const windowOpen = now < windowEnd;
  const createdDay = bogotaDay(created);
  const lastDay = bogotaDay(Math.min(now, windowEnd));
  const nothing: FollowEvidence = { what: 'nothing' };
  const b = rec.baseline ?? {};
  const pendingIfOpen = (o: Pick<Verdict, 'outcome' | 'outcomeEvidence'>) =>
    o.outcome === 'none' && windowOpen ? { ...o, outcome: 'pending' as const } : o;

  switch (rec.kind) {
    case 'collect_counterparty': {
      if (!ev.collections || !ev.inflows) return { ...unmeasurable, status: 'open' };
      const mine = ev.collections.filter(
        (c) => matchesSubject(c.haystack, rec.subjectKey) && after(c.createdAt, created - DAY_MS),
      );
      const sent = mine
        .filter((c) => c.sentOk && after(c.executedAt, created))
        .sort((a, z) => ms(a.executedAt) - ms(z.executedAt));
      const proposed = mine.filter((c) => c.state === 'proposed');
      let follow: Pick<Verdict, 'status' | 'followedAt' | 'followEvidence'>;
      if (sent[0])
        follow = {
          status: 'followed',
          followedAt: sent[0].executedAt,
          followEvidence: { what: 'collection_sent', at: sent[0].executedAt, count: sent.length },
        };
      else if (proposed.length)
        follow = {
          status: 'in_progress',
          followedAt: null,
          followEvidence: { what: 'collection_proposed', count: proposed.length },
        };
      else follow = waiting(ageDays, nothing);
      return {
        ...follow,
        ...paymentOutcome(ev.inflows, rec.subjectKey, createdDay, lastDay, windowOpen),
      };
    }

    case 'collect_overdue':
    case 'cash_alert': {
      if (!ev.collections) return { ...unmeasurable, status: 'open' };
      const sent = ev.collections
        .filter((c) => c.sentOk && after(c.executedAt, created))
        .sort((a, z) => ms(a.executedAt) - ms(z.executedAt));
      const follow = sent[0]
        ? {
            status: 'followed' as const,
            followedAt: sent[0].executedAt,
            followEvidence: {
              what: 'collection_sent' as const,
              at: sent[0].executedAt,
              count: sent.length,
            },
          }
        : waiting(ageDays, nothing);
      if (rec.kind === 'collect_overdue') {
        if (!ev.inflows) return { ...follow, outcome: 'pending', outcomeEvidence: {} };
        return { ...follow, ...paymentOutcome(ev.inflows, null, createdDay, lastDay, windowOpen) };
      }
      const alertKind = typeof b.alertKind === 'string' ? b.alertKind : null;
      if (!ev.cashAlertKinds || !alertKind)
        return { ...follow, outcome: 'pending', outcomeEvidence: {} };
      const still = ev.cashAlertKinds.includes(alertKind);
      return {
        ...follow,
        outcome: still ? (windowOpen ? 'pending' : 'none') : 'good',
        outcomeEvidence: { what: still ? 'alert_still' : 'alert_gone' },
      };
    }

    case 'review_approvals': {
      if (!ev.decisions || !ev.pendingApprovals) return { ...unmeasurable, status: 'open' };
      // Lo que espera aprobación es de UNA persona (quien leyó la revisión).
      const who = rec.createdFor ?? null;
      const decided = ev.decisions
        .filter((d) => (who === null || d.userId === who) && after(d.at, created))
        .map((d) => d.at)
        .sort((a, z) => ms(a) - ms(z));
      const follow = decided[0]
        ? {
            status: 'followed' as const,
            followedAt: decided[0],
            followEvidence: { what: 'decided' as const, at: decided[0], count: decided.length },
          }
        : waiting(ageDays, nothing);
      const pendingNow = who === null ? null : (ev.pendingApprovals[who] ?? 0);
      return { ...follow, ...pendingIfOpen(countOutcome(num(b.pending), pendingNow)) };
    }

    case 'fix_routine': {
      if (!ev.routines) return { ...unmeasurable, status: 'open' };
      const r = ev.routines[rec.subjectKey];
      if (!r) return { ...unmeasurable };
      const edit = (ev.routineEdits ?? [])
        .filter((t) => after(t, created))
        .sort((a, z) => ms(a) - ms(z))[0];
      const follow = edit
        ? {
            status: 'followed' as const,
            followedAt: edit,
            followEvidence: { what: 'routine_changed' as const, at: edit },
          }
        : waiting(ageDays, nothing);
      const runs = r.runs.filter((t) => after(t, created)).length;
      const errors = r.errors.filter((t) => after(t, created)).length;
      if (runs === 0) return { ...follow, outcome: 'pending', outcomeEvidence: {} };
      return {
        ...follow,
        outcome: errors === 0 ? 'good' : 'none',
        outcomeEvidence: errors === 0 ? { what: 'no_errors' } : { what: 'errors', to: errors },
      };
    }

    case 'close_commitments':
    case 'decide_cases': {
      const nowCount = rec.kind === 'close_commitments' ? ev.overdueCommitments : ev.openCases;
      const from = num(b.count);
      if (nowCount === null || from === null) return { ...unmeasurable, status: 'open' };
      const out = countOutcome(from, nowCount);
      const follow =
        nowCount < from
          ? {
              status: 'followed' as const,
              followedAt: null,
              followEvidence: { what: 'count_dropped' as const, count: from - nowCount },
            }
          : waiting(ageDays, nothing);
      return { ...follow, ...pendingIfOpen(out) };
    }

    case 'management_case': {
      if (!ev.cases) return { ...unmeasurable, status: 'open' };
      const c = ev.cases[rec.subjectKey];
      if (!c) return { ...unmeasurable };
      const moved =
        c.revision > (num(b.revision) ?? Number.POSITIVE_INFINITY) ||
        (typeof b.state === 'string' && c.state !== b.state);
      const follow = moved
        ? {
            status: 'followed' as const,
            followedAt: c.updatedAt,
            followEvidence: { what: 'item_moved' as const, at: c.updatedAt },
          }
        : waiting(ageDays, nothing);
      // «Por verificar» cuenta: el responsable ya entregó su evidencia.
      const closed = c.state === 'verified' || c.state === 'review';
      return {
        ...follow,
        outcome: closed ? 'good' : windowOpen ? 'pending' : 'none',
        outcomeEvidence: { what: closed ? 'closed' : 'still_open' },
      };
    }

    case 'rebalance_person':
    case 'clear_overdue_person': {
      if (!ev.personLoad) return { ...unmeasurable, status: 'open' };
      const type = typeof b.workType === 'string' && b.workType ? b.workType : null;
      const load = ev.personLoad[type ? `${rec.subjectKey}|${type}` : rec.subjectKey] ?? {
        open: 0,
        overdue: 0,
      };
      const metric = rec.kind === 'rebalance_person' ? 'open' : 'overdue';
      const from = num(b[metric]);
      const to = load[metric];
      const dropped = from !== null && to < from;
      const moves = (ev.reassignments ?? [])
        .filter((t) => after(t, created))
        .sort((a, z) => ms(a) - ms(z));
      let follow: Pick<Verdict, 'status' | 'followedAt' | 'followEvidence'>;
      if (rec.kind === 'rebalance_person') {
        if (moves[0] && dropped)
          follow = {
            status: 'followed',
            followedAt: moves[0],
            followEvidence: { what: 'reassigned', at: moves[0], count: moves.length },
          };
        else if (moves[0])
          follow = {
            status: 'in_progress',
            followedAt: null,
            followEvidence: { what: 'reassigned', at: moves[0], count: moves.length },
          };
        else follow = waiting(ageDays, nothing);
      } else if (dropped && from !== null) {
        follow = {
          status: 'followed',
          followedAt: null,
          followEvidence: { what: 'count_dropped', count: from - to },
        };
      } else follow = waiting(ageDays, nothing);
      return { ...follow, ...pendingIfOpen(countOutcome(from, to)) };
    }

    case 'assign_unassigned': {
      if (!ev.unassigned) return { ...unmeasurable, status: 'open' };
      const type = typeof b.workType === 'string' && b.workType ? b.workType : '*';
      const from = num(b.count);
      const to = ev.unassigned[type] ?? 0;
      const follow =
        from !== null && to < from
          ? {
              status: 'followed' as const,
              followedAt: null,
              followEvidence: { what: 'count_dropped' as const, count: from - to },
            }
          : waiting(ageDays, nothing);
      return { ...follow, ...pendingIfOpen(countOutcome(from, to)) };
    }

    case 'revive_stale': {
      if (!ev.items) return { ...unmeasurable, status: 'open' };
      const item = ev.items[rec.subjectKey];
      if (!item) return { ...unmeasurable };
      const movedAt =
        [item.lastActivityAt, item.doneAt]
          .filter((t) => after(t, created))
          .sort((a, z) => ms(a) - ms(z))[0] ?? null;
      const follow = movedAt
        ? {
            status: 'followed' as const,
            followedAt: movedAt,
            followEvidence: { what: 'item_moved' as const, at: movedAt },
          }
        : waiting(ageDays, nothing);
      const done = item.status === 'done';
      return {
        ...follow,
        outcome: done ? 'good' : windowOpen ? 'pending' : 'none',
        outcomeEvidence: { what: done ? 'closed' : 'still_open', at: done ? item.doneAt : null },
      };
    }

    default:
      return unmeasurable;
  }
}

/**
 * El pago después de la recomendación: lo que entró de ese cliente (o de
 * cualquiera, con `key` nulo) entre el día de la recomendación y el fin de la
 * ventana. Una sola moneda: la del primer pago; las demás no se suman nunca.
 */
function paymentOutcome(
  inflows: readonly InflowFact[],
  key: string | null,
  fromDay: string,
  toDay: string,
  windowOpen: boolean,
): Pick<Verdict, 'outcome' | 'outcomeEvidence'> {
  const paid = inflows
    .filter(
      (p) =>
        p.amount > 0 &&
        p.on >= fromDay &&
        p.on <= toDay &&
        (key === null ||
          matchesSubject(p.counterpartyKey, key) ||
          matchesSubject(key, p.counterpartyKey)),
    )
    .sort((a, z) => a.on.localeCompare(z.on));
  const first = paid[0];
  if (!first) {
    return { outcome: windowOpen ? 'pending' : 'none', outcomeEvidence: { what: 'no_payment' } };
  }
  const same = paid.filter((p) => p.currency === first.currency);
  const amount = Math.round(same.reduce((s, p) => s + p.amount, 0));
  return {
    outcome: 'good',
    outcomeEvidence: { what: 'payment', at: first.on, amount, currency: first.currency },
  };
}

/** ¿Ya no hace falta volver a mirarla? */
export function isSettledRecommendation(
  rec: Pick<RecommendationRecord, 'createdAt' | 'status' | 'outcome'>,
  now: Date,
): boolean {
  if (rec.status === 'unmeasurable') return true;
  const created = ms(rec.createdAt);
  if (!Number.isFinite(created)) return true;
  if (now.getTime() - created > EVALUATION_HORIZON_DAYS * DAY_MS) return true;
  return false;
}
