import 'server-only';
import {
  type ErrandFact,
  type FlowRunFact,
  type Journal,
  type JournalLine,
  type LingeringFact,
  type MandateUseFact,
  type RoutineRunFact,
  type SentFact,
  buildJournal,
  composeCommitmentWatch,
  composeDrafts,
  composeErrands,
  composeFlows,
  composeLearning,
  composeLingering,
  composeMandateUses,
  composeMemories,
  composeRoutines,
  composeSends,
  instant,
} from './journal-shape';
import { authorizationPhrase } from './mandates/delegation';
import { mustReadList } from './supabase/read';
import { getOrgScopedClient } from './supabase/service';
import { toolLabel } from './tool-labels';

/**
 * LAS LECTURAS DE LA JORNADA.
 *
 * `journal-shape.ts` tiene el argumento entero de por qué esta pantalla existe
 * y por qué ninguna de sus frases sale de un modelo. Aquí sólo se leen filas.
 *
 * ===========================================================================
 * EL PRESUPUESTO, Y POR QUÉ SON DOCE CONSULTAS Y NO UNA
 * ===========================================================================
 * La actividad de Cortex está repartida en once tablas que no comparten forma
 * ni dueño: un aviso de vencimiento, una corrida de trámite y un uso de mandato
 * no se parecen en nada salvo en que ocurrieron. No hay tabla de eventos que
 * las una —`audit_events` sólo ve llamadas de herramienta, no barridas— así que
 * unificarlas exigiría una vista materializada y un trigger por tabla, o sea
 * una migración y un escritor nuevo por cada clase de trabajo. No vale la pena
 * para una pantalla que se lee una vez al día.
 *
 * Lo que sí se acota, y es lo que hace esto barato:
 *
 *   VENTANA. Desde la medianoche de Bogotá de AYER. Nunca más de 48 horas, y
 *   normalmente menos. Es la ventana que hace falta para contar «anoche y hoy»,
 *   que es todo lo que esta pantalla promete.
 *
 *   ÍNDICE. Cada consulta cae sobre un índice que ya existe y que empieza por
 *   `organization_id` seguido de la marca de tiempo por la que se filtra:
 *   commitment_notices_org_sent_idx, actions_org_state_idx,
 *   mandate_uses_org_idx, browser_flow_runs_org_idx, scheduled_job_runs_org_idx,
 *   learning_adjustments (org, created_at), learning_proposals_open_idx.
 *   Las dos que no —`user_memories` y `errands`— caen sobre tablas acotadas por
 *   diseño: las memorias tienen tope por persona, y los encargos vivos tienen
 *   control de admisión (MAX_LIVE_ERRANDS).
 *
 *   LÍMITE. Todas llevan `limit`. Un espacio con más de 200 avisos en dos días
 *   verá «avisé de 200», que es una cifra baja, no una mentira sobre la
 *   naturaleza del día.
 *
 *   PARALELO. Las doce salen a la vez, así que cuestan un viaje de ida y vuelta,
 *   no doce. /dashboard ya hacía seis; esto lo lleva a dieciocho.
 *
 * Deliberadamente NO se lee `learning_signals` (indexada por `observed_at`, que
 * es cuándo ocurrió el turno original y no cuándo corrió la pasada: filtrar por
 * `created_at` sería un recorrido secuencial sobre una tabla de 180 días) ni
 * `notifications`, que es una proyección de estas mismas filas y contarla haría
 * que cada trámite fallido apareciera dos veces.
 *
 * ===========================================================================
 * UNA FUENTE CAÍDA NO TUMBA LA PANTALLA — PERO TAMPOCO SE CALLA
 * ===========================================================================
 * Cada clase de actividad se lee en su propio `try`. Si falla, esa clase se
 * omite y su nombre entra en `gaps`, que la pantalla dibuja al pie: «no pude
 * leer los trámites». La regla de `lib/supabase/read.ts` dice que el contenido
 * falla en voz alta, y eso es exactamente lo que hace `gaps` — sin permitir que
 * un índice caído borre las otras diez clases de trabajo del día.
 */

/** A partir de cuántos días en silencio un correo enviado es noticia. */
const LINGERING_DAYS = 7;

/**
 * Cuánto puede llevar abierto un trámite antes de que sea «se quedó a medias».
 *
 * Un trámite de portal tarda entre segundos y un par de minutos. Veinte minutos
 * significa que el portal pidió algo que sólo una persona puede dar —un
 * captcha, una clave, una verificación— o que la corrida murió. Las dos cosas
 * exigen que alguien mire, que es lo único que la línea afirma.
 */
