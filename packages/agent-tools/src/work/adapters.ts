import type { TrackerField } from '../trackers/schema';
import {
  type TrackerMapping,
  WORK_TYPE,
  type WorkDirectoryPerson,
  foldText,
  readDate,
  resolvePerson,
} from './shape';
import type { WorkSource, WorkStatus } from './types';

/**
 * DE CADA FUENTE AL REGISTRO DE TRABAJO: LOS MAPEADORES PUROS.
 *
 * Una función por fuente: recibe la fila tal como la lee la sincronización y
 * devuelve un `WorkDraft` (un ítem sin id) o `null` cuando la fila no es
 * trabajo todavía. No leen la base ni el reloj —`now` llega como argumento—
 * así que cada regla de abajo tiene su prueba en adapters.test.ts.
 *
 * LO QUE NINGUNO COPIA. El contenido: el detalle de un compromiso, el objetivo
 * de un asunto, el payload de una aprobación (destinatario, asunto, cuerpo de
 * un correo). El registro guarda el título del trabajo, quién responde y las
 * fechas. Una aprobación entra como «Espera de decisión: <qué herramienta>»,
 * contando cuánto tarda en decidirse, y nada más.
 */

export interface WorkDraft {
  assigneeId: string | null;
  /** El nombre como lo dice la fuente, cuando no es nadie del equipo (o es ambiguo). */
  assigneeLabel: string | null;
  workType: string;
  title: string;
  status: WorkStatus;
  openedAt: string;
  /** Día `YYYY-MM-DD` o instante ISO. */
  dueAt?: string | null;
  doneAt?: string | null;
  /**
   * `doneAt` es una aproximación (la última edición de la fila, no el momento
   * del cierre): si el ítem ya estaba hecho, el registro conserva la fecha que
   * tenía en vez de moverla cada vez que alguien toca la fila.
   */
  doneAtApprox?: boolean;
  lastActivityAt?: string | null;
  quantity?: number | null;
  unit?: string | null;
  team?: string | null;
  source: WorkSource;
}

const clip = (value: string, max: number) => value.trim().replace(/\s+/g, ' ').slice(0, max);

// ---------------------------------------------------------------------------
// Gerencia
// ---------------------------------------------------------------------------

export interface ManagementCaseLite {
  id: string;
  data: { title: string; ownerId: string | null; dueOn: string; state: string };
  created_at: string;
  updated_at: string;
}

/** Un asunto de Gerencia: verificado = hecho; descartado = ya no aplica. */
export function managementCaseToWork(c: ManagementCaseLite): WorkDraft | null {
  if (!c?.id || !c.data?.title) return null;
  const state = c.data.state;
  const status: WorkStatus =
    state === 'verified' ? 'done' : state === 'cancelled' ? 'cancelled' : 'open';
  return {
    assigneeId: c.data.ownerId ?? null,
    assigneeLabel: null,
    workType: WORK_TYPE.managementCase,
    title: clip(c.data.title, 300),
    status,
    openedAt: c.created_at,
    dueAt: c.data.dueOn || null,
    doneAt: status === 'done' ? c.updated_at : null,
    doneAtApprox: status === 'done',
    lastActivityAt: c.updated_at,
    source: { kind: 'management_case', system: 'gerencia', ref: c.id },
  };
}

// ---------------------------------------------------------------------------
// Compromisos y vencimientos
// ---------------------------------------------------------------------------

export interface CommitmentLite {
  id: string;
  title: string;
  kind: string;
  due_on: string;
  state: string;
  met_at: string | null;
  dropped_at: string | null;
  owner_user_id: string | null;
  review_state: string;
  created_at: string;
  updated_at: string;
}

/**
 * Un compromiso con responsable. Los internos son «compromiso»; el resto
 * (SOAT, contratos, pólizas…) «vencimiento». Uno extraído que nadie confirmó
 * todavía no es trabajo (`null`); uno rechazado ya no aplica.
 */
