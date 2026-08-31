import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MailHeader } from '../inbox/filters';
import { fetchGmailAttachment } from './attachments';
import type { GmailFetchContext } from './client';
import { type ThreadIngestOutcome, ingestThread } from './ingest-thread';
import {
  type GmailSyncState,
  getSyncState,
  recordBackfillProgress,
  recordSweep,
  setPaused,
} from './sync-state';
import {
  type MailMessage,
  backfillQuery,
  fetchProfile,
  fetchThreadMessages,
  listHistoryThreadIds,
  listThreadPage,
  mailboxQuery,
} from './threads';

/**
 * APRENDER DE UN BUZÓN: la carga histórica y el barrido de cada mañana.
 *
 * Las dos hacen lo mismo —traerse unos hilos y doblarlos dentro del cerebro— y
 * se diferencian sólo en CÓMO eligen los hilos:
 *
 *   la carga    va hacia atrás por una ventana de tiempo, paginando con el
 *               `pageToken` de Gmail, y termina.
 *   el barrido  va hacia adelante desde el `historyId` de ayer, y no termina
 *               nunca.
 *
 * POR QUÉ ESTÁ AQUÍ Y NO EN EL TRABAJO DE VERCEL. El trabajo sabe de colas,
 * reintentos y de a quién le toca; esto sabe de correo. Separarlos es lo que
 * permite probar la parte difícil —qué hilos entran, qué pasa cuando el puntero
 * caduca— sin una cola de por medio, y es la misma línea que ya trazan
 * `errands/worker.ts` y `learning/pass.ts`.
 *
 * EL LOTE TIENE TECHO Y ES A PROPÓSITO. El puente de trabajos de Vercel corre
 * con `maxDuration=800`; un buzón de doce meses son miles de hilos y cada uno
 * son dos llamadas a Google más una tanda de embeddings. Así que cada ejecución
 * hace UNA página y deja escrito por dónde iba: el trabajo se vuelve a encolar
 * a sí mismo y la carga avanza a trozos que siempre caben. Un proceso que se
 * pasa de tiempo no deja «la mitad del buzón»: deja un cursor.
 */

export interface LearnContext extends GmailFetchContext {
  organizationId: string;
  userId: string;
  db: SupabaseClient;
  logger: Logger;
}

/** Hilos por tanda. Una página de Gmail, que es lo que cabe con holgura. */
export const THREADS_PER_BATCH = 60;

/**
 * Techo del barrido diario. Un buzón que recibe más de esto en un día es una
 * lista de correo o una migración, y en los dos casos meterlo entero al cerebro
 * de una vez no es lo que nadie quería. Se archiva el tope y se dice.
 */
export const MAX_SWEEP_THREADS = 200;

export interface IngestTally {
  imported: number;
  updated: number;
  unchanged: number;
  internal: number;
  /** Descartados por ser correo masivo: boletines, campañas, plataformas. */
  bulk: number;
  empty: number;
  failed: number;
  /**
   * Adjuntos archivados como documento propio, sumando toda la tanda (0124).
   * Aparte de `imported` porque no son hilos: una tanda puede no traer ningún
   * hilo nuevo y sí tres contratos que nunca habían entrado.
   */
  attachments: number;
}

function emptyTally(): IngestTally {
  return {
    imported: 0,
    updated: 0,
    unchanged: 0,
    internal: 0,
    bulk: 0,
    empty: 0,
    failed: 0,
    attachments: 0,
  };
}

/**
 * Archivar una lista de hilos, uno a uno, sin que uno malo tumbe la tanda.
 *
 * DE UNO EN UNO Y NO EN PARALELO. Gmail limita por usuario y por segundo, y
 * cada hilo dispara además una tanda de embeddings que también se paga por
 * minuto; diez a la vez sólo consigue que Google conteste 429 y que la tanda
 * termine antes con menos hilos archivados.
 */
