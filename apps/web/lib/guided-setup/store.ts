import 'server-only';

import type {
  Handoff,
  OutOfScope,
  ProposedItem,
  SetupItem,
  SetupKind,
  SetupPayload,
} from '@/lib/guided-setup-shape';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * La memoria de la entrevista: lo que se dijo, lo que se propuso y qué se creó.
 *
 * Todo pasa por el handle con alcance de empresa, así que ninguna consulta de
 * este archivo nombra `organization_id` — lo pone el cliente al pasar, y una
 * empresa no puede leer ni tocar la sesión de otra aunque tenga el uuid. El
 * test `apply.test.ts` lo comprueba con dos empresas en la misma tabla.
 *
 * El servidor es el dueño del hilo. El cliente manda una frase y el id de la
 * sesión, nada más: ni el conteo de preguntas ni el plan viajan de vuelta para
 * que se los crea. Esto no es paranoia con el navegador, es que el tope de
 * preguntas y la lista de lo aprobable son las dos reglas que sostienen la
 * pantalla, y una regla que viaja por la red es una regla opcional.
 */

const SESSIONS = 'guided_setup_sessions';
const ITEMS = 'guided_setup_items';

export type SessionStatus = 'interviewing' | 'proposed' | 'applied' | 'discarded';

export interface Turn {
  role: 'person' | 'cortex';
  text: string;
  at: string;
}

export interface Session {
  id: string;
  status: SessionStatus;
  transcript: Turn[];
  askedCount: number;
  outOfScope: OutOfScope[];
  handoffs: Handoff[];
  summary: string | null;
  startedBy: string | null;
  createdAt: string;
  appliedAt: string | null;
}

const SESSION_COLUMNS =
  'id, status, transcript, asked_count, out_of_scope, handoffs, summary, started_by, created_at, applied_at';
const ITEM_COLUMNS =
  'id, kind, title, rationale, payload, status, target_table, target_id, error, created_at';

type Row = Record<string, unknown>;

function adaptSession(row: Row): Session {
  return {
    id: row.id as string,
    status: row.status as SessionStatus,
    transcript: Array.isArray(row.transcript) ? (row.transcript as Turn[]) : [],
    askedCount: Number(row.asked_count ?? 0),
    outOfScope: Array.isArray(row.out_of_scope) ? (row.out_of_scope as OutOfScope[]) : [],
    handoffs: Array.isArray(row.handoffs) ? (row.handoffs as Handoff[]) : [],
    summary: (row.summary as string | null) ?? null,
    startedBy: (row.started_by as string | null) ?? null,
    createdAt: row.created_at as string,
    appliedAt: (row.applied_at as string | null) ?? null,
  };
}

function adaptItem(row: Row): SetupItem {
  return {
    id: row.id as string,
    kind: row.kind as SetupKind,
    title: row.title as string,
    rationale: (row.rationale as string) ?? '',
    payload: (row.payload ?? {}) as SetupPayload,
    status: row.status as SetupItem['status'],
    targetTable: (row.target_table as string | null) ?? null,
    targetId: (row.target_id as string | null) ?? null,
    error: (row.error as string | null) ?? null,
  };
}

export async function startSession(db: SupabaseClient, userId: string): Promise<Session> {
  const { data, error } = await db
    .from(SESSIONS)
    .insert({ started_by: userId })
    .select(SESSION_COLUMNS)
    .single();
  if (error) throw error;
  return adaptSession(data as Row);
}

