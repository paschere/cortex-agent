import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type MetricSpec,
  MetricUnavailableError,
  UnknownMetricError,
  metricByKey,
} from './catalog';
import {
  type Cadence,
  type MetricDirection,
  type MetricUnit,
  type Period,
  type ReadingStatus,
  judge,
  lastClosedPeriod,
} from './shape';

/**
 * Toda lectura y toda escritura de una meta, en un módulo.
 *
 * La pantalla y el cron pasan por aquí, que es lo que impide que las dos reglas
 * que importan tengan dos implementaciones:
 *
 *   UNA META SÓLO EXISTE SI ESTE ESPACIO PUEDE MEDIRLA. `writeGoal` vuelve a
 *   ejecutar `available(db)` aunque el selector ya lo hiciera. El selector es
 *   cortesía; esto es la regla. Un formulario manipulado, una métrica que dejó
 *   de estar disponible entre que se abrió la pantalla y se pulsó el botón, o
 *   una llamada desde otro sitio dan todas el mismo error, con la misma frase
 *   que explica qué falta.
 *
 *   UNA LECTURA ESCRITA NO SE RECALCULA. `recordGoalReading` INSERTA, y si el
 *   período ya tiene fila deja la que hay y la devuelve. Quien decide que ya
 *   existe es el índice único de la 0101, no un `if (!exists)` que dos
 *   ejecuciones simultáneas ganan siempre. Y la tabla no tiene concedido UPDATE
 *   ni para service_role, así que tampoco hay una segunda forma de tocarla.
 *
 * `db` es siempre un handle con alcance de espacio de trabajo. Nada de aquí
 * filtra por `organization_id` a mano y nada de aquí debería recibir un cliente
 * en crudo.
 */

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

export const GOAL_COLUMNS =
  'id, organization_id, metric_key, label, cadence, target_value, direction, unit, state, created_by, created_at, updated_at, archived_at, archived_by';

export const READING_COLUMNS =
  'id, goal_id, period_start, period_end, value, display, unit, source_id, method, target_value, direction, sample_size, status, computed_at';

export const NOTICE_COLUMNS =
  'id, goal_id, reading_id, period_start, notice_class, sent_on, channel, recipient_user_id, recipient_email, delivered, note, settled_at, created_at';

export interface GoalRow {
  id: string;
  organization_id: string;
  metric_key: string;
  label: string;
  cadence: Cadence;
  target_value: number;
  direction: MetricDirection;
  unit: MetricUnit;
  state: 'active' | 'archived';
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  archived_by: string | null;
  /** Rellenado por `hydrateGoals`. Nombres, no ids. */
  created_by_name?: string | null;
}

export interface GoalReadingRow {
  id: string;
  goal_id: string;
  period_start: string;
  period_end: string;
  value: number | null;
  display: string;
  unit: MetricUnit;
  source_id: string;
  method: string;
  target_value: number;
  direction: MetricDirection;
  sample_size: number;
  status: ReadingStatus;
  computed_at: string;
}

export type NoticeClass = 'breached' | 'recovered';

export interface GoalNoticeRow {
  id: string;
  goal_id: string;
  reading_id: string | null;
  period_start: string;
  notice_class: NoticeClass;
  sent_on: string;
  channel: 'email' | 'none';
  recipient_user_id: string | null;
  recipient_email: string | null;
  delivered: boolean;
  note: string | null;
  settled_at: string | null;
  created_at: string;
}

/**
 * `numeric` vuelve de PostgREST como texto en unas configuraciones y como
 * número en otras. Una cifra que a veces es `"45.0000"` y a veces `45` es la
 * clase de cosa que compara mal en silencio, así que se normaliza en el borde.
 */