const FLOW_STALL_MS = 20 * 60_000;

type Db = ReturnType<typeof getOrgScopedClient>;

/** Una clase de actividad leída: sus líneas, o el hueco que dejó al fallar. */
interface Slice {
  lines: JournalLine[];
  gap: string | null;
}

async function slice(what: string, read: () => Promise<JournalLine[]>): Promise<Slice> {
  try {
    return { lines: await read(), gap: null };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { lines: [], gap: `No pude leer ${what}: ${detail}` };
  }
}

/**
 * La medianoche de Bogotá del día dado, como instante.
 *
 * Aquí sí se escribe el desfase a mano —Colombia es UTC-5 y no tiene horario de
 * verano desde 1993— porque lo que se necesita es un límite para un `WHERE`, y
 * `Date.parse` con el desfase explícito es la forma más corta de decirlo sin
 * ambigüedad. Convertir un instante A un día del calendario sí usa `Intl`; ver
 * `bogotaDay` en `journal-shape.ts`.
 */
function bogotaMidnight(day: string): number {
  return Date.parse(`${day}T00:00:00-05:00`);
}

function bogotaDayOf(at: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * Todo lo que Cortex hizo anoche y hoy.
 *
 * @param isAdmin decide si las líneas de mandato enlazan a `/admin/mandates`.
 *   El texto es el mismo para todo el mundo —quien fue el sujeto de una acción
 *   sin preguntar tiene derecho a leerla— pero un enlace a una pantalla que va
 *   a rebotar es peor que ninguno.
 */
export async function readJournal(
  organizationId: string,
  userId: string,
  opts: { isAdmin?: boolean; now?: Date } = {},
): Promise<Journal> {
  const db = getOrgScopedClient(organizationId);
  const now = (opts.now ?? new Date()).getTime();

  // La ventana: desde la medianoche de ayer en Bogotá. Entre 24 y 48 horas.
  const sinceDay = bogotaDayOf(now - 86_400_000);
  const since = bogotaMidnight(sinceDay);
  const sinceIso = new Date(since).toISOString();

  const [
    commitments,
    drafts,
    sends,
    mandates,
    flows,
    routines,
    errands,
    memories,
    learning,
    lingering,
  ] = await Promise.all([
    slice('los vencimientos', () => readCommitmentWatch(db, sinceDay, since)),
    slice('los correos que dejé redactados', () => readDrafts(db, userId, sinceIso)),
    slice('los correos que salieron', () => readSends(db, userId, sinceIso, since)),
    slice('lo que hice sin preguntarte', () =>
      readMandateUses(db, userId, sinceIso, since, opts.isAdmin ?? false),
    ),
    slice('los trámites', () => readFlows(db, sinceIso, since, now)),
    slice('las rutinas', () => readRoutines(db, userId, sinceIso, since)),
    slice('los encargos', () => readErrands(db, sinceIso, since)),
    slice('lo que aprendí de cómo trabajas', () => readMemories(db, userId, sinceIso, since)),
    slice('el repaso de Brain Knowledge', () => readLearning(db, sinceIso, since)),
    slice('los correos sin respuesta', () => readLingering(db, userId, now)),
  ]);

  const timeline = [
    commitments,
    drafts,
    sends,
    mandates,
    flows,
    routines,
    errands,
    memories,
    learning,
  ];

  return buildJournal({
    lines: timeline.flatMap((s) => s.lines),
    lingering: lingering.lines,
    gaps: [...timeline, lingering].map((s) => s.gap).filter((g): g is string => g !== null),
    now,
  });
}

// ---------------------------------------------------------------------------
// Una clase de actividad, una lectura
// ---------------------------------------------------------------------------

interface NoticeRow {
  id: string;
  notice_kind: string;
  delivered: boolean;
  created_at: string;
}

/**
 * El vigilante de las 06:00: los avisos que dejó, y cuántos vencimientos vivos
 * había para revisar.
 *
 * `sent_on` es una fecha del calendario de Bogotá y es la columna indexada, así
 * que acota la lectura; `created_at` es el instante y es el que fecha la línea.
 * Los dos filtros están puestos a propósito: el primero para el índice, el
 * segundo para la ventana real.
 */
async function readCommitmentWatch(
  db: Db,
  sinceDay: string,
  since: number,
): Promise<JournalLine[]> {
  const [noticesRes, watchedRes] = await Promise.all([
    db
      .from('commitment_notices')
      .select('id, notice_kind, delivered, created_at')
      .gte('sent_on', sinceDay)
      .order('created_at', { ascending: false })
      .limit(200),
    // Un conteo, no contenido: `head: true` no trae ni una fila. El error se
    // mira explícitamente porque `mustRead` sólo sabe de `data`, y un conteo
    // roto tiene que quitar el denominador de la frase, no inventarlo.
    db
      .from('commitments')
      .select('id', { count: 'exact', head: true })
      .eq('review_state', 'confirmed')
      .in('state', ['in_force', 'due_soon', 'overdue']),
  ]);

  const notices = mustReadList<NoticeRow>(noticesRes, 'los avisos de vencimiento');
  const watched = watchedRes.error ? null : (watchedRes.count ?? null);

  const facts = notices
    .map((row) => {
      const at = instant(row.created_at);
      if (at === null || at < since) return null;
      return {
        id: row.id,
        at,
        kind: row.notice_kind as 'ahead' | 'due_today' | 'overdue' | 'escalation',
        delivered: row.delivered === true,
      };
    })
    .filter((f): f is NonNullable<typeof f> => f !== null);

  return composeCommitmentWatch(facts, watched);
}

/**
 * Los correos que la barrida de las 06:30 dejó listos y siguen sin aprobar.
 *
 * Filtrado por persona igual que /actions y que el badge de la barra lateral:
 * un borrador se manda con la firma de su dueño, así que no es trabajo que
 * Cortex hiciera «para el espacio».
 */
async function readDrafts(db: Db, userId: string, sinceIso: string): Promise<JournalLine[]> {
  const rows = mustReadList<{ id: string; created_at: string }>(
    await db
      .from('actions')
      .select('id, created_at')
      .eq('user_id', userId)
      .eq('state', 'proposed')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(100),
    'los correos que dejé redactados',
  );

  return composeDrafts(
    rows
      .map((r) => ({ id: r.id, at: instant(r.created_at) }))
      .filter((r): r is { id: string; at: number } => r.at !== null),
  );
}

interface ExecutedRow {
  id: string;
  recipient: string;
  subject: string;
  executed_at: string | null;
  execution_status: string | null;
  execution_error: string | null;
}

/** Lo que efectivamente salió con la firma de alguien, dentro de la ventana. */
async function readSends(
  db: Db,
  userId: string,
  sinceIso: string,
  since: number,
): Promise<JournalLine[]> {
  const rows = mustReadList<ExecutedRow>(
    await db
      .from('actions')
      .select('id, recipient, subject, executed_at, execution_status, execution_error')
      .eq('user_id', userId)
      .gte('executed_at', sinceIso)
      .order('executed_at', { ascending: false })
      .limit(50),
    'los correos que salieron',
  );

  const facts: SentFact[] = [];
  for (const row of rows) {
    const at = instant(row.executed_at);
    if (at === null || at < since) continue;
    facts.push({
      id: row.id,
      at,
      recipient: row.recipient,
      ok: row.execution_status === 'ok',
      error: row.execution_error,
    });
  }
  return composeSends(facts);
}

interface GrantRow {
  label: string;
  created_at: string;
  granted_by: string;
}

interface MandateUseRow {
  id: string;
  tool_id: string;
  used_at: string;
  amount: number | string | null;
  currency: string | null;
  mandates: GrantRow | GrantRow[] | null;
}

/**
 * Lo que Cortex hizo sin preguntar, con el mandato que lo autorizó.
 *
 * ESTA LECTURA NO ES `listRecentUses` (lib/mandates/store.ts), y la diferencia
 * es deliberada: aquélla sirve a la pantalla del mandato, agrega por concesión
 * y se trae hasta mil filas sin el `id` de cada uso ni el nombre de la
 * concesión. Aquí hace falta lo contrario —treinta filas de dos días, cada una
 * con su identidad y su etiqueta— así que son dos preguntas distintas sobre la
 * misma tabla, no dos copias de la misma.
 *
 * Lo que SÍ se comparte es la frase: `authorizationPhrase` es exactamente la
 * que ve alguien en el chat cuando Cortex acaba de actuar por su cuenta, y
 * escribirla dos veces sería tener dos versiones de la razón por la que estaba
 * permitido.
 *
 * El nombre de quien concedió NO se resuelve: costaría una lectura más de
 * `users` para una frase que ya es verificable sin él («como me autorizaron el
 * 3 de agosto»), y quien quiera el nombre lo tiene en /admin/mandates, a un
 * clic desde la propia línea.
 */
async function readMandateUses(
  db: Db,
  userId: string,
  sinceIso: string,
  since: number,
  isAdmin: boolean,
): Promise<JournalLine[]> {
  const rows = mustReadList<MandateUseRow>(
    await db
      .from('mandate_uses')
      .select('id, tool_id, used_at, amount, currency, mandates(label, created_at, granted_by)')
      .gte('used_at', sinceIso)
      .order('used_at', { ascending: false })
      .limit(30),
    'lo que hice sin preguntarte',
  );

  const now = new Date();
  const facts: MandateUseFact[] = [];
  for (const row of rows) {
    const at = instant(row.used_at);
    if (at === null || at < since) continue;
    const grant = Array.isArray(row.mandates) ? row.mandates[0] : row.mandates;
    facts.push({
      id: row.id,
      at,
      toolLabel: toolLabel(row.tool_id).label,
      mandateLabel: grant?.label ?? 'sin nombre',
      authorization: grant
        ? authorizationPhrase(
            {
              label: grant.label,
              grantedByName: null,
              grantedByIsViewer: grant.granted_by === userId,
              createdAt: grant.created_at,
            },
            now,
          )
        : null,
      amount: money(row.amount, row.currency),
    });
  }

  const lines = composeMandateUses(facts);
  return isAdmin ? lines.map((l) => ({ ...l, href: '/admin/mandates' })) : lines;
}

/** «$1.200.000». Una moneda rara no puede romper la pantalla, así que se cae al texto plano. */
function money(amount: number | string | null, currency: string | null): string | null {
  if (amount === null || currency === null) return null;
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) return null;
  try {
    return new Intl.NumberFormat('es-CO', {
      style: 'currency',
      currency,
      maximumFractionDigits: currency === 'COP' ? 0 : 2,
    }).format(value);
  } catch {
    return `${value} ${currency}`;
  }
}