export async function getSession(db: SupabaseClient, id: string): Promise<Session | null> {
  const { data, error } = await db
    .from(SESSIONS)
    .select(SESSION_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data ? adaptSession(data as Row) : null;
}

/**
 * La sesión más reciente, en el estado que esté.
 *
 * Incluye las ya aplicadas a propósito: el recibo — qué se creó y el botón de
 * deshacerlo — tiene que sobrevivir a que alguien recargue la página o vuelva
 * media hora después. Un "deshacer" que sólo existe mientras no se recargue no
 * es un deshacer.
 */
export async function latestSession(db: SupabaseClient): Promise<Session | null> {
  const { data, error } = await db
    .from(SESSIONS)
    .select(SESSION_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const rows = (data ?? []) as Row[];
  return rows[0] ? adaptSession(rows[0]) : null;
}

export async function listItems(db: SupabaseClient, sessionId: string): Promise<SetupItem[]> {
  const { data, error } = await db
    .from(ITEMS)
    .select(ITEM_COLUMNS)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Row[]).map(adaptItem);
}

export async function appendTurns(
  db: SupabaseClient,
  session: Session,
  turns: readonly Turn[],
  asked: number,
): Promise<void> {
  const { error } = await db
    .from(SESSIONS)
    .update({
      transcript: [...session.transcript, ...turns],
      asked_count: asked,
      updated_at: new Date().toISOString(),
    })
    .eq('id', session.id);
  if (error) throw error;
}

/**
 * Guarda el plan ANTES de que nadie lo apruebe.
 *
 * Es el paso que hace que «confirmar» signifique algo. Cuando la persona toca
 * el botón, el servidor no lee lo que el navegador le mande: lee estas filas y
 * cruza los ids. Así no hay forma de que se cree algo que la entrevista nunca
 * propuso, ni siquiera con la petición armada a mano.
 *
 * Reproponer borra las propuestas anteriores de la misma sesión y no toca nada
 * más: lo ya creado tiene otro estado y sobrevive.
 */
export async function savePlan(
  db: SupabaseClient,
  sessionId: string,
  plan: {
    summary: string;
    items: readonly ProposedItem[];
    outOfScope: readonly OutOfScope[];
    handoffs: readonly Handoff[];
  },
): Promise<SetupItem[]> {
  const wipe = await db.from(ITEMS).delete().eq('session_id', sessionId).eq('status', 'proposed');
  if (wipe.error) throw wipe.error;

  let inserted: SetupItem[] = [];
  if (plan.items.length > 0) {
    const { data, error } = await db
      .from(ITEMS)
      .insert(
        plan.items.map((item) => ({
          session_id: sessionId,
          kind: item.kind,
          title: item.title,
          rationale: item.rationale,
          payload: item.payload,
          // Explícito aunque la columna lo tenga por defecto: «propuesto» es lo
          // único que esta función puede escribir, y decirlo aquí hace que se
          // lea en el sitio donde importa.
          status: 'proposed',
        })),
      )
      .select(ITEM_COLUMNS);
    if (error) throw error;
    inserted = ((data ?? []) as Row[]).map(adaptItem);
  }

  const { error } = await db
    .from(SESSIONS)
    .update({
      status: 'proposed',
      summary: plan.summary,
      out_of_scope: plan.outOfScope,
      handoffs: plan.handoffs,
      proposed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', sessionId);
  if (error) throw error;

  return inserted;
}

export async function markSessionApplied(db: SupabaseClient, sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db
    .from(SESSIONS)
    .update({ status: 'applied', applied_at: now, updated_at: now })
    .eq('id', sessionId);
  if (error) throw error;
}

export async function discardSession(db: SupabaseClient, sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  const wipe = await db
    .from(ITEMS)
    .update({ status: 'skipped', decided_at: now })
    .eq('session_id', sessionId)
    .eq('status', 'proposed');
  if (wipe.error) throw wipe.error;
  const { error } = await db
    .from(SESSIONS)
    .update({ status: 'discarded', updated_at: now })
    .eq('id', sessionId);
  if (error) throw error;
}

export async function markItem(
  db: SupabaseClient,
  itemId: string,
  patch: {
    status: SetupItem['status'];
    targetTable?: string | null;
    targetId?: string | null;
    error?: string | null;
    decidedBy?: string | null;
    undone?: boolean;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db
    .from(ITEMS)
    .update({
      status: patch.status,
      target_table: patch.targetTable ?? null,
      target_id: patch.targetId ?? null,
      error: patch.error ?? null,
      decided_at: now,
      decided_by: patch.decidedBy ?? null,
      ...(patch.undone ? { undone_at: now } : {}),
    })
    .eq('id', itemId);
  if (error) throw error;
}

/**
 * Sólo los ítems que ESTA sesión propuso y que siguen esperando, cruzados con
 * los ids que la persona marcó. Todo lo que no salga de aquí no se crea.
 */
export async function pickProposed(
  db: SupabaseClient,
  sessionId: string,
  ids: readonly string[],
): Promise<SetupItem[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db
    .from(ITEMS)
    .select(ITEM_COLUMNS)
    .eq('session_id', sessionId)
    .eq('status', 'proposed')
    .in('id', ids as string[])
    .order('created_at', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as Row[]).map(adaptItem);
}

/**
 * Lo que quedó sin marcar cuando alguien confirmó el resto. Se anota como
 * `skipped` en vez de borrarse: un plan del que se aceptan dos de seis dice
 * algo que un plan aceptado entero no dice, y esa es justo la señal que sirve
 * para afinar lo que la entrevista propone.
 */
export async function skipRemaining(
  db: SupabaseClient,
  sessionId: string,
  userId: string,
): Promise<number> {
  const { data, error } = await db
    .from(ITEMS)
    .update({ status: 'skipped', decided_at: new Date().toISOString(), decided_by: userId })
    .eq('session_id', sessionId)
    .eq('status', 'proposed')
    .select('id');
  if (error) throw error;
  return ((data ?? []) as Row[]).length;
}

export async function proposedItem(
  db: SupabaseClient,
  itemId: string,
): Promise<(SetupItem & { sessionId: string }) | null> {
  const { data, error } = await db
    .from(ITEMS)
    .select(`${ITEM_COLUMNS}, session_id`)
    .eq('id', itemId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as Row;
  return { ...adaptItem(row), sessionId: row.session_id as string };
}

// ---------------------------------------------------------------------------
// La pregunta de las dos semanas
// ---------------------------------------------------------------------------

export interface Liveness {
  item: SetupItem;
  /** La fila sigue existiendo en su módulo. */
  alive: boolean;
  /** Y además alguien la usó: hay una señal de uso, no sólo de existencia. */
  used: boolean;
  /** En una frase, qué se miró para decirlo. */
  evidence: string;
}

export interface SetupReview {
  created: number;
  alive: number;
  used: number;
  rows: Liveness[];
  /** Cuándo se aplicó la última entrevista, para saber si ya toca preguntar. */
  appliedAt: string | null;
}

const DEAD = { alive: false, used: false, evidence: 'Ya no está.' } as const;

/**
 * ¿SIRVIÓ ESTO, O SÓLO SE VIO BONITO EL PRIMER DÍA?
 *
 * La tentación es medir el éxito con «cuántas cosas creó la entrevista», que es
 * el número que sube solo y que un onboarding entusiasta sube generando ruido.
 * La medida que importa es otra y llega tarde a propósito: de lo que se creó
 * hablando, ¿qué sigue ahí dos semanas después, y qué de eso alguien miró?
 *
 * No inventa telemetría. Cada módulo ya lleva su propia señal de vida y esto se
 * limita a preguntársela: los vencimientos tienen estado, las rutinas tienen
 * corridas, los flujos llevan `times_run`, los clientes tienen `updated_at` y
 * un espacio tiene documentos o no los tiene. Cinco lecturas baratas contra
 * cinco tablas que ya existían.
 *
 * Distingue `alive` de `used` porque las dos respuestas duelen distinto. Algo
 * que sobrevivió pero nadie tocó es una rutina que no molesta y no sirve — el
 * peor resultado, porque no se queja. Algo que desapareció, al menos, alguien
 * lo miró y lo decidió.
 */
export async function reviewGuidedSetup(db: SupabaseClient): Promise<SetupReview> {
  const { data, error } = await db
    .from(ITEMS)
    .select(ITEM_COLUMNS)
    .in('status', ['created', 'merged'])
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) throw error;

  const items = ((data ?? []) as Row[]).map(adaptItem);
  const rows = await Promise.all(items.map((item) => liveness(db, item)));

  const lastApplied = await db
    .from(SESSIONS)
    .select('applied_at')
    .eq('status', 'applied')
    .order('applied_at', { ascending: false })
    .limit(1);

  return {
    created: rows.length,
    alive: rows.filter((r) => r.alive).length,
    used: rows.filter((r) => r.used).length,
    rows,
    appliedAt: ((lastApplied.data ?? [])[0]?.applied_at as string | null) ?? null,
  };
}

async function liveness(db: SupabaseClient, item: SetupItem): Promise<Liveness> {
  if (!item.targetTable || !item.targetId) {
    return { item, alive: false, used: false, evidence: 'Sin rastro de dónde quedó.' };
  }
  try {
    switch (item.kind) {
      case 'commitment': {
        const { data } = await db
          .from('commitments')
          .select('state, met_at')
          .eq('id', item.targetId)
          .maybeSingle();
        if (!data) return { item, ...DEAD };
        const row = data as Row;
        if (row.state === 'dropped') {
          return { item, alive: false, used: true, evidence: 'La descartaron a mano.' };
        }
        const met = row.met_at != null;
        return {
          item,
          alive: true,
          used: met,
          evidence: met ? 'Alguien la marcó como cumplida.' : 'Sigue vigilada, todavía sin tocar.',
        };
      }
      case 'routine': {
        const { data } = await db
          .from('scheduled_jobs')
          .select('status')
          .eq('id', item.targetId)
          .maybeSingle();
        if (!data) return { item, ...DEAD };
        const { count } = await db
          .from('scheduled_job_runs')
          .select('id', { count: 'exact', head: true })
          .eq('job_id', item.targetId);
        const runs = count ?? 0;
        return {
          item,
          alive: true,
          used: runs > 0,
          evidence: runs > 0 ? `Ha corrido ${runs} ${runs === 1 ? 'vez' : 'veces'}.` : 'Nunca ha corrido.',
        };
      }
      case 'flow': {
        const { data } = await db
          .from('pipelines')
          .select('times_run')
          .eq('id', item.targetId)
          .maybeSingle();
        if (!data) return { item, ...DEAD };
        const times = Number((data as Row).times_run ?? 0);
        return {
          item,
          alive: true,
          used: times > 0,
          evidence: times > 0 ? `Lo han corrido ${times} ${times === 1 ? 'vez' : 'veces'}.` : 'Nadie lo ha corrido.',
        };
      }
      case 'client': {
        const { data } = await db
          .from('clients')
          .select('created_at, updated_at')
          .eq('id', item.targetId)
          .maybeSingle();
        if (!data) return { item, ...DEAD };
        const row = data as Row;
        const touched =
          typeof row.updated_at === 'string' &&
          typeof row.created_at === 'string' &&
          Date.parse(row.updated_at) - Date.parse(row.created_at) > 60_000;
        return {
          item,
          alive: true,
          used: touched,
          evidence: touched ? 'Lo han editado después.' : 'Ahí está, sin cambios.',
        };
      }
      case 'space': {
        const { data } = await db
          .from('kb_collections')
          .select('id')
          .eq('id', item.targetId)
          .maybeSingle();
        if (!data) return { item, ...DEAD };
        const { count } = await db
          .from('kb_documents')
          .select('id', { count: 'exact', head: true })
          .eq('collection_id', item.targetId);
        const docs = count ?? 0;
        return {
          item,
          alive: true,
          used: docs > 0,
          evidence: docs > 0 ? `Tiene ${docs} ${docs === 1 ? 'documento' : 'documentos'}.` : 'Sigue vacío.',
        };
      }
    }
  } catch {
    // Una señal de uso que falla no puede tumbar la pantalla que la muestra.
    return { item, alive: true, used: false, evidence: 'No se pudo revisar ahora.' };
  }
}

