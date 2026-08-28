import type { SupabaseClient } from '@supabase/supabase-js';
import type { BrowserHandoff, HandoffReason } from './types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  UN TRÁMITE PARADO ESPERANDO A UNA PERSONA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Hay exactamente dos cosas que una grabación no puede grabar: el captcha, y
 * el código que el banco manda al celular. Las dos son parte del trámite, no
 * accidentes suyos — quien lo hace a mano las hace todos los meses.
 *
 * Antes de esta tabla, el servicio de navegador ya sabía sostener la pestaña
 * abierta en un captcha y devolver un `handoff`, y una pantalla ya sabía
 * pintarlo y dejar que alguien hiciera clic. Lo que faltaba era que ESO
 * SOBREVIVIERA A LA PANTALLA. El handoff era un objeto en la respuesta de una
 * petición: si quien corrió el trámite cerró la pestaña, o si el trámite lo
 * corrió un encargo a las tres de la mañana, la sesión se quedaba abierta sin
 * que nadie supiera que existía, se barría sola y el trabajo se perdía entero.
 *
 * Un checkpoint es esa misma pausa, escrita. Con eso, un encargo puede
 * bloquearse como se bloquea ante cualquier otra pregunta (`errand_questions`,
 * 0089), avisarle a alguien por los canales que ya existen, y reanudar la
 * MISMA pestaña cuando conteste.
 *
 * ── LO QUE UNA FILA NO PUEDE PROMETER ─────────────────────────────────────
 *
 * Detrás de esta fila hay un proceso: una pestaña de Chromium en un contenedor
 * de Railway, con las cookies y el formulario a medio llenar. Esa pestaña se
 * barre a los pocos minutos de que nadie venga y no sobrevive a un redeploy.
 * Guardar filas no arregla eso, y fingir que sí es peor que decirlo.
 *
 * Entonces `isLive` es la única forma de preguntar si un checkpoint sirve, y
 * responde que no en cuanto pasó su hora. Un checkpoint vencido no es una
 * falla: es «se acabó el tiempo, arranco el trámite otra vez». Eso se puede
 * hacer, cuesta unos segundos, y es una frase que una persona entiende.
 */

export interface Checkpoint {
  id: string;
  flowId: string;
  runId: string | null;
  sessionId: string;
  reason: HandoffReason;
  ask: string;
  /** El slot que llena la respuesta. Null en un bot-check. */
  fills: string | null;
  fromIndex: number;
  /** Redactados. El dato que esta pausa espera NO está aquí. */
  inputs: Record<string, string>;
  errandId: string | null;
  errandQuestionId: string | null;
  state: 'open' | 'resumed' | 'expired' | 'cancelled';
  expiresAt: string;
  createdAt: string;
}

const COLUMNS =
  'id, flow_id, run_id, session_id, reason, ask, fills, from_index, inputs, ' +
  'errand_id, errand_question_id, state, expires_at, created_at';

function rowToCheckpoint(row: Record<string, unknown>): Checkpoint {
  return {
    id: row.id as string,
    flowId: row.flow_id as string,
    runId: (row.run_id as string | null) ?? null,
    sessionId: row.session_id as string,
    reason: row.reason as HandoffReason,
    ask: (row.ask as string) ?? '',
    fills: (row.fills as string | null) ?? null,
    fromIndex: (row.from_index as number) ?? 0,
    inputs: (row.inputs as Record<string, string>) ?? {},
    errandId: (row.errand_id as string | null) ?? null,
    errandQuestionId: (row.errand_question_id as string | null) ?? null,
    state: (row.state as Checkpoint['state']) ?? 'open',
    expiresAt: row.expires_at as string,
    createdAt: row.created_at as string,
  };
}

/**
 * ¿Sirve todavía?
 *
 * Pura, y separada de todo lo que toca la base, porque es la pregunta que
 * hacen cuatro sitios distintos — la pantalla antes de pintar un botón, el
 * encargo antes de reanudar, la herramienta antes de llamar al servicio, y el
 * barrido — y la respuesta tiene que ser la misma en los cuatro.
 *
 * El margen de cinco segundos no es paranoia: entre leer la fila y llegar al
 * servicio hay una petición HTTP, y un checkpoint que vence en el camino
 * produce un 404 del servicio en vez de una frase. Lo caro no es perder cinco
 * segundos de ventana; es que la persona reciba «esa sesión ya no existe»
 * cuando la pantalla acababa de ofrecerle el botón.
 */
const RESUME_MARGIN_MS = 5_000;

export function isLive(checkpoint: Checkpoint, now = Date.now()): boolean {
  if (checkpoint.state !== 'open') return false;
  const expires = Date.parse(checkpoint.expiresAt);
  if (!Number.isFinite(expires)) return false;
  return expires - RESUME_MARGIN_MS > now;
}

/** Cuánto queda, en segundos, para decirlo en una frase. Nunca negativo. */
export function secondsLeft(checkpoint: Checkpoint, now = Date.now()): number {
  const expires = Date.parse(checkpoint.expiresAt);
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, Math.round((expires - now) / 1000));
}

export interface OpenCheckpointInput {
  organizationId: string;
  flowId: string;
  runId: string | null;
  handoff: BrowserHandoff;
  /** Ya redactados por `safeInputs`. */
  inputs: Record<string, string>;
  errandId?: string | null;
  createdBy: string | null;
}