function num(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function adaptGoal(row: Record<string, unknown>): GoalRow {
  return {
    ...(row as unknown as GoalRow),
    target_value: num(row.target_value as number | string) ?? 0,
  };
}

function adaptReading(row: Record<string, unknown>): GoalReadingRow {
  return {
    ...(row as unknown as GoalReadingRow),
    value: num(row.value as number | string | null),
    target_value: num(row.target_value as number | string) ?? 0,
    sample_size: num(row.sample_size as number | string) ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------------

export interface ListGoalsOptions {
  state?: 'active' | 'archived';
  metricKey?: string;
  limit?: number;
}

export async function listGoals(
  db: SupabaseClient,
  opts: ListGoalsOptions = {},
): Promise<GoalRow[]> {
  let q = db.from('goals').select(GOAL_COLUMNS);
  q = q.eq('state', opts.state ?? 'active');
  if (opts.metricKey) q = q.eq('metric_key', opts.metricKey);
  const { data, error } = await q.order('created_at', { ascending: true }).limit(opts.limit ?? 100);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(adaptGoal);
}

export async function getGoal(db: SupabaseClient, id: string): Promise<GoalRow | null> {
  const { data, error } = await db.from('goals').select(GOAL_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? adaptGoal(data as Record<string, unknown>) : null;
}

/**
 * Nombres, no ids. Una meta la fijó alguien, y «la fijó 8f3c-…-a1» no se puede
 * decir en voz alta — que es justo lo que `created_by NOT NULL` existe para
 * poder hacer.
 */
export async function hydrateGoals(db: SupabaseClient, rows: GoalRow[]): Promise<GoalRow[]> {
  if (rows.length === 0) return rows;
  const ids = [...new Set(rows.map((r) => r.created_by))];
  const { data, error } = await db.from('users').select('id, name, email').in('id', ids);
  if (error) throw error;
  const byId = new Map(
    ((data ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => [
      u.id,
      u.name?.trim() || u.email,
    ]),
  );
  return rows.map((r) => ({ ...r, created_by_name: byId.get(r.created_by) ?? null }));
}

/** El histórico de una meta, lo más reciente primero. */
export async function listReadings(
  db: SupabaseClient,
  goalId: string,
  limit = 24,
): Promise<GoalReadingRow[]> {
  const { data, error } = await db
    .from('goal_readings')
    .select(READING_COLUMNS)
    .eq('goal_id', goalId)
    .order('period_start', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as Array<Record<string, unknown>>).map(adaptReading);
}

/** La lectura de un período concreto, o nada si todavía no se ha congelado. */
export async function readingFor(
  db: SupabaseClient,
  goalId: string,
  periodStart: string,
): Promise<GoalReadingRow | null> {
  const { data, error } = await db
    .from('goal_readings')
    .select(READING_COLUMNS)
    .eq('goal_id', goalId)
    .eq('period_start', periodStart)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptReading(data as Record<string, unknown>) : null;
}

export async function listGoalNotices(
  db: SupabaseClient,
  goalId: string,
  limit = 20,
): Promise<GoalNoticeRow[]> {
  const { data, error } = await db
    .from('goal_notices')
    .select(NOTICE_COLUMNS)
    .eq('goal_id', goalId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as GoalNoticeRow[];
}

// ---------------------------------------------------------------------------
// public.goals — la única puerta de escritura
// ---------------------------------------------------------------------------

export interface WriteGoalInput {
  metricKey: string;
  /** Cómo la llama quien la fija. Vacío = la etiqueta de la métrica. */
  label?: string | null;
  cadence: Cadence;
  targetValue: number;
  /** Quién la fija. Obligatorio, y es la mitad del punto de la tabla. */
  createdBy: string;
}

/**
 * Fijar una meta, o negarse a fijarla y decir por qué.
 *
 * LAS TRES NEGATIVAS, EN ORDEN:
 *
 *   1. La métrica no existe en el catálogo. Es un error de programación o un
 *      formulario manipulado; ninguno de los dos merece una fila.
 *
 *   2. La métrica existe pero ESTE espacio de trabajo no puede calcularla hoy.
 *      Aquí es donde vive la regla entera del módulo: la meta no se crea, y el
 *      mensaje es el mismo que enseña el selector, con qué hacer para
 *      desbloquearla. Una casilla vacía resta más confianza de la que suma, y
 *      lo único que impide la casilla vacía es que no exista la fila.
 *
 *   3. Ya hay una meta activa para esa métrica y esa cadencia. Dos cifras para
 *      la misma pregunta enseñan a desconfiar de las dos. Lo garantiza además
 *      `goals_active_metric_idx`; esto sólo convierte la violación en una
 *      frase.
 *
 * `direction` y `unit` NO se reciben: se copian del catálogo. Que el llamador
 * pudiera decir que menos cartera es peor sería una forma de invertir un
 * veredicto desde un formulario.
 */
export async function writeGoal(db: SupabaseClient, input: WriteGoalInput): Promise<GoalRow> {
  const spec = metricByKey(input.metricKey);
  if (!spec) throw new UnknownMetricError(input.metricKey);

  if (!Number.isFinite(input.targetValue)) {
    throw new ValidationError('El objetivo tiene que ser un número.');
  }
  if (spec.unit === 'percent' && (input.targetValue < 0 || input.targetValue > 100)) {
    throw new ValidationError('Un objetivo en porcentaje va entre 0 y 100.');
  }
  if (input.targetValue < 0) {
    throw new ValidationError('El objetivo no puede ser negativo.');
  }
  if (!input.createdBy) {
    throw new ValidationError(
      'Una meta necesita saber quién la fijó: es una declaración, y una declaración sin autor no se puede discutir con nadie.',
    );
  }

  const verdict = await spec.available(db);
  if (!verdict.available) {
    throw new MetricUnavailableError(
      spec.key,
      verdict.reason ?? 'Este espacio de trabajo todavía no puede calcular esa métrica.',
    );
  }

  const existing = await listGoals(db, { state: 'active', metricKey: spec.key });
  if (existing.some((g) => g.cadence === input.cadence)) {
    throw new ValidationError(
      `Ya hay una meta activa de «${spec.label}» con esa periodicidad. Retira la que hay antes de fijar otra: dos cifras para la misma pregunta enseñan a desconfiar de las dos.`,
    );
  }

  const { data, error } = await db
    .from('goals')
    .insert({
      metric_key: spec.key,
      label: input.label?.trim() || spec.label,
      cadence: input.cadence,
      target_value: input.targetValue,
      // Copiadas del catálogo, nunca del llamador. Ver la cabecera.
      direction: spec.direction,
      unit: spec.unit,
      created_by: input.createdBy,
    })
    .select(GOAL_COLUMNS)
    .single();
  if (error) throw error;
  return adaptGoal(data as Record<string, unknown>);
}

/**
 * Retirar una meta. Nunca se borra: sus lecturas son historia, y un histórico
 * sin la declaración que lo explicaba no se puede leer.
 */
export async function archiveGoal(
  db: SupabaseClient,
  id: string,
  userId: string,
): Promise<GoalRow> {
  if (!userId) {
    throw new ValidationError(
      'Retirar una meta es un acto de una persona, y hace falta su nombre.',
    );
  }
  const now = new Date().toISOString();
  const { data, error } = await db
    .from('goals')
    .update({ state: 'archived', archived_at: now, archived_by: userId, updated_at: now })
    .eq('id', id)
    .eq('state', 'active')
    .select(GOAL_COLUMNS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('Esa meta no existe o ya estaba retirada.');
  return adaptGoal(data as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// public.goal_readings — la única puerta de escritura, y es de un solo sentido
// ---------------------------------------------------------------------------

export interface RecordReadingInput {
  goalId: string;
  period: Period;
  value: number | null;
  display: string;
  unit: MetricUnit;
  sourceId: string;
  method: string;
  targetValue: number;
  direction: MetricDirection;
  sampleSize: number;
  status: ReadingStatus;
}

export interface RecordReadingResult {
  /**
   * `recorded`: la fila se escribió ahora.
   * `frozen`:   ese período ya estaba escrito y no se ha tocado.
   */
  outcome: 'recorded' | 'frozen';
  reading: GoalReadingRow;
}

/**
 * Congelar la lectura de un período.
 *
 * LO QUE HACE ESTA FUNCIÓN CUANDO EL PERÍODO YA ESTÁ ESCRITO ES NO HACER NADA,
 * Y ESO ES TODO EL DISEÑO. No compara, no actualiza «por si acaso», no rellena
 * un campo que faltaba. Devuelve la fila que ya había y dice `frozen`.
 *
 * Si en vez de eso hiciera un upsert, el histórico se recalcularía cada mañana:
 * la fila de julio pasaría a contener el número de septiembre con la etiqueta
 * de julio, y nadie podría notarlo porque las dos versiones parecen correctas.
 * Es el fallo de marcador-contra-fotografía que la 0079 argumenta en detalle
 * para los informes, un piso más abajo.
 *
 * Y quien decide que ya existe es POSTGRES, con `goal_readings_once`. Un
 * `if (!existe) insertar` lo pierden siempre dos ejecuciones simultáneas —y el
 * cron reintenta, y los despliegues reinician pasos—, así que la carrera se
 * resuelve donde no hay carrera: el segundo INSERT vuelve con 23505 y esta
 * función lo lee como «ya estaba dicho».
 */
export async function recordGoalReading(
  db: SupabaseClient,
  input: RecordReadingInput,
): Promise<RecordReadingResult> {
  const insert = await db
    .from('goal_readings')
    .insert({
      goal_id: input.goalId,
      period_start: input.period.start,
      period_end: input.period.end,
      value: input.value,
      display: input.display,
      unit: input.unit,
      source_id: input.sourceId,
      method: input.method,
      target_value: input.targetValue,
      direction: input.direction,
      sample_size: input.sampleSize,
      status: input.status,
    })
    .select(READING_COLUMNS)
    .single();

  if (!insert.error) {
    return { outcome: 'recorded', reading: adaptReading(insert.data as Record<string, unknown>) };
  }
  if (insert.error.code !== '23505') throw insert.error;

  const existing = await readingFor(db, input.goalId, input.period.start);
  if (!existing) {
    // El índice dijo que hay fila y la lectura no la encuentra: la única
    // explicación es que pertenezca a otro espacio de trabajo, y entonces esta
    // no es una carrera sino un error que hay que ver.
    throw insert.error;
  }
  return { outcome: 'frozen', reading: existing };
}

/**
 * Medir un período y congelarlo, en un paso.
 *
 * El veredicto se calcula aquí y se guarda: `judge` compara el número con el
 * objetivo Y LA DIRECCIÓN QUE TENÍA LA META EN ESTE MOMENTO, y los dos se
 * copian a la fila. Volver a juzgar al leer sería recalcular historia por la
 * puerta de atrás — la fila diría «incumplida» o «cumplida» según cómo esté
 * configurada la meta hoy, que es precisamente lo que no puede pasar.
 */
export async function measureAndRecord(
  db: SupabaseClient,
  goal: GoalRow,
  period: Period,
  spec: MetricSpec,
): Promise<RecordReadingResult> {
  const measurement = await spec.measure(db, period);
  const status = judge(measurement.value, goal.target_value, goal.direction);
  return recordGoalReading(db, {
    goalId: goal.id,
    period,
    value: measurement.value,
    display: measurement.display,
    unit: goal.unit,
    sourceId: spec.source.id,
    method: measurement.method,
    targetValue: goal.target_value,
    direction: goal.direction,
    sampleSize: measurement.sampleSize,
    status,
  });
}

/**
 * El período en curso, medido EN VIVO y sin guardarse en ninguna parte.
 *
 * La pantalla lo enseña marcado como «en curso» porque una meta mensual fijada
 * el día 2 no puede dejar a alguien tres semanas mirando una tabla vacía. No es
 * una predicción —es el número de lo que va del período, con su método— y sobre
 * todo NO ES UNA FILA: en el momento en que se guardara, cambiaría cada mañana.
 */
export async function measureLive(
  db: SupabaseClient,
  goal: GoalRow,
  period: Period,
  spec: MetricSpec,
): Promise<{
  period: Period;
  value: number | null;
  display: string;
  method: string;
  status: ReadingStatus;
  sampleSize: number;
}> {
  const measurement = await spec.measure(db, period);
  return {
    period,
    value: measurement.value,
    display: measurement.display,
    method: measurement.method,
    sampleSize: measurement.sampleSize,
    status: judge(measurement.value, goal.target_value, goal.direction),
  };
}

// ---------------------------------------------------------------------------
// public.goal_notices — la única puerta de escritura
// ---------------------------------------------------------------------------

export interface ClaimNoticeInput {
  goalId: string;
  readingId: string | null;
  periodStart: string;
  noticeClass: NoticeClass;
  sentOn: string;
  recipientUserId: string | null;
  recipientEmail: string | null;
}

export interface ClaimNoticeResult {
  /** `claimed`: es tuyo, manda. `taken`: alguien ya lo dijo, cállate. */
  outcome: 'claimed' | 'taken';
  id: string | null;
}

/**
 * «¿Ya dijimos esto?», decidido por el índice único y no por esta función.
 *
 * Misma mecánica que `claimNotice` en compromisos (0069): se reclama antes de
 * mandar, se gana o se pierde la reclamación, y correr el cron diez veces
 * seguidas manda un correo. El coste de un intento repetido es una llamada a
 * una API; el de un MENSAJE repetido es una persona aprendiendo a ignorar a
 * Cortex.
 */
export async function claimGoalNotice(
  db: SupabaseClient,
  input: ClaimNoticeInput,
): Promise<ClaimNoticeResult> {
  const { data, error } = await db
    .from('goal_notices')
    .insert({
      goal_id: input.goalId,
      reading_id: input.readingId,
      period_start: input.periodStart,
      notice_class: input.noticeClass,
      sent_on: input.sentOn,
      channel: input.recipientEmail ? 'email' : 'none',
      recipient_user_id: input.recipientUserId,
      recipient_email: input.recipientEmail,
      delivered: false,
    })
    .select('id')
    .single();

  if (!error) return { outcome: 'claimed', id: (data as { id: string }).id };
  if (error.code === '23505') return { outcome: 'taken', id: null };
  throw error;
}

/**
 * El resultado del envío, separado de la reclamación.
 *
 * Un aviso reclamado cuyo envío falló se queda en `delivered=false` y lo
 * reintenta la ejecución del día siguiente: la fila no se vuelve a crear, sólo
 * se repite el intento. Como máximo un mensaje, como mínimo un intento.
 */
export async function settleGoalNotice(
  db: SupabaseClient,
  input: { id: string; delivered: boolean; note?: string | null },
): Promise<void> {
  const { error } = await db
    .from('goal_notices')
    .update({
      delivered: input.delivered,
      note: input.note ?? null,
      settled_at: new Date().toISOString(),
    })
    .eq('id', input.id);
  if (error) throw error;
}

/**
 * Un aviso reclamado que nunca llegó a mandarse: se borra para que el día
 * siguiente lo vuelva a intentar de verdad.
 *
 * Existe por un caso concreto: la reclamación se gana, y entonces resulta que
 * no hay a quién mandarle el correo. Dejar la fila haría que ese incumplimiento
 * no se avisara NUNCA —el índice único lo bloquearía para siempre— por un
 * problema que se arregla asignando un correo. Sólo borra filas sin entregar y
 * sin cerrar, así que nunca puede reabrir un mensaje que sí salió.
 */
export async function releaseGoalNotice(db: SupabaseClient, id: string): Promise<void> {
  const { error } = await db
    .from('goal_notices')
    .delete()
    .eq('id', id)
    .eq('delivered', false)
    .is('settled_at', null);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Lo que el cron tiene que decidir, sin base de datos de por medio
// ---------------------------------------------------------------------------

/**
 * ¿Qué avisos debe este período, dado lo que dijo el anterior?
 *
 *   breached   El período cerró del lado malo del umbral.
 *   recovered  Cumplió, y el anterior no. El lazo que se cierra.
 *
 * Un período `unmeasurable` no debe nada: no hubo nada que medir, y mandar una
 * alarma por un mes en el que la empresa no cerró un solo compromiso es la
 * forma más rápida de que alguien filtre los correos de Cortex a la papelera.
 *
 * Y TAMPOCO CORTA UNA RACHA. `previousStatus` es el último estado MEDIBLE
 * anterior, no el del período inmediatamente anterior — lo resuelve
 * `lastMeasuredStatus`. Si julio incumplió, agosto no tuvo datos y septiembre
 * cumple, septiembre es una recuperación de lo de julio; leerlo del mes vacío
 * se tragaría el único correo que cierra el lazo.
 */
export function goalNoticesOwed(input: {
  status: ReadingStatus;
  previousStatus: ReadingStatus | null;
}): NoticeClass[] {
  if (input.status === 'breached') return ['breached'];
  if (input.status === 'met' && input.previousStatus === 'breached') return ['recovered'];
  return [];
}

/**
 * El último veredicto que de verdad se pudo medir antes de este período.
 *
 * Salta los `unmeasurable`, por la razón de arriba. Devuelve nulo cuando la
 * meta no tiene todavía ningún período juzgado, que es el caso de una meta
 * recién fijada — y una meta recién fijada que cumple no ha «recuperado» nada.
 */
export async function lastMeasuredStatus(
  db: SupabaseClient,
  goalId: string,
  beforePeriodStart: string,
): Promise<ReadingStatus | null> {
  const { data, error } = await db
    .from('goal_readings')
    .select('status, period_start')
    .eq('goal_id', goalId)
    .lt('period_start', beforePeriodStart)
    .order('period_start', { ascending: false })
    .limit(12);
  if (error) throw error;
  const rows = (data ?? []) as Array<{ status: ReadingStatus }>;
  return rows.find((r) => r.status !== 'unmeasurable')?.status ?? null;
}

export { lastClosedPeriod };
