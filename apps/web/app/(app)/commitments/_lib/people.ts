import {
  type CommitmentKind,
  type CommitmentRow,
  KIND_LABEL,
  STATE_LABEL,
  bogotaToday,
  daysBetween,
  daysUntilDue,
  deriveState,
  isOpen,
} from '@cortex/agent-tools';
import { shortDate } from '../_components/format';
import type {
  PeopleLoad,
  PersonItem,
  PersonLoad,
  PersonRecord,
  PersonTally,
} from '../_components/types';

/**
 * La misma lista de compromisos, agrupada por quién responde por ellos.
 *
 * ===========================================================================
 * POR QUÉ ESTO NO ES UN `ORDER BY owner`
 * ===========================================================================
 * La pantalla de vencimientos ordena por fecha, que es como se lee una agenda.
 * Un gerente no lee agendas: lee gente. La pregunta que trae a alguien a esta
 * pantalla es «¿quién va atrasado?», y con la lista ordenada por fecha esa
 * pregunta se contesta contando a ojo las veces que aparece cada nombre entre
 * los SOAT de la flota. Aquí el nombre es la fila.
 *
 * Todo se calcula EN EL SERVIDOR, contra el mismo `today` en Bogotá que usa el
 * resto de la pantalla, y baja como conclusiones. Ninguna fila de esta vista
 * puede decir «vencido» de algo que la lista de al lado pinta en verde.
 *
 * Es una función pura, sin base de datos y sin `Date.now()` escondido: recibe
 * las filas y el día, devuelve el modelo. Por eso se puede probar el orden y el
 * cumplimiento sin levantar nada.
 */

/**
 * Sobre cuánto pasado se calcula el cumplimiento.
 *
 * Medio año. Más corto que eso y una racha mala de dos semanas define a alguien;
 * más largo y la cifra deja de moverse — un historial que no puede mejorar es un
 * castigo permanente, y nadie cambia de hábito por una cifra que ya no responde.
 */
export const RECORD_WINDOW_DAYS = 180;

/**
 * Cuántas cosas cerradas hacen falta antes de decir un porcentaje.
 *
 * Con una sola, «0 de 1 a tiempo» es 0% y es ruido; con tres ya hay una forma.
 * Por debajo de este número la pantalla dice que todavía no sabe, que es la
 * verdad.
 */
export const MIN_CLOSED_FOR_RATE = 3;

/** La fila de lo que no está a nombre de nadie. Siempre va de última. */
export const UNASSIGNED_KEY = '__sin-responsable__';

export const UNASSIGNED_NAME = 'Sin responsable';

/**
 * `isInternalKind` vive en `commitments/shape.ts` y el barril del paquete no lo
 * reexporta, así que aquí se repite la única línea que es. Si algún día se
 * exporta, este helper se borra y se importa aquel — la regla es suya, no de
 * esta pantalla.
 */
function internalKind(kind: CommitmentKind): boolean {
  return kind === 'internal';
}

/**
 * Lo que esta vista necesita de una fila, y ni un campo más.
 *
 * Es un `Pick` de la fila real y no una copia, así que `listCommitments` se le
 * pasa tal cual y una columna que cambie de nombre rompe el tipo aquí en vez de
 * rompernos el cálculo en producción.
 */
export type PersonCommitment = Pick<
  CommitmentRow,
  'id' | 'title' | 'kind' | 'due_on' | 'notice_days' | 'state' | 'met_at' | 'owner_user_id'
> & { owner_name?: string | null };

/**
 * ¿Se cumplió antes de la fecha?
 *
 * `met_at` es un instante y `due_on` es un día del calendario colombiano, así
 * que compararlos crudos es el error de zona horaria de siempre: algo marcado
 * como cumplido a las 20:00 en Bogotá ya es del día siguiente en UTC, y una
 * promesa entregada a tiempo contaría como tarde cada noche, en silencio.
 * `bogotaToday` es exactamente la función que traduce un instante al día que
 * era aquí, y es la misma que usa el vigilante.
 *
 * Devuelve `null` cuando no hay `met_at`: eso no es «tarde», es «no se sabe», y
 * una fila así no entra en el cálculo.
 */