export async function ingestThreads(
  ctx: LearnContext,
  input: { threadIds: string[]; spaceId: string },
): Promise<{ tally: IngestTally; documents: ArchivedThread[] }> {
  const tally = emptyTally();
  const documents: ArchivedThread[] = [];

  for (const threadId of input.threadIds) {
    let messages: MailMessage[];
    try {
      messages = await fetchThreadMessages(ctx, threadId);
    } catch (err) {
      tally.failed += 1;
      ctx.logger.warn(
        { err: (err as Error).message, thread: threadId },
        'gmail: no se pudo leer el hilo',
      );
      continue;
    }
    if (messages.length === 0) {
      tally.empty += 1;
      continue;
    }

    const result = await ingestThread(
      {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        db: ctx.db,
        logger: ctx.logger,
      },
      { threadId, spaceId: input.spaceId, messages },
      // La carga histórica y el barrido diario traen también los adjuntos: es
      // donde de verdad está el contrato del que habla el correo (0124).
      {
        fetchAttachment: (messageId, attachmentId) =>
          fetchGmailAttachment(ctx, messageId, attachmentId),
      },
    );
    tally[result.outcome] += 1;
    tally.attachments += result.attachments.archived;

    if (result.outcome === 'imported' || result.outcome === 'updated') {
      const last = messages[messages.length - 1];
      documents.push({
        threadId,
        subject: messages[0]?.subject ?? '(sin asunto)',
        lastMessageAt: new Date(last?.ms ?? 0).toISOString(),
        participants: result.participants,
        counterpartDomain: result.counterpartDomain,
        internalOnly: result.internalOnly,
        documentId: result.documentId,
        lastFromEmail: last?.fromEmail ?? null,
        lastFrom: last?.from ?? null,
        lastLabelIds: last?.labelIds ?? [],
        lastHeaders: last?.headers ?? [],
        lastSnippet: (last?.body ?? '').slice(0, 600),
        messages: messages.length,
      });
    }
  }

  return { tally, documents };
}

export interface ArchivedThread {
  threadId: string;
  subject: string;
  lastMessageAt: string;
  participants: string[];
  counterpartDomain: string | null;
  internalOnly: boolean;
  documentId: string | null;
  /** Quién escribió el último mensaje. De aquí sale «la pelota es tuya». */
  lastFromEmail: string | null;
  /** La cabecera `From` cruda del último mensaje, para poder nombrar a quien escribió. */
  lastFrom: string | null;
  /** Etiquetas y cabeceras del último mensaje: con eso se decide si es correo masivo. */
  lastLabelIds: string[];
  lastHeaders: MailHeader[];
  /** Lo último que se dijo, recortado. Es lo único del cuerpo que sale de aquí. */
  lastSnippet: string;
  messages: number;
}

// ---------------------------------------------------------------------------
// La carga histórica
// ---------------------------------------------------------------------------

export interface BackfillBatchResult {
  /** Nada que hacer: no hay buzón conectado, está pausado, o ya terminó. */
  skipped: 'no_state' | 'paused' | 'already_done' | 'no_space' | null;
  threads: number;
  tally: IngestTally;
  /** True cuando quedan páginas: el trabajo tiene que volver a encolarse. */
  more: boolean;
  /** Lo que Gmail estima que hay en total para la ventana. Aproximado. */
  estimatedTotal: number | null;
  doneSoFar: number;
}

export async function runBackfillBatch(ctx: LearnContext): Promise<BackfillBatchResult> {
  const state = await getSyncState(ctx.db, ctx.userId);
  const idle = (why: BackfillBatchResult['skipped']): BackfillBatchResult => ({
    skipped: why,
    threads: 0,
    tally: emptyTally(),
    more: false,
    estimatedTotal: null,
    doneSoFar: state?.backfillThreads ?? 0,
  });

  if (!state) return idle('no_state');
  if (state.paused) return idle('paused');
  if (state.backfillDoneAt) return idle('already_done');
  if (!state.spaceId) return idle('no_space');

  // La ventana se calcula desde el arranque de la carga y no desde ahora: una
  // carga que dura tres días no debe ir estrechándose bajo sus propios pies.
  const anchor = state.backfillStartedAt ? new Date(state.backfillStartedAt) : new Date();
  const query = backfillQuery(state.backfillWindow, anchor);

  const page = await listThreadPage(ctx, {
    query,
    pageToken: state.backfillCursor,
    pageSize: THREADS_PER_BATCH,
  });

  const { tally } = await ingestThreads(ctx, {
    threadIds: page.threadIds,
    spaceId: state.spaceId,
  });

  const done = page.nextPageToken === null;
  await recordBackfillProgress(ctx.db, ctx.userId, {
    cursor: page.nextPageToken,
    threadsAdded: page.threadIds.length,
    done,
  });

  return {
    skipped: null,
    threads: page.threadIds.length,
    tally,
    more: !done,
    estimatedTotal: page.estimatedTotal,
    doneSoFar: (state.backfillThreads ?? 0) + page.threadIds.length,
  };
}

// ---------------------------------------------------------------------------
// El barrido diario
// ---------------------------------------------------------------------------

export interface SweepResult {
  skipped: 'no_state' | 'paused' | 'no_space' | null;
  /** Cómo se eligieron los hilos: por el puntero, o por fecha tras caducar. */
  via: 'history' | 'date' | 'none';
  threads: number;
  tally: IngestTally;
  /** Lo que se archivó, para que el trabajo pueda decidir de qué avisar. */
  documents: ArchivedThread[];
  /** True cuando se llegó al techo y quedó correo por leer. */
  capped: boolean;
}

