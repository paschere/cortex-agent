import 'server-only';
import {
  ACTION_KIND_LABEL,
  adaptAction,
  adaptCommitment,
  bogotaToday,
  hydrateOwners,
  listActions,
  listCommitments,
  whenPhrase,
} from '@cortex/agent-tools';
import { listErrands } from './errands/repository';
import { countNavSignals } from './nav-signals';
import type { StatusTone } from './status-chip';
import { getOrgScopedClient } from './supabase/service';
import { confirmationSummary, toolLabel } from './tool-labels';
import {
  QUEUE_HREF,
  QUEUE_LABEL,
  WAITING_QUEUES,
  type WaitingCounts,
  type WaitingNoticeData,
  type WaitingQueue,
  agoPhrase,
  briefingAsk,
  noticeFromCounts,
  summarizeWaiting,
  waitingTotal,
} from './waiting-shape';

/**
 * EL ÍNDICE DE LO QUE TE ESPERA — Y POR QUÉ ES UN ÍNDICE Y NO UNA TABLA.
 *
 * Hay cuatro colas con trabajo parado esperando a una persona, y cada una tiene
 * su pantalla. Lo que faltaba no era una quinta pantalla: era saber, al llegar,
 * que hay algo. Los crons nocturnos (commitments-watch, actions-sweep,
 * errand-sweep) llevan meses dejando hallazgos que sólo existen para quien
 * decide abrir la cola donde cayeron.
 *
 * ESTO NO FUSIONA NADA. La discusión ya está ganada en el comentario de
 * nav/Sidebar.tsx y en el de /approvals: una aprobación es una llamada de
 * herramienta parqueada a mitad de turno, que EXPIRA en minutos y se puede
 * contestar desde un botón de Google Chat; una acción es un correo con hash de
 * contenido que se sigue vigilando después de enviado. Meterlas en una tabla
 * obligaría a tirar la mitad de cada una. Aquí cada cola conserva su forma, su
 * verbo y su enlace; lo único que comparten es el sitio donde se anuncian.
 *
 * LOS CONTEOS Y EL CONTENIDO SE LEEN DISTINTO, A PROPÓSITO.
 *
 *   Los CONTEOS salen de `countNavSignals`, tal cual, sin recontar. Ese archivo
 *   explica por qué cada conteo se traga su propio error: un badge caído no
 *   puede tumbar la navegación. Reutilizarlo también evita lo peor que podría
 *   pasar en esta pantalla — que el número de la barra lateral y el de aquí
 *   dijeran cosas distintas del mismo trabajo.
 *
 *   El CONTENIDO no se traga nada. Si la lista de acciones no se puede leer,
 *   esta pantalla lo dice; dibujar una cola vacía cuando en realidad falló la
 *   consulta es la mentira exacta que el resto del producto ya dejó de contar.
 *   Cada cola falla por su cuenta: que Supabase tosa en vencimientos no puede
 *   borrar los encargos atascados.
 */

/** Cuántos elementos de cada cola se muestran. Dos o tres: es un índice. */
const PREVIEW = 3;

export interface WaitingItem {
  id: string;
  /** El asunto real. Nunca un identificador, nunca un conteo. */
  title: string;
  /** Segunda línea: a quién, de qué tipo, con quién. */
  detail: string | null;
  /** «redactada hace nueve días», «se venció hace doce días», «expira en 12 min». */
  when: string;
  tone: StatusTone;
}

export interface WaitingQueueView {
  queue: WaitingQueue;
  label: string;
  href: string;
  /** De `countNavSignals`. Es el número que dibuja la barra lateral. */
  count: number;
  items: WaitingItem[];
  /** Con qué frase se explica que no se pudo leer. `null` si se leyó bien. */
  error: string | null;
}

export interface WaitingIndex {
  counts: WaitingCounts;
  total: number;
  /** La línea de arriba. Escrita con reglas — ver `waiting-shape.ts`. */
  sentence: string;
  queues: WaitingQueueView[];
}

interface Preview {
  items: WaitingItem[];
  error: string | null;
  /** Días que lleva esperando lo más antiguo de esta cola. */
  oldestDays: number | null;
  /** Sólo lo llena la cola de vencimientos. */
  overdue: number;
}

const EMPTY: Preview = { items: [], error: null, oldestDays: null, overdue: 0 };

function failed(what: string, err: unknown): Preview {
  const detail = err instanceof Error ? err.message : String(err);
  return { ...EMPTY, error: `No se pudo leer ${what}: ${detail}` };
}