interface FlowRunRow {
  id: string;
  status: string;
  error: string | null;
  started_at: string;
  browser_flows: { name: string } | { name: string }[] | null;
}

async function readFlows(
  db: Db,
  sinceIso: string,
  since: number,
  now: number,
): Promise<JournalLine[]> {
  const rows = mustReadList<FlowRunRow>(
    await db
      .from('browser_flow_runs')
      .select('id, status, error, started_at, browser_flows(name)')
      .gte('started_at', sinceIso)
      .order('started_at', { ascending: false })
      .limit(40),
    'los trámites',
  );

  const facts: FlowRunFact[] = [];
  for (const row of rows) {
    const at = instant(row.started_at);
    if (at === null || at < since) continue;
    const flow = Array.isArray(row.browser_flows) ? row.browser_flows[0] : row.browser_flows;
    facts.push({
      id: row.id,
      at,
      name: flow?.name ?? 'sin nombre',
      status: row.status as FlowRunFact['status'],
      error: row.error,
      stalled: now - at > FLOW_STALL_MS,
    });
  }
  return composeFlows(facts);
}

interface RoutineRunRow {
  id: string;
  status: string;
  error: string | null;
  started_at: string;
  scheduled_jobs: { name: string } | { name: string }[] | null;
}

/**
 * Las rutinas de esta persona, con el mismo filtro por dueño que el panel que
 * ya vive en /dashboard: una rutina corre con las credenciales de quien la
 * programó, así que no es trabajo que Cortex hiciera para los demás.
 */