export function commitmentToWork(c: CommitmentLite): WorkDraft | null {
  if (!c?.id || !c.title) return null;
  if (c.review_state === 'pending') return null;
  const status: WorkStatus =
    c.review_state === 'rejected' || c.state === 'dropped'
      ? 'cancelled'
      : c.state === 'met'
        ? 'done'
        : 'open';
  return {
    assigneeId: c.owner_user_id ?? null,
    assigneeLabel: null,
    workType: c.kind === 'internal' ? WORK_TYPE.internalCommitment : WORK_TYPE.commitment,
    title: clip(c.title, 300),
    status,
    openedAt: c.created_at,
    dueAt: c.due_on,
    doneAt: status === 'done' ? (c.met_at ?? c.updated_at) : null,
    doneAtApprox: status === 'done' && !c.met_at,
    lastActivityAt: c.updated_at,
    source: { kind: 'commitment', system: 'compromisos', ref: c.id },
  };
}

// ---------------------------------------------------------------------------
// Filas de tablas inventadas, según el mapeo de la empresa
// ---------------------------------------------------------------------------

export interface TrackerRowLite {
  id: string;
  label: string;
  values: Record<string, string | number>;
  created_at: string;
  updated_at: string;
}

function textValue(values: Record<string, string | number>, key: string | null): string | null {
  if (!key) return null;
  const v = values[key];
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function dateValue(values: Record<string, string | number>, key: string | null): string | null {
  const raw = textValue(values, key);
  const read = readDate(raw);
  if (!read) return null;
  return 'day' in read ? read.day : read.instant;
}

/** «12», «12,5», «1.200» (miles) → número; lo demás, nulo. */
export function numberValue(raw: string | number | null | undefined): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim().replace(/\s/g, '');
  if (!s) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Una fila de una tabla inventada, leída con el mapeo que la empresa declaró
 * (`work.configure`). El responsable se resuelve contra el directorio: si el
 * nombre no es nadie del equipo, o es ambiguo, el ítem queda sin asignar con
 * el nombre a la vista (`assigneeLabel`) — nunca se le asigna a alguien por
 * parecido.
 */
export function trackerRowToWork(
  mapping: TrackerMapping,
  row: TrackerRowLite,
  people: readonly WorkDirectoryPerson[],
): WorkDraft | null {
  if (!row?.id) return null;
  const values = row.values ?? {};

  const match = resolvePerson(people, values[mapping.assigneeField]);
  const assigneeId = match.kind === 'found' ? match.id : null;
  const assigneeLabel = match.kind === 'unknown' || match.kind === 'ambiguous' ? match.label : null;

  const state = textValue(values, mapping.statusField);
  const folded = state ? foldText(state) : null;
  const doneAtValue = dateValue(values, mapping.doneAtField);
  let status: WorkStatus = 'open';
  if (folded && mapping.cancelledValues.some((v) => foldText(v) === folded)) status = 'cancelled';
  else if (folded && mapping.doneValues.some((v) => foldText(v) === folded)) status = 'done';
  else if (!mapping.statusField && doneAtValue) status = 'done';

  const title = textValue(values, mapping.titleField) ?? row.label ?? 'Sin nombre';
  const quantity = mapping.quantityField
    ? numberValue(values[mapping.quantityField] ?? null)
    : null;

  return {
    assigneeId,
    assigneeLabel,
    workType: mapping.workType,
    title: clip(title, 300) || 'Sin nombre',
    status,
    openedAt: dateValue(values, mapping.openedAtField) ?? row.created_at,
    dueAt: dateValue(values, mapping.dueField),
    doneAt: status === 'done' ? (doneAtValue ?? row.updated_at) : null,
    doneAtApprox: status === 'done' && !doneAtValue,
    lastActivityAt: row.updated_at,
    quantity,
    unit: quantity !== null ? (mapping.unit ?? null) : null,
    team: textValue(values, mapping.teamField),
    source: { kind: 'tracker_row', system: mapping.tracker, ref: row.id },
  };
}

// ---------------------------------------------------------------------------
// Aprobaciones: «espera de X»
// ---------------------------------------------------------------------------

export interface PendingActionLite {
  id: string;
  user_id: string;
  tool_id: string;
  created_at: string;
  expires_at: string;
  decision: string | null;
  decided_at: string | null;
}

/**
 * Una llamada parada esperando permiso. Cuenta como trabajo de quien tiene que
 * decidir, y sólo por el tiempo que tarda en decidir: abierta mientras espera,
 * hecha al decidirse (aprobar o rechazar, da igual), y «ya no aplica» si
 * venció sin respuesta (la acción no corrió). El título nombra la herramienta,
 * nunca lo que lleva dentro.
 */
export function pendingActionToWork(
  a: PendingActionLite,
  toolLabel: string,
  now: Date,
): WorkDraft | null {
  if (!a?.id || !a.user_id) return null;
  const decided = Boolean(a.decision && a.decided_at);
  const expired = !decided && Date.parse(a.expires_at) <= now.getTime();
  const status: WorkStatus = decided ? 'done' : expired ? 'cancelled' : 'open';
  return {
    assigneeId: a.user_id,
    assigneeLabel: null,
    workType: WORK_TYPE.decision,
    title: clip(`Espera de decisión: ${toolLabel}`, 300),
    status,
    openedAt: a.created_at,
    dueAt: a.expires_at,
    doneAt: decided ? a.decided_at : null,
    lastActivityAt: a.decided_at ?? a.created_at,
    source: { kind: 'approval', system: 'permisos', ref: a.id },
  };
}

export interface ProposedActionLite {
  id: string;
  user_id: string;
  tool_id: string;
  state: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  decided_at: string | null;
}

/** Una acción propuesta (un correo redactado) que espera a su dueño. */
export function proposedActionToWork(
  a: ProposedActionLite,
  toolLabel: string,
  now: Date,
): WorkDraft | null {
  if (!a?.id || !a.user_id) return null;
  const decided = (a.state === 'approved' || a.state === 'dismissed') && Boolean(a.decided_at);
  const expired = !decided && Date.parse(a.expires_at) <= now.getTime();
  const status: WorkStatus = decided ? 'done' : expired ? 'cancelled' : 'open';
  return {
    assigneeId: a.user_id,
    assigneeLabel: null,
    workType: WORK_TYPE.decision,
    title: clip(`Espera de decisión: ${toolLabel}`, 300),
    status,
    openedAt: a.created_at,
    dueAt: a.expires_at,
    doneAt: decided ? a.decided_at : null,
    lastActivityAt: a.updated_at,
    source: { kind: 'approval', system: 'acciones', ref: a.id },
  };
}

// ---------------------------------------------------------------------------
// Proponer un mapeo para una tabla
// ---------------------------------------------------------------------------

const ASSIGNEE_HINT =
  /^(responsable|asignad[oa]|encargad[oa]|owner|assignee|quien|persona|vendedor[a]?|mensajer[oa]|conductor[a]?|cobrador[a]?|asesor[a]?|ejecutiv[oa]|agente|tecnic[oa]|operari[oa]|usuario|user)/;
const STATUS_HINT = /^(estado|status|etapa|situacion)/;
const DUE_HINT = /(vence|vencimiento|fecha limite|limite|plazo|due|entrega)/;
const QTY_HINT = /(cantidad|unidades|guias|pedidos|cajas|total|valor|monto|numero|n°|qty)/;
const DONE_HINT =
  /^(hech[oa]|entregad[oa]|despachad[oa]|cerrad[oa]|pagad[oa]|completad[oa]|list[oa]|terminad[oa]|resuelt[oa]|finalizad[oa]|done|ok|aprobad[oa])$/;
const CANCEL_HINT = /^(cancelad[oa]|anulad[oa]|descartad[oa]|no aplica|rechazad[oa])$/;

export interface MappingCandidate {
  key: string;
  label: string;
  /** De las filas leídas con valor en el campo, cuántas son alguien del equipo. */
  matchedPeople: number;
  filled: number;
  reason: string;
}

export interface MappingProposal {
  assigneeCandidates: MappingCandidate[];
  /** El mapeo propuesto, o nulo si no hay un campo de responsable claro. */
  mapping: Omit<TrackerMapping, 'tracker' | 'workType'> | null;
  notes: string[];
}

/**
 * Qué campo de una tabla parece decir quién responde, cuál es el estado, cuál
 * el vencimiento y cuál la cantidad. Los tipos de campo de una tabla inventada
 * son texto, número, fecha, plata y opciones: no hay un tipo «persona», así
 * que el responsable se reconoce por el nombre del campo y, sobre todo, porque
 * sus valores son gente del equipo. Propone; no decide: lo confirma una
 * persona con `work.configure`.
 */
export function proposeTrackerMapping(
  fields: readonly TrackerField[],
  rows: readonly TrackerRowLite[],
  people: readonly WorkDirectoryPerson[],
): MappingProposal {
  const notes: string[] = [];
  const candidates: MappingCandidate[] = [];
  for (const f of fields) {
    if (f.type !== 'text' && f.type !== 'select') continue;
    const hinted =
      ASSIGNEE_HINT.test(foldText(f.key).replace(/_/g, ' ')) ||
      ASSIGNEE_HINT.test(foldText(f.label));
    let filled = 0;
    let matched = 0;
    for (const r of rows) {
      const v = r.values?.[f.key];
      if (v === undefined || v === null || String(v).trim() === '') continue;
      filled += 1;
      if (resolvePerson(people, v).kind === 'found') matched += 1;
    }
    const share = filled ? matched / filled : 0;
    if (hinted || share >= 0.5) {
      candidates.push({
        key: f.key,
        label: f.label,
        matchedPeople: matched,
        filled,
        reason: hinted
          ? `el nombre del campo («${f.label}») dice quién responde${filled ? `; ${matched} de ${filled} valores son alguien del equipo` : ''}`
          : `${matched} de ${filled} valores son alguien del equipo`,
      });
    }
  }
  candidates.sort((a, b) => b.matchedPeople - a.matchedPeople || b.filled - a.filled);

  const pick = (re: RegExp, types: TrackerField['type'][]) =>
    fields.find(
      (f) =>
        types.includes(f.type) &&
        (re.test(foldText(f.key).replace(/_/g, ' ')) || re.test(foldText(f.label))),
    ) ?? null;

  const statusField = pick(STATUS_HINT, ['select', 'text']);
  const dueField = pick(DUE_HINT, ['date']);
  const quantityField = pick(QTY_HINT, ['number', 'money']);
  const options = statusField?.options ?? [];
  const doneValues = options.filter((o) => DONE_HINT.test(foldText(o)));
  const cancelledValues = options.filter((o) => CANCEL_HINT.test(foldText(o)));

  const top = candidates[0];
  if (!top) notes.push('Ningún campo parece decir quién responde: dime cuál es.');
  else if (candidates.length > 1)
    notes.push(
      `Hay ${candidates.length} campos que podrían ser el responsable; propongo «${top.label}». Confírmalo.`,
    );
  if (statusField && options.length && !doneValues.length)
    notes.push(
      `No reconozco qué valor de «${statusField.label}» quiere decir «hecho» (${options.join(', ')}): dímelo.`,
    );
  if (!statusField)
    notes.push(
      'Sin campo de estado, cada fila cuenta como abierta hasta que tenga fecha de cierre.',
    );

  return {
    assigneeCandidates: candidates,
    mapping: top
      ? {
          assigneeField: top.key,
          statusField: statusField?.key ?? null,
          doneValues,
          cancelledValues,
          dueField: dueField?.key ?? null,
          quantityField: quantityField?.key ?? null,
          unit: null,
          titleField: null,
          teamField: null,
          doneAtField: null,
          openedAtField: null,
        }
      : null,
    notes,
  };
}