function daysSince(iso: string, now: number): number | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** «expira en 12 min» — lo único que importa de una aprobación es el reloj. */
function expiryPhrase(expiresAt: string, now: number): string {
  const ms = Date.parse(expiresAt) - now;
  if (Number.isNaN(ms)) return 'sin fecha de expiración';
  if (ms <= 0) return 'ya expiró';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `expira en ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `expira en ${hours} h`;
  return `expira en ${Math.floor(hours / 24)} d`;
}

/**
 * Todo lo que espera, con nombre y apellido.
 *
 * Cinco lecturas en paralelo: el conteo de las cuatro colas (una sola llamada,
 * la que ya hace el layout) y el contenido de cada una. Las cuatro de contenido
 * están acotadas y son las MISMAS funciones que usan las pantallas de destino,
 * para que un índice no pueda prometer trabajo que la cola no tiene.
 */
export async function readWaitingIndex(
  organizationId: string,
  userId: string,
): Promise<WaitingIndex> {
  const db = getOrgScopedClient(organizationId);
  const now = Date.now();

  const [counts, approvals, commitments, actions, errands] = await Promise.all([
    countNavSignals(organizationId, userId),
    readApprovals(db, userId, now),
    readCommitments(db, now),
    readActions(db, userId, now),
    readErrands(db, organizationId, now),
  ]);

  const previews: Record<WaitingQueue, Preview> = { approvals, commitments, actions, errands };

  // Lo más viejo de las cuatro colas, y de cuál es. Las dos cosas viajan juntas
  // porque la frase necesita saber si eso más viejo es además el vencimiento
  // que ya se pasó, para no contarlo dos veces.
  let oldestDays: number | null = null;
  let oldestQueue: WaitingQueue | null = null;
  for (const queue of WAITING_QUEUES) {
    const days = previews[queue].oldestDays;
    if (days === null) continue;
    if (oldestDays === null || days > oldestDays) {
      oldestDays = days;
      oldestQueue = queue;
    }
  }

  return {
    counts,
    total: waitingTotal(counts),
    sentence: summarizeWaiting({
      counts,
      overdue: commitments.overdue,
      oldestDays,
      oldestQueue,
    }),
    queues: WAITING_QUEUES.map((queue) => ({
      queue,
      label: QUEUE_LABEL[queue],
      href: QUEUE_HREF[queue],
      count: counts[queue],
      items: previews[queue].items,
      error: previews[queue].error,
    })),
  };
}

/**
 * El aviso del chat: los conteos y, si hay algo, el primer asunto.
 *
 * Abrir una conversación nueva no puede costar las cuatro lecturas del índice.
 * Los conteos salen de `countNavSignals`, que el layout ya corre. El nombre
 * propio —sin el cual el vacío del chat seguiría siendo un número— es UNA
 * lectura más: el primer elemento de la primera cola que no está vacía, en el
 * orden de `WAITING_QUEUES`. Si esa lectura falla, la frase del conteo sigue
 * siendo verdad y el aviso se queda en ella.
 */
export async function readWaitingNotice(
  organizationId: string,
  userId: string,
): Promise<WaitingNoticeData> {
  const counts = await countNavSignals(organizationId, userId);
  const notice = noticeFromCounts(counts);
  const first = notice.queues[0];
  if (!first) return notice;

  const db = getOrgScopedClient(organizationId);
  const preview = await readQueue(first.queue, db, organizationId, userId, Date.now());
  const item = preview.items[0];
  if (!item) return notice;

  return {
    ...notice,
    lead: {
      queue: first.queue,
      title: item.title,
      detail: item.detail,
      ask: briefingAsk(first.queue, item.title),
    },
  };
}

async function readQueue(
  queue: WaitingQueue,
  db: Db,
  organizationId: string,
  userId: string,
  now: number,
): Promise<Preview> {
  switch (queue) {
    case 'approvals':
      return readApprovals(db, userId, now);
    case 'commitments':
      return readCommitments(db, now);
    case 'actions':
      return readActions(db, userId, now);
    case 'errands':
      return readErrands(db, organizationId, now);
  }
}

// ---------------------------------------------------------------------------
// Una cola, tres filas
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof getOrgScopedClient>;

/**
 * Aprobaciones: espeja la consulta de app/(app)/approvals/page.tsx, ordenada al
 * revés. La cola se dibuja con la más nueva arriba porque es una bandeja; aquí
 * mandan las que están a punto de expirar, que son las viejas.
 */
async function readApprovals(db: Db, userId: string, now: number): Promise<Preview> {
  try {
    const { data, error } = await db
      .from('mcp_pending_actions')
      .select('id, tool_id, input, created_at, expires_at')
      .eq('user_id', userId)
      .is('decision', null)
      .gt('expires_at', new Date(now).toISOString())
      .order('created_at', { ascending: true })
      .limit(PREVIEW);
    if (error) throw error;

    const rows = (data ?? []) as Array<{
      id: string;
      tool_id: string;
      input: unknown;
      created_at: string;
      expires_at: string;
    }>;

    return {
      items: rows.map((row) => ({
        id: row.id,
        // La misma frase que ve quien lo aprueba desde Google Chat. Un id de
        // herramienta no es el asunto de nada.
        title: describeToolCall(row.tool_id, row.input),
        detail: null,
        when: expiryPhrase(row.expires_at, now),
        tone: 'amber' as StatusTone,
      })),
      error: null,
      oldestDays: rows.length > 0 ? daysSince(rows[0]?.created_at ?? '', now) : null,
      overdue: 0,
    };
  } catch (err) {
    return failed('lo que espera tu permiso', err);
  }
}

function describeToolCall(toolId: string, input: unknown): string {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  try {
    return confirmationSummary(toolId, record);
  } catch {
    return toolLabel(toolId).label;
  }
}

/**
 * Vencimientos: `listCommitments` con los dos estados que la pantalla trata
 * como trabajo, y su mismo horizonte. Vienen ordenados por fecha ascendente, o
 * sea lo más vencido primero, que es exactamente el orden que quiere un índice.
 */
async function readCommitments(db: Db, now: number): Promise<Preview> {
  try {
    const today = bogotaToday(new Date(now));
    // El mismo horizonte que usa el conteo de nav-signals, por la misma razón:
    // `due_soon` depende de `notice_days` fila por fila y no se puede expresar
    // en SQL, así que la consulta se acota y el estado se deriva encima.
    const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + 120 * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const rows = await listCommitments(db, {
      states: ['overdue', 'due_soon'],
      reviewState: 'confirmed',
      dueBefore: horizon,
      today,
      limit: 200,
    });
    const views = rows.map((row) => adaptCommitment(row, today));
    const overdue = views.filter((v) => v.state === 'overdue');

    return {
      items: views.slice(0, PREVIEW).map((v) => ({
        id: v.id,
        title: v.title,
        detail: [v.kindLabel, v.counterparty].filter(Boolean).join(' · ') || null,
        when:
          v.daysLeft < 0
            ? `se venció ${whenPhrase(v.daysLeft)}`
            : `vence ${whenPhrase(v.daysLeft)}`,
        tone: (v.state === 'overdue' ? 'rose' : 'amber') as StatusTone,
      })),
      error: null,
      // Para un vencimiento, «cuánto lleva esperando» son los días que lleva
      // pasado de fecha. Lo que todavía no vence no lleva esperando nada.
      oldestDays: overdue.length > 0 ? Math.max(...overdue.map((v) => -v.daysLeft)) : null,
      overdue: overdue.length,
    };
  } catch (err) {
    return failed('los vencimientos', err);
  }
}

/**
 * Acciones: la misma lista de `waiting` que arma app/(app)/actions/page.tsx —
 * 'proposed' menos las que se quedaron sin figuras vigentes — ordenada por la
 * más vieja, que es la que duele.
 *
 * El límite es el techo de la lectura, no del conteo: el número que se dibuja
 * viene de `countNavSignals` y es exacto. Una propuesta caduca a los siete días
 * (PROPOSAL_TTL_MS), así que esta cola no puede crecer indefinidamente.
 */
async function readActions(db: Db, userId: string, now: number): Promise<Preview> {
  try {
    const rows = await hydrateOwners(
      db,
      await listActions(db, {
        userId,
        states: ['proposed'],
        approvableAt: new Date(now),
        limit: 60,
      }),
    );
    const oldestFirst = [...rows].sort(
      (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
    );

    return {
      items: oldestFirst.slice(0, PREVIEW).map((row) => {
        const action = adaptAction(row);
        return {
          id: action.id,
          // El asunto del correo, que es como lo llamaría quien lo escribió.
          title: action.subject || ACTION_KIND_LABEL[action.kind] || 'Correo redactado',
          detail: [ACTION_KIND_LABEL[action.kind], row.recipient].filter(Boolean).join(' · '),
          when: `redactada ${agoPhrase(now - Date.parse(row.created_at))}`,
          tone: 'primary' as StatusTone,
        };
      }),
      error: null,
      oldestDays: oldestFirst.length > 0 ? daysSince(oldestFirst[0]?.created_at ?? '', now) : null,
      overdue: 0,
    };
  } catch (err) {
    return failed('los correos redactados', err);
  }
}

/**
 * Encargos: los que se atascaron y preguntaron algo.
 *
 * `listErrands` es la lectura que usa /errands y no distingue estados, así que
 * el filtro se aplica aquí igual que allí. Nota heredada: esa función se traga
 * su propio error y devuelve una lista vacía, de modo que un fallo de lectura
 * aquí se ve como «ningún encargo atascado» con el conteo al lado diciendo lo
 * contrario. Es el motivo por el que el conteo se dibuja SIEMPRE, venga o no
 * contenido con él.
 */
async function readErrands(db: Db, organizationId: string, now: number): Promise<Preview> {
  try {
    const errands = await listErrands(db, organizationId, 60);
    const blocked = errands
      .filter((e) => e.state === 'blocked')
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    return {
      items: blocked.slice(0, PREVIEW).map((e) => ({
        id: e.id,
        title: e.request,
        detail: e.openQuestions > 0 ? 'Te preguntó algo y está esperando' : 'Se atascó',
        when: `encargado ${agoPhrase(now - Date.parse(e.createdAt))}`,
        tone: 'amber' as StatusTone,
      })),
      error: null,
      oldestDays: blocked.length > 0 ? daysSince(blocked[0]?.createdAt ?? '', now) : null,
      overdue: 0,
    };
  } catch (err) {
    return failed('los encargos', err);
  }
}