export function metOnTime(row: Pick<PersonCommitment, 'met_at' | 'due_on'>): boolean | null {
  const metOn = metDay(row.met_at);
  if (!metOn) return null;
  return metOn <= row.due_on;
}

/** El día colombiano en que se marcó cumplido, o `null` si no se puede saber. */
function metDay(metAt: string | null): string | null {
  if (!metAt) return null;
  const at = new Date(metAt);
  if (Number.isNaN(at.getTime())) return null;
  return bogotaToday(at);
}

interface Draft {
  key: string;
  name: string;
  unassigned: boolean;
  promises: PersonTally;
  papers: PersonTally;
  items: PersonItem[];
  promiseClosed: number;
  promiseOnTime: number;
  paperClosed: number;
  paperOnTime: number;
}

function draft(key: string, name: string): Draft {
  return {
    key,
    name,
    unassigned: key === UNASSIGNED_KEY,
    promises: { open: 0, overdue: 0 },
    papers: { open: 0, overdue: 0 },
    items: [],
    promiseClosed: 0,
    promiseOnTime: 0,
    paperClosed: 0,
    paperOnTime: 0,
  };
}

function record(closed: number, onTime: number): PersonRecord {
  return {
    closed,
    onTime,
    rate: closed >= MIN_CLOSED_FOR_RATE ? onTime / closed : null,
  };
}

function nameOf(row: PersonCommitment): string {
  if (!row.owner_user_id) return UNASSIGNED_NAME;
  // `hydrate` ya resolvió el nombre contra `users` (o el correo, si la persona
  // no tiene nombre puesto). Si aun así viene vacío es una cuenta que ya no
  // está; decirlo así es mejor que imprimir un uuid.
  return row.owner_name?.trim() || 'Alguien que ya no está';
}

/**
 * Lo que aprieta primero.
 *
 * Menos días restantes es más urgente, y los días restantes son negativos una
 * vez pasada la fecha — así lo más vencido queda arriba sin necesitar una regla
 * aparte para los vencidos.
 */
function byUrgency(a: PersonItem, b: PersonItem): number {
  if (a.daysLeft !== b.daysLeft) return a.daysLeft - b.daysLeft;
  return a.title.localeCompare(b.title, 'es');
}

/**
 * Cuánto tiene encima, sólo para ordenar.
 *
 * Aquí sí se suman promesas y papeles, y es la única parte del archivo donde
 * eso es legítimo: esto no se imprime en ninguna parte, es la respuesta a «¿a
 * quién miro primero?». Ninguna cifra de la pantalla sale de esta función.
 */
function overdueWeight(p: PersonLoad): number {
  return p.promises.overdue + p.papers.overdue;
}

function openWeight(p: PersonLoad): number {
  return p.promises.open + p.papers.open;
}

function byTrouble(a: PersonLoad, b: PersonLoad): number {
  // Lo que no tiene dueño va siempre de último, tenga lo que tenga: no es una
  // persona a la que se le pueda preguntar, es una tarea de administración.
  if (a.unassigned !== b.unassigned) return a.unassigned ? 1 : -1;

  const overdue = overdueWeight(b) - overdueWeight(a);
  if (overdue !== 0) return overdue;

  // Empatados en atrasos, arriba quien tiene la fecha más cerca encima.
  const aNext = a.items[0]?.daysLeft ?? Number.POSITIVE_INFINITY;
  const bNext = b.items[0]?.daysLeft ?? Number.POSITIVE_INFINITY;
  if (aNext !== bNext) return aNext - bNext;

  const open = openWeight(b) - openWeight(a);
  if (open !== 0) return open;

  return a.name.localeCompare(b.name, 'es');
}

