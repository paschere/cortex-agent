import type { SupabaseClient } from '@supabase/supabase-js';
import type { BackfillWindow } from './threads';

/**
 * EL MARCAPÁGINAS DE UN BUZÓN: leerlo y escribirlo, en un solo módulo.
 *
 * Todo lo que toca `gmail_sync_state` pasa por aquí, por la misma razón que
 * `notifications/notify.ts` es el único escritor de los avisos: el día que la
 * tabla gane una columna obligatoria, «revisa todas las funciones que escriben»
 * tiene que ser una frase con un solo destinatario.
 *
 * `db` es SIEMPRE un handle con espacio de trabajo. Nada aquí filtra por
 * `organization_id` a mano y nada aquí puede recibir un cliente crudo.
 */

export interface GmailSyncState {
  userId: string;
  organizationId: string;
  emailAddress: string | null;
  spaceId: string | null;
  backfillWindow: BackfillWindow;
  backfillCursor: string | null;
  backfillThreads: number;
  backfillStartedAt: string | null;
  backfillDoneAt: string | null;
  historyId: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  paused: boolean;
}

const COLUMNS =
  'user_id, organization_id, email_address, space_id, backfill_window, backfill_cursor, backfill_threads, backfill_started_at, backfill_done_at, history_id, last_synced_at, last_error, paused';

interface Row {
  user_id: string;
  organization_id: string;
  email_address: string | null;
  space_id: string | null;
  backfill_window: BackfillWindow;
  backfill_cursor: string | null;
  backfill_threads: number;
  backfill_started_at: string | null;
  backfill_done_at: string | null;
  history_id: string | null;
  last_synced_at: string | null;
  last_error: string | null;
  paused: boolean;
}

function toState(row: Row): GmailSyncState {
  return {
    userId: row.user_id,
    organizationId: row.organization_id,
    emailAddress: row.email_address,
    spaceId: row.space_id,
    backfillWindow: row.backfill_window,
    backfillCursor: row.backfill_cursor,
    backfillThreads: row.backfill_threads ?? 0,
    backfillStartedAt: row.backfill_started_at,
    backfillDoneAt: row.backfill_done_at,
    historyId: row.history_id,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    paused: row.paused ?? false,
  };
}

export async function getSyncState(
  db: SupabaseClient,
  userId: string,
): Promise<GmailSyncState | null> {
  const { data, error } = await db
    .from('gmail_sync_state')
    .select(COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`No se pudo leer el estado del buzón: ${error.message}`);
  return data ? toState(data as unknown as Row) : null;
}

/**
 * Empezar (o volver a empezar) a aprender de un buzón.
 *
 * EL `historyId` SE GUARDA AQUÍ, ANTES DE BAJAR NADA, y ése es el detalle del
 * que depende que no se pierda correo. La carga histórica puede tardar horas;
 * si el puntero se tomara al terminarla, todo lo que llegara mientras tanto
 * caería en el hueco entre «esto ya no está en la ventana histórica» y «esto
 * todavía no estaba cuando empezó el barrido». Tomándolo al principio, lo peor
 * que pasa es que el primer barrido re-vea unos cuantos hilos que la carga ya
 * archivó — y volver a archivar un hilo idéntico no cuesta ni un embedding.
 */
export async function startTraining(
  db: SupabaseClient,
  input: {
    userId: string;
    emailAddress: string;
    spaceId: string;
    window: BackfillWindow;
    historyId: string | null;
  },
): Promise<GmailSyncState> {
  const { data, error } = await db
    .from('gmail_sync_state')
    .upsert(
      {
        user_id: input.userId,
        email_address: input.emailAddress,
        space_id: input.spaceId,
        backfill_window: input.window,
        backfill_cursor: null,
        backfill_threads: 0,
        backfill_started_at: new Date().toISOString(),
        backfill_done_at: null,
        history_id: input.historyId,
        last_error: null,
        paused: false,
      },
      { onConflict: 'user_id' },
    )
    .select(COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(`No se pudo empezar a aprender de ese buzón: ${error?.message}`);
  }
  return toState(data as unknown as Row);
}

/** Avanzar la carga histórica una tanda. */
export async function recordBackfillProgress(
  db: SupabaseClient,
  userId: string,
  input: { cursor: string | null; threadsAdded: number; done: boolean; error?: string | null },
): Promise<void> {
  const current = await getSyncState(db, userId);
  const { error } = await db
    .from('gmail_sync_state')
    .update({
      backfill_cursor: input.done ? null : input.cursor,
      backfill_threads: (current?.backfillThreads ?? 0) + input.threadsAdded,
      backfill_done_at: input.done ? new Date().toISOString() : null,
      last_error: input.error ?? null,
    })
    .eq('user_id', userId);
  if (error) throw new Error(`No se pudo anotar el avance de la carga: ${error.message}`);
}

/** Avanzar el puntero diario. Sólo se mueve cuando Gmail devolvió uno nuevo. */
export async function recordSweep(
  db: SupabaseClient,
  userId: string,
  input: { historyId: string | null; error?: string | null },
): Promise<void> {
  const fields: Record<string, unknown> = {
    last_synced_at: new Date().toISOString(),
    last_error: input.error ?? null,
  };
  // Un `historyId` nulo NO se escribe: borrar el puntero convertiría el barrido
  // de mañana en una relectura por fecha sin que nadie lo hubiera pedido.
  if (input.historyId) fields.history_id = input.historyId;
  const { error } = await db.from('gmail_sync_state').update(fields).eq('user_id', userId);
  if (error) throw new Error(`No se pudo anotar el barrido: ${error.message}`);
}

/** El interruptor. Lo usa la persona, y lo usa el barrido cuando el permiso se cayó. */
export async function setPaused(
  db: SupabaseClient,
  userId: string,
  paused: boolean,
  reason?: string,
): Promise<void> {
  await db
    .from('gmail_sync_state')
    .update({ paused, last_error: paused ? (reason ?? null) : null })
    .eq('user_id', userId);
}