/**
 * Escribir la pausa.
 *
 * Devuelve null y no lanza cuando la escritura falla, y eso es deliberado: la
 * pestaña YA está abierta y sostenida del otro lado, así que el trámite ya se
 * paró pase lo que pase aquí. Lo que se pierde si esto falla es la posibilidad
 * de volver a ella más tarde, y lo que hay que hacer con esa pérdida es
 * contarla como «hacía falta una persona y no alcancé a guardar dónde», que es
 * lo que hace el llamador. Lanzar convertiría una pausa recuperable en una
 * corrida caída.
 */
export async function openCheckpoint(
  db: SupabaseClient,
  input: OpenCheckpointInput,
): Promise<Checkpoint | null> {
  const { handoff } = input;
  const { data, error } = await db
    .from('browser_flow_checkpoints')
    .insert({
      organization_id: input.organizationId,
      flow_id: input.flowId,
      run_id: input.runId,
      session_id: handoff.sessionId,
      reason: handoff.reason,
      ask: (handoff.ask ?? defaultAsk(handoff.reason)).slice(0, 600),
      fills: handoff.fills ?? null,
      from_index: Math.max(0, handoff.fromIndex),
      inputs: input.inputs,
      errand_id: input.errandId ?? null,
      // Written rather than left to the column default: `closeCheckpoint`
      // guards on this exact value, and a guard that depends on a default
      // having been applied is a guard with a hole in it.
      state: 'open',
      expires_at: handoff.expiresAt,
      created_by: input.createdBy,
    })
    .select(COLUMNS)
    .maybeSingle();

  if (error || !data) return null;
  return rowToCheckpoint(data as unknown as Record<string, unknown>);
}

/**
 * La frase de un bot-check, cuando el servicio no mandó una.
 *
 * Vive aquí y no en la pantalla porque la misma pausa se cuenta en tres sitios
 * — el botón de correr, el chat y la pregunta del encargo — y tres frases
 * distintas sobre el mismo captcha se leen como tres problemas distintos.
 */
export function defaultAsk(reason: HandoffReason): string {
  return reason === 'bot-check'
    ? 'El portal se detuvo a comprobar que no somos un robot. Resuelve la verificación en la pantalla del trámite y sigo desde ahí; la sesión sigue abierta con todo lo que ya llevaba hecho.'
    : 'El trámite necesita un dato que sólo tú tienes en este momento.';
}

export async function getCheckpoint(db: SupabaseClient, id: string): Promise<Checkpoint | null> {
  const { data } = await db
    .from('browser_flow_checkpoints')
    .select(COLUMNS)
    .eq('id', id)
    .maybeSingle();
  return data ? rowToCheckpoint(data as unknown as Record<string, unknown>) : null;
}

/** La pausa abierta de este encargo, si la hay. Ver el índice de 0111. */
export async function openCheckpointForErrand(
  db: SupabaseClient,
  errandId: string,
): Promise<Checkpoint | null> {
  const { data } = await db
    .from('browser_flow_checkpoints')
    .select(COLUMNS)
    .eq('errand_id', errandId)
    .eq('state', 'open')
    .order('created_at', { ascending: false })
    .limit(1);
  const row = ((data as unknown as Record<string, unknown>[]) ?? [])[0];
  return row ? rowToCheckpoint(row) : null;
}

/** Todo lo que este espacio de trabajo tiene parado ahora mismo. */
export async function listOpenCheckpoints(db: SupabaseClient): Promise<Checkpoint[]> {
  const { data } = await db
    .from('browser_flow_checkpoints')
    .select(COLUMNS)
    .eq('state', 'open')
    .order('created_at', { ascending: false })
    .limit(50);
  return ((data as unknown as Record<string, unknown>[]) ?? []).map(rowToCheckpoint);
}

/**
 * Amarrar la pausa a la pregunta del encargo que la está esperando.
 *
 * Dos escrituras separadas y no una, porque la pregunta se escribe con la
 * maquinaria de encargos (`askAndBlock`), que no sabe nada de trámites y no
 * debe. Este es el hilo que las cose después.
 */
export async function linkQuestion(
  db: SupabaseClient,
  checkpointId: string,
  questionId: string,
): Promise<void> {
  await db
    .from('browser_flow_checkpoints')
    .update({ errand_question_id: questionId })
    .eq('id', checkpointId)
    .eq('state', 'open');
}

/**
 * Cerrar la pausa.
 *
 * UPDATE condicional con el estado en el WHERE, igual que todo lo que mueve un
 * encargo: dos personas contestando el mismo captcha a la vez tienen que
 * producir UNA reanudación, y sólo la base puede decidir cuál llegó primero.
 * Devuelve si esta llamada fue la que la cerró.
 */
export async function closeCheckpoint(
  db: SupabaseClient,
  id: string,
  state: 'resumed' | 'expired' | 'cancelled',
): Promise<boolean> {
  const { data } = await db
    .from('browser_flow_checkpoints')
    .update({ state, resolved_at: new Date().toISOString() })
    .eq('id', id)
    .eq('state', 'open')
    .select('id');
  return ((data as unknown[]) ?? []).length > 0;
}

/**
 * Vencer las que ya no tienen pestaña detrás.
 *
 * Se llama antes de mostrar o de contar checkpoints, no en un cron: la pestaña
 * ya se barrió sola del otro lado, así que esto no libera nada — sólo deja de
 * mentir. Hacerlo perezosamente significa que la verdad se corrige justo
 * cuando alguien va a leerla, que es el único momento en que importa.
 */
export async function expireStaleCheckpoints(db: SupabaseClient): Promise<void> {
  await db
    .from('browser_flow_checkpoints')
    .update({ state: 'expired', resolved_at: new Date().toISOString() })
    .eq('state', 'open')
    .lt('expires_at', new Date().toISOString())
    .select('id');
}