/**
 * El modelo entero de la vista por persona.
 *
 * `open` son los compromisos confirmados que siguen vivos; `closed` son los que
 * ya se marcaron cumplidos y de los que sale el historial. Los descartados no
 * entran en ninguno de los dos: descartar es una decisión que alguien tomó
 * porque la cosa dejó de tener sentido, y contarla como incumplimiento
 * castigaría precisamente el acto de mantener la lista limpia.
 */
export function buildPeopleLoad(input: {
  open: PersonCommitment[];
  closed: PersonCommitment[];
  today: string;
}): PeopleLoad {
  const { today } = input;
  const drafts = new Map<string, Draft>();

  const at = (row: PersonCommitment): Draft => {
    const key = row.owner_user_id ?? UNASSIGNED_KEY;
    const found = drafts.get(key);
    if (found) return found;
    const fresh = draft(key, nameOf(row));
    drafts.set(key, fresh);
    return fresh;
  };

  for (const row of input.open) {
    const state = deriveState(row, today);
    // La página ya filtró, pero el modelo no confía en eso: si algo cerrado se
    // colara aquí inflaría el conteo de alguien sin que nada se pusiera rojo.
    if (!isOpen(state)) continue;

    const person = at(row);
    const internal = internalKind(row.kind);
    const tally = internal ? person.promises : person.papers;
    tally.open += 1;
    if (state === 'overdue') tally.overdue += 1;

    person.items.push({
      id: row.id,
      title: row.title,
      kindLabel: KIND_LABEL[row.kind] ?? KIND_LABEL.other,
      internal,
      dueOn: row.due_on,
      dueLabel: shortDate(row.due_on),
      daysLeft: daysUntilDue(row.due_on, today),
      state,
      stateLabel: STATE_LABEL[state],
    });
  }

  let closedInWindow = 0;
  for (const row of input.closed) {
    if (row.state !== 'met') continue;
    const closedOn = metDay(row.met_at);
    if (!closedOn) continue;
    // La ventana se mide sobre el día en que se cerró, no sobre el vencimiento:
    // lo que importa es la conducta reciente, y algo con fecha del año pasado
    // que se resolvió el mes pasado es conducta reciente.
    const age = daysBetween(closedOn, today);
    if (!Number.isFinite(age) || age < 0 || age > RECORD_WINDOW_DAYS) continue;
    const onTime = metOnTime(row) === true;

    closedInWindow += 1;
    const person = at(row);
    if (internalKind(row.kind)) {
      person.promiseClosed += 1;
      if (onTime) person.promiseOnTime += 1;
    } else {
      person.paperClosed += 1;
      if (onTime) person.paperOnTime += 1;
    }
  }

  const all: PersonLoad[] = [...drafts.values()].map((d) => ({
    key: d.key,
    name: d.name,
    unassigned: d.unassigned,
    promises: d.promises,
    papers: d.papers,
    items: [...d.items].sort(byUrgency),
    promiseRecord: record(d.promiseClosed, d.promiseOnTime),
    paperRecord: record(d.paperClosed, d.paperOnTime),
  }));

  const pending = all.filter((p) => p.items.length > 0).sort(byTrouble);

  // Quien no tiene nada abierto sale SÓLO si trae historial. Una lista donde
  // todo el mundo aparece en verde entrena a no mirarla, y un nombre con dos
  // ceros al lado no dice si la persona cumple o si nunca se le ha pedido nada.
  const clear = all
    .filter((p) => p.items.length === 0)
    .filter((p) => p.promiseRecord.closed + p.paperRecord.closed > 0)
    .sort((a, b) => {
      const closed =
        b.promiseRecord.closed +
        b.paperRecord.closed -
        (a.promiseRecord.closed + a.paperRecord.closed);
      if (closed !== 0) return closed;
      return a.name.localeCompare(b.name, 'es');
    });

  return { pending, clear, windowDays: RECORD_WINDOW_DAYS, closedInWindow };
}