/**
 * Lo que llegó desde ayer, dentro del cerebro.
 *
 * DOS CAMINOS Y UNO ES EL PLAN B. El bueno es el `historyId`: Gmail contesta
 * exactamente qué cambió desde ese punto. Google lo caduca tras varios días sin
 * usarlo y entonces contesta 404, que NO es un fallo — es lo que pasa cuando el
 * producto estuvo caído un fin de semana largo. El plan B es preguntar por
 * fecha desde el último barrido, con un día de solapamiento a propósito: volver
 * a ver un hilo que ya está archivado no cuesta nada (el sha256 lo corta antes
 * de gastar un embedding), y perderse un día sí cuesta.
 */
export async function runDailySweep(ctx: LearnContext): Promise<SweepResult> {
  const state = await getSyncState(ctx.db, ctx.userId);
  const idle = (why: SweepResult['skipped']): SweepResult => ({
    skipped: why,
    via: 'none',
    threads: 0,
    tally: emptyTally(),
    documents: [],
    capped: false,
  });

  if (!state) return idle('no_state');
  if (state.paused) return idle('paused');
  if (!state.spaceId) return idle('no_space');

  const { threadIds, via, historyId } = await selectThreads(ctx, state);
  const capped = threadIds.length > MAX_SWEEP_THREADS;
  const selected = capped ? threadIds.slice(0, MAX_SWEEP_THREADS) : threadIds;

  const { tally, documents } = await ingestThreads(ctx, {
    threadIds: selected,
    spaceId: state.spaceId,
  });

  await recordSweep(ctx.db, ctx.userId, {
    historyId,
    error: capped
      ? `Llegaron más de ${MAX_SWEEP_THREADS} hilos de una vez; se archivaron los primeros y el resto entra en el próximo barrido.`
      : null,
  });

  return { skipped: null, via, threads: selected.length, tally, documents, capped };
}

async function selectThreads(
  ctx: LearnContext,
  state: GmailSyncState,
): Promise<{ threadIds: string[]; via: SweepResult['via']; historyId: string | null }> {
  if (state.historyId) {
    const history = await listHistoryThreadIds(ctx, state.historyId);
    if (!history.expired) {
      return { threadIds: history.threadIds, via: 'history', historyId: history.historyId };
    }
    ctx.logger.info(
      { user: ctx.userId },
      'gmail: el puntero de historial caducó; se cae a una consulta por fecha',
    );
  }

  // EL PUNTERO SE PIDE PRIMERO, antes de leer un solo hilo, por la misma razón
  // que en `startTraining`: lo que llegue mientras este barrido corre tiene que
  // caer DENTRO de lo que verá el de mañana. Pidiéndolo al final, un correo que
  // entra a mitad del archivado queda entre dos aguas —ya fuera de esta lectura
  // y ya cubierto por el puntero nuevo— y no lo ve nadie nunca. Al revés, lo
  // peor que pasa es re-ver un hilo ya archivado, que no cuesta ni un embedding.
  //
  // Si Google no lo da, `recordSweep` deja el que había: borrarlo condenaría el
  // buzón a la consulta por fecha para siempre.
  let historyId: string | null = null;
  try {
    historyId = (await fetchProfile(ctx)).historyId;
  } catch (err) {
    ctx.logger.warn(
      { err: (err as Error).message, user: ctx.userId },
      'gmail: no se pudo releer el puntero del buzón',
    );
  }

  // Plan B. Un día de solapamiento: re-ver un hilo archivado es gratis,
  // perderse uno no.
  const since = state.lastSyncedAt ? new Date(state.lastSyncedAt) : new Date();
  since.setTime(since.getTime() - 86_400_000);
  const page = await listThreadPage(ctx, {
    query: mailboxQuery(since),
    pageSize: MAX_SWEEP_THREADS,
  });

  return { threadIds: page.threadIds, via: 'date', historyId };
}

/**
 * Apagar un buzón cuyo permiso ya no existe.
 *
 * Un 401 de Google no es un fallo pasajero: alguien revocó el acceso, o cambió
 * la contraseña, o el token murió de viejo. Reintentarlo cada mañana durante
 * meses es ruido en los registros y una llamada inútil a Google; pausarlo y
 * anotar por qué es lo que permite que una pantalla diga «reconecta tu cuenta».
 */
export async function pauseOnLostAccess(ctx: LearnContext, err: unknown): Promise<boolean> {
  const message = (err as Error)?.message ?? '';
  if (!/\b401\b|invalid_grant|insufficient/i.test(message)) return false;
  await setPaused(
    ctx.db,
    ctx.userId,
    true,
    'Cortex perdió el permiso para leer este buzón. Vuelve a conectar tu cuenta de Google y se reanuda.',
  );
  return true;
}