async function readRoutines(
  db: Db,
  userId: string,
  sinceIso: string,
  since: number,
): Promise<JournalLine[]> {
  const rows = mustReadList<RoutineRunRow>(
    await db
      .from('scheduled_job_runs')
      .select('id, status, error, started_at, scheduled_jobs!inner(name, user_id)')
      .eq('scheduled_jobs.user_id', userId)
      .gte('started_at', sinceIso)
      .order('started_at', { ascending: false })
      .limit(60),
    'las rutinas',
  );

  const facts: RoutineRunFact[] = [];
  for (const row of rows) {
    const at = instant(row.started_at);
    if (at === null || at < since) continue;
    const job = Array.isArray(row.scheduled_jobs) ? row.scheduled_jobs[0] : row.scheduled_jobs;
    facts.push({
      id: row.id,
      at,
      name: job?.name ?? 'sin nombre',
      status: row.status as RoutineRunFact['status'],
      error: row.error,
    });
  }
  return composeRoutines(facts);
}

interface ErrandRow {
  id: string;
  request: string;
  state: string;
  closing_note: string | null;
  finished_at: string | null;
  updated_at: string;
}

/**
 * Encargos que se movieron en la ventana.
 *
 * Se filtra por `updated_at`, que no tiene índice propio — pero la consulta cae
 * primero sobre `errands_org_created_idx` por el `organization_id` que añade el
 * handle, y el número de encargos de un espacio está acotado por el control de
 * admisión. Un encargo entregado se fecha en `finished_at`, que es cuándo
 * terminó de verdad; los demás en `updated_at`.
 */
async function readErrands(db: Db, sinceIso: string, since: number): Promise<JournalLine[]> {
  const rows = mustReadList<ErrandRow>(
    await db
      .from('errands')
      .select('id, request, state, closing_note, finished_at, updated_at')
      .gte('updated_at', sinceIso)
      .order('updated_at', { ascending: false })
      .limit(20),
    'los encargos',
  );

  const facts: ErrandFact[] = [];
  for (const row of rows) {
    const at = instant(row.finished_at) ?? instant(row.updated_at);
    if (at === null || at < since) continue;
    const state = (['delivered', 'failed', 'exhausted', 'blocked', 'cancelled'] as const).find(
      (s) => s === row.state,
    );
    facts.push({
      id: row.id,
      at,
      request: row.request,
      state: state ?? 'other',
      closingNote: row.closing_note,
    });
  }
  return composeErrands(facts);
}

/** Lo que el cron de las 02:00 propuso recordar de esta persona. */
async function readMemories(
  db: Db,
  userId: string,
  sinceIso: string,
  since: number,
): Promise<JournalLine[]> {
  const rows = mustReadList<{ id: string; created_at: string }>(
    await db
      .from('user_memories')
      .select('id, created_at')
      .eq('user_id', userId)
      .eq('status', 'suggested')
      .eq('source', 'derived')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(20),
    'lo que aprendí de cómo trabajas',
  );

  const facts = [];
  for (const row of rows) {
    const at = instant(row.created_at);
    if (at === null || at < since) continue;
    facts.push({ id: row.id, at });
  }
  return composeMemories(facts);
}

/**
 * La pasada de aprendizaje de las 04:20, contada por lo que dejó escrito.
 *
 * Dos consultas con `count: 'exact'` y `limit(1)`: una sola ida devuelve el
 * total y la fila más reciente, que es todo lo que la frase necesita — cuántos
 * y a qué hora.
 */
async function readLearning(db: Db, sinceIso: string, since: number): Promise<JournalLine[]> {
  const [adjRes, propRes] = await Promise.all([
    db
      .from('learning_adjustments')
      .select('created_at', { count: 'exact' })
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1),
    db
      .from('learning_proposals')
      .select('created_at', { count: 'exact' })
      .eq('status', 'open')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(1),
  ]);

  const adjustments = mustReadList<{ created_at: string }>(
    adjRes,
    'los ajustes de Brain Knowledge',
  );
  const proposals = mustReadList<{ created_at: string }>(propRes, 'las conclusiones que dejé');

  const adjustedAt = instant(adjustments[0]?.created_at);
  const proposedAt = instant(proposals[0]?.created_at);

  return composeLearning({
    adjustments: adjustedAt !== null && adjustedAt >= since ? (adjRes.count ?? 0) : 0,
    proposals: proposedAt !== null && proposedAt >= since ? (propRes.count ?? 0) : 0,
    adjustedAt,
    proposedAt,
  });
}

/**
 * Correos que salieron y nadie contestó nunca.
 *
 * `outcome = 'awaiting'` es exactamente eso: enviado, sin respuesta y sin que
 * el seguimiento haya cerrado la ventana. Se leen los más viejos primero
 * (`executed_at` ascendente) porque el que más lleva es el que duele, y se
 * descartan los que aún no llegan a `LINGERING_DAYS` — un cobro de anteayer no
 * es una noticia, es el trabajo del día.
 */
async function readLingering(db: Db, userId: string, now: number): Promise<JournalLine[]> {
  const rows = mustReadList<ExecutedRow>(
    await db
      .from('actions')
      .select('id, recipient, subject, executed_at, execution_status, execution_error')
      .eq('user_id', userId)
      .eq('outcome', 'awaiting')
      .not('executed_at', 'is', null)
      .order('executed_at', { ascending: true })
      .limit(20),
    'los correos sin respuesta',
  );

  const facts: LingeringFact[] = [];
  for (const row of rows) {
    const at = instant(row.executed_at);
    if (at === null) continue;
    const days = Math.floor((now - at) / 86_400_000);
    if (days < LINGERING_DAYS) continue;
    facts.push({ id: row.id, at, recipient: row.recipient, subject: row.subject, days });
  }
  return composeLingering(facts);
}
