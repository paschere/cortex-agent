import { createHash } from 'node:crypto';
import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { approxTokens } from '../kb/chunker';
import { embedDocuments } from '../kb/embedder';
import { recordEmbeddingUsage } from '../kb/embedding-usage';
import { type SpaceKind, assertCanWriteToSpace } from '../kb/spaces';
import type { SpeechTurn } from '../kb/transcribe';
import { chunkTranscript } from '../kb/transcript-chunker';
import {
  type ThreadAudience,
  classifyAudience,
  counterpartDomainOf,
  matchClientByDomain,
} from '../mail/audience';
import type { MailMessage } from './threads';
import { threadParticipants } from './threads';

/**
 * Un hilo de Gmail se convierte en un documento de Brain Knowledge.
 *
 * ES `outlook/ingest-thread.ts` POR OTRA PUERTA, deliberadamente, hasta en los
 * nombres de las columnas — que a su vez era `whatsapp/ingest-window.ts` por
 * otra puerta. Una ventana de WhatsApp, una llamada de Meet y un hilo de correo
 * son el mismo objeto: una conversación con autores y con horas. Por eso los
 * tres escriben las mismas columnas de procedencia (`recorded_at`,
 * `duration_seconds`, `speakers`), se trocean con la MISMA función
 * (`chunkTranscript`) y llevan el mismo `{speaker, speakers, startMs, endMs}`
 * en `kb_chunks.metadata`. Todo lo que se construyó para citar uno cita éste
 * gratis.
 *
 * ===========================================================================
 * LA REGLA DE PRIVACIDAD, QUE ES LO ÚNICO QUE CAMBIA RESPECTO A OUTLOOK
 * ===========================================================================
 * Outlook archiva un hilo sólo si hay alguien de FUERA de la empresa, porque el
 * correo interno es correspondencia privada de un empleado y meterla en un
 * espacio que otros pueden buscar es publicarla. Esa mitad no se toca:
 *
 *     A UN ESPACIO COMPARTIDO, SÓLO LO QUE TIENE A ALGUIEN DE FUERA.
 *
 * Lo que se añade es la otra mitad. Un espacio PERSONAL no es un sitio
 * compartido: es el cuaderno de una sola persona, que nadie más puede leer (la
 * 0049 lo hace cumplir en Postgres, no sólo aquí). Cuando alguien conecta SU
 * buzón y pide que Cortex lo aprenda, el destino es su propio espacio y ahí
 * entra todo, interno incluido — es información que esa persona ya tiene, sobre
 * su propio trabajo, y negársela sería negarle la función entera.
 *
 *     AL ESPACIO PERSONAL DEL DUEÑO DEL BUZÓN, ENTRA TODO.
 *
 * Las dos frases se aplican en un solo `if`, abajo, y se apoyan en algo que ya
 * era verdad: `assertCanWriteToSpace` DEVUELVE el espacio, con su `kind` y su
 * `ownerId`. Así que «es mi cuaderno» no es una afirmación del que llama, es lo
 * que dice la base de datos.
 *
 * Y SI NO PODEMOS SABERLO, SE NIEGA. Con `INTERNAL_EMAIL_DOMAINS` sin
 * configurar nadie es interno (ver @cortex/core), con lo que TODO hilo parecería
 * externo y un espacio compartido se llenaría del buzón entero. El despliegue
 * sin configurar, por tanto, no publica nada en un espacio compartido y lo dice.
 * Al espacio personal sí sigue entrando, porque ahí la pregunta no se hace.
 *
 * IDEMPOTENTE POR ESQUEMA. `gmail_thread_ingests` es única en (espacio de
 * trabajo, usuario, hilo) — migración 0121 — y esto busca la fila antes de
 * escribir nada: un hilo ya archivado reutiliza su fila de `kb_documents`,
 * reemplaza sus trozos en el sitio, y cuando el texto no ha cambiado no gasta ni
 * una llamada de embeddings. Un hilo que crece en tres respuestas se re-archiva
 * como UN documento, no como cuatro.
 */

/** Todo lo que esto necesita. Ni un agente, ni una conversación, ni un tramo. */
export interface GmailIngestContext {
  organizationId: string;
  /**
   * El dueño del buzón. Su permiso es contra lo que se comprueba la escritura y
   * su id es lo que queda en `kb_documents.uploaded_by` — un archivo siempre
   * tiene a alguien que responde por él.
   */
  userId: string;
  db: SupabaseClient;
  logger: Logger;
}

export type ThreadIngestOutcome =
  /** Se creó un documento nuevo. */
  | 'imported'
  /** Ya era un documento y su texto cambió. */
  | 'updated'
  /** Ya estaba archivado y es idéntico byte a byte — no se re-embebió nada. */
  | 'unchanged'
  /** Todos los del hilo trabajan aquí Y el destino era un espacio compartido. */
  | 'internal'
  /** No había nada que guardar (todos los mensajes venían vacíos). */
  | 'empty'
  /** Se leyó pero no se pudo guardar. Queda anotado para poder reintentar. */
  | 'failed';

export interface ThreadIngestResult {
  outcome: ThreadIngestOutcome;
  /** Una frase sobre la que una persona (o un modelo) pueda actuar. Nunca una traza. */
  note: string;
  threadId: string;
  documentId: string | null;
  /** El dominio de fuera con el que es esta correspondencia, si hay uno solo. */
  counterpartDomain: string | null;
  /** Cliente vinculado, si el dominio coincidió con uno sin ambigüedad. Casi siempre null. */
  clientId: string | null;
  /** True cuando nadie de fuera está en el hilo. Se guarda; ver la 0121. */
  internalOnly: boolean;
  chunks: number;
  messages: number;
  participants: string[];
}

/**
 * El techo de un hilo, en mensajes. Pasado esto es una lista de correo y no una
 * conversación, y cada trozo por encima del tope es otro embedding gastado en
 * algo que nadie va a buscar tan adentro. El hilo se guarda igual — truncado, y
 * la cabecera lo dice.
 */
const MAX_MESSAGES_PER_THREAD = 400;

const UNKNOWN_SENDER = 'Remitente desconocido';

// ---------------------------------------------------------------------------
// El documento
// ---------------------------------------------------------------------------

function formatMoment(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-CO', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

/**
 * Los mensajes en la forma `SpeechTurn` que el troceador de transcripciones ya
 * habla.
 *
 * Los desplazamientos son «cuánto llevaba la correspondencia», medidos desde el
 * primer mensaje — la misma unidad que una ventana de WhatsApp, y significa lo
 * mismo para quien lo lea: una cita puede decir «en el tercer mensaje, dos días
 * después».
 *
 * Dos mensajes seguidos de la misma persona NO se juntan, al revés que en
 * WhatsApp. Dos correos de la misma persona con un día de diferencia son dos
 * actos de voluntad, no una ráfaga de tecleo, y juntarlos perdería la segunda
 * fecha.
 */
export function buildMailTurns(messages: MailMessage[], originMs: number): SpeechTurn[] {
  const turns: SpeechTurn[] = [];
  for (const m of messages) {
    const text = m.body.trim();
    if (!text) continue;
    const speaker = m.from?.trim() || m.fromEmail || UNKNOWN_SENDER;
    const offset = Math.max(0, m.ms - originMs);
    turns.push({ speaker, startMs: offset, endMs: offset, text });
  }
  return turns;
}

/**
 * El primer trozo, y la razón por la que el hilo se puede citar por sí solo.
 *
 * Un trozo suelto de un hilo de correo dice «confirmamos el zarpe para el 14» y
 * nada más — ni con quién, ni sobre qué, ni cuándo. Indexado como trozo propio,
 * esto hace que «la correspondencia con la naviera en marzo» encuentre el hilo,
 * y que cualquier cosa que enseñe el primer trozo de un documento enseñe algo
 * que vale la pena leer.
 */
export function buildThreadHeader(input: {
  subject: string;
  startMs: number;
  endMs: number;
  participants: string[];
  externalDomains: string[];
  messageCount: number;
  timeZone: string;
  truncated: boolean;
  internalOnly: boolean;
}): string {
  const facts = [
    'Hilo de correo (Gmail)',
    formatMoment(input.startMs, input.timeZone),
    input.endMs > input.startMs ? `hasta ${formatMoment(input.endMs, input.timeZone)}` : null,
    `${input.messageCount} mensaje${input.messageCount === 1 ? '' : 's'}`,
  ].filter((f): f is string => Boolean(f));

  return [
    `# ${input.subject}`,
    facts.join(' · '),
    input.participants.length
      ? `Quiénes participan: ${input.participants.join(', ')}`
      : 'Quiénes participan: el buzón no reportó direcciones.',
    input.internalOnly
      ? 'Correspondencia interna: todos los que aparecen trabajan en la empresa.'
      : input.externalDomains.length
        ? `Fuera de la empresa: ${input.externalDomains.join(', ')}`
        : null,
    input.truncated
      ? `Nota: este hilo pasó de ${MAX_MESSAGES_PER_THREAD} mensajes y aquí sólo están los primeros ${MAX_MESSAGES_PER_THREAD}.`
      : null,
    '',
    'Lo que sigue es la correspondencia de este hilo, en orden, con quién escribió cada mensaje y cuánto llevaba el intercambio.',
  ]
    .filter((line) => line !== null)
    .join('\n');
}

interface PreparedChunk {
  content: string;
  chunkIndex: number;
  tokens: number;
  metadata: Record<string, unknown>;
}

/** Trozo de cabecera + un trozo por tramo de correspondencia, en orden de lectura. */
export function buildThreadChunks(header: string, turns: SpeechTurn[]): PreparedChunk[] {
  const chunks: PreparedChunk[] = [
    {
      content: header,
      chunkIndex: 0,
      // Sin `speaker`: esto no lo escribió nadie, y atribuírselo a un
      // participante sería ponerle palabras en la boca dentro de una cita.
      metadata: { kind: 'gmail_header', startMs: 0, endMs: 0 },
      tokens: approxTokens(header),
    },
  ];
  for (const chunk of chunkTranscript(turns)) {
    chunks.push({
      content: chunk.content,
      chunkIndex: chunks.length,
      tokens: chunk.tokens,
      metadata: { ...chunk.metadata },
    });
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// El libro
// ---------------------------------------------------------------------------

interface LedgerRow {
  id: string;
  document_id: string | null;
  sha256: string | null;
}

async function findLedger(
  db: SupabaseClient,
  userId: string,
  threadId: string,
): Promise<LedgerRow | null> {
  const { data } = await db
    .from('gmail_thread_ingests')
    .select('id, document_id, sha256')
    .eq('user_id', userId)
    .eq('thread_id', threadId)
    .maybeSingle();
  return (data as unknown as LedgerRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// La ingesta
// ---------------------------------------------------------------------------

export interface IngestThreadOptions {
  timeZone?: string;
}

/**
 * Doblar un hilo de Gmail dentro de Brain Knowledge.
 *
 * Recibe los mensajes en vez de ir a buscarlos, para que la herramienta, la
 * carga histórica, el barrido diario y las pruebas ejerciten el mismo código
 * sin Gmail de por medio.
 */
export async function ingestThread(
  ctx: GmailIngestContext,
  input: {
    threadId: string;
    spaceId: string;
    messages: MailMessage[];
  },
  opts: IngestThreadOptions = {},
): Promise<ThreadIngestResult> {
  const db = ctx.db;
  const timeZone = opts.timeZone ?? 'America/Bogota';

  const ordered = [...input.messages].sort((a, b) => a.ms - b.ms);
  const participants = threadParticipants(ordered);
  const audience: ThreadAudience = classifyAudience(participants);

  const base = {
    threadId: input.threadId,
    participants,
    counterpartDomain: null as string | null,
    clientId: null as string | null,
    internalOnly: !audience.undecidable && audience.external.length === 0,
  };

  // EL PERMISO ES LO PRIMERO y no es un trámite. Un espacio se puede renombrar,
  // volver personal o entregar a otra persona, y un archivo que siguiera
  // escribiendo en él publicaría correspondencia en un sitio que su dueño nunca
  // aceptó. Además devuelve el espacio, que es lo que decide la regla siguiente.
  // `SpaceKind` y no un par escrito a mano: desde la 0123 hay una tercera clase
  // —'shared', el espacio de la organización repartido a unos equipos— y la
  // regla de más abajo la trata como lo que es, un sitio compartido donde el
  // correo interno no entra. Escribir el par a mano aquí era exactamente la
  // forma de que esa tercera clase se colara como si fuera un cuaderno.
  let space: { kind: SpaceKind; ownerId: string | null; name: string };
  try {
    space = await assertCanWriteToSpace(db, ctx.userId, input.spaceId);
  } catch (err) {
    return {
      ...base,
      outcome: 'failed',
      note: `Ese hilo no se archivó porque no puedes escribir en el espacio al que iba: ${(err as Error).message}`,
      documentId: null,
      chunks: 0,
      messages: 0,
    };
  }

  // LA REGLA, EN UN SOLO SITIO. El cuaderno propio de quien conectó el buzón se
  // salta la pregunta entera: es su correo, en su espacio, que nadie más lee.
  const isOwnNotebook = space.kind === 'personal' && space.ownerId === ctx.userId;

  if (!isOwnNotebook) {
    if (audience.undecidable) {
      return {
        ...base,
        outcome: 'internal',
        note: 'Cortex no puede distinguir quién es de la empresa y quién no, porque INTERNAL_EMAIL_DOMAINS no está configurado en este despliegue. No se archivó nada en el espacio compartido — sin esa lista, todos los hilos parecerían correspondencia con clientes, incluidos los privados. Pídeselo a quien administre el despliegue, o archívalo en tu espacio personal.',
        documentId: null,
        chunks: 0,
        messages: 0,
      };
    }
    if (audience.external.length === 0) {
      return {
        ...base,
        outcome: 'internal',
        note: 'Todos los de este hilo trabajan aquí, así que es correspondencia interna y no va a un espacio compartido. En tu espacio personal sí puede entrar: ahí sólo lo lees tú.',
        documentId: null,
        chunks: 0,
        messages: 0,
      };
    }
  }

  const counterpartDomain = counterpartDomainOf(audience);
  base.counterpartDomain = counterpartDomain;

  const truncated = ordered.length > MAX_MESSAGES_PER_THREAD;
  const messages = truncated ? ordered.slice(0, MAX_MESSAGES_PER_THREAD) : ordered;

  const startMs = messages[0]?.ms ?? 0;
  const endMs = messages[messages.length - 1]?.ms ?? startMs;

  const turns = buildMailTurns(messages, startMs);
  if (turns.length === 0) {
    return {
      ...base,
      outcome: 'empty',
      note: 'Todos los mensajes de ese hilo vinieron con el cuerpo vacío, así que no había nada que recordar.',
      documentId: null,
      chunks: 0,
      messages: 0,
    };
  }

  const subject = messages[0]?.subject?.trim() || '(sin asunto)';
  const header = buildThreadHeader({
    subject,
    startMs,
    endMs,
    participants,
    externalDomains: audience.externalDomains,
    messageCount: messages.length,
    timeZone,
    truncated,
    internalOnly: base.internalOnly,
  });
  const chunks = buildThreadChunks(header, turns);
  const sha256 = createHash('sha256')
    .update(chunks.map((c) => c.content).join('\n\n'))
    .digest('hex');

  const clientId = await matchClientByDomain(db, counterpartDomain);
  base.clientId = clientId;

  const ledger = await findLedger(db, ctx.userId, input.threadId);
  let documentId = ledger?.document_id ?? null;
  let currentSha: string | null = null;

  if (documentId) {
    const { data: docRow } = await db
      .from('kb_documents')
      .select('id, sha256, status')
      .eq('id', documentId)
      .maybeSingle();
    if (docRow) {
      // Un documento a medio fallar hay que reconstruirlo aunque el texto coincida.
      currentSha = docRow.status === 'ready' ? ((docRow.sha256 as string | null) ?? null) : null;
    } else {
      // Alguien lo borró desde la pantalla del cerebro. Eso es una decisión, no
      // un fallo — pero el libro sigue apuntando ahí, así que el hilo se
      // reconstruye desde cero en vez de saltarse en silencio para siempre.
      documentId = null;
    }
  }

  if (documentId && currentSha === sha256) {
    return {
      ...base,
      outcome: 'unchanged',
      note: 'Ese hilo ya estaba archivado y no ha cambiado desde entonces, así que no se volvió a indexar nada.',
      documentId,
      chunks: 0,
      messages: messages.length,
    };
  }

  const title = `${subject} — Gmail, ${formatMoment(startMs, timeZone)}`;
  const durationSeconds = Math.max(0, Math.round((endMs - startMs) / 1000));

  const documentFields = {
    collection_id: input.spaceId,
    source: 'gmail',
    // Identifica el hilo exacto, para poder rastrear un documento hasta el
    // buzón sin pasar por el libro.
    source_ref: `gmail:${input.threadId}`,
    title,
    mime: 'text/markdown',
    sha256,
    uploaded_by: ctx.userId,
    status: 'pending',
    error_message: null,
    // Las columnas de procedencia de la 0058, usadas para lo que se definieron.
    media_kind: 'text',
    recorded_at: new Date(startMs).toISOString(),
    duration_seconds: durationSeconds,
    speakers: participants,
    transcript_status: 'ready',
    transcript_error: null,
  };

  try {
    if (documentId) {
      const { error } = await db.from('kb_documents').update(documentFields).eq('id', documentId);
      if (error) throw new Error(error.message);
      // Se reemplaza en vez de comparar: cuando un hilo crece, las fronteras de
      // los trozos se mueven, así que el índice N ya no es el pasaje que era.
      const { error: delErr } = await db.from('kb_chunks').delete().eq('document_id', documentId);
      if (delErr) throw new Error(delErr.message);
    } else {
      const { data: created, error } = await db
        .from('kb_documents')
        .insert(documentFields)
        .select('id')
        .single();
      if (error || !created) throw new Error(error?.message ?? 'no se creó la fila del documento');
      documentId = created.id as string;
    }

    // Se indexan como documentos, nunca como preguntas (ver kb/embedder.ts).
    const embedded = await embedDocuments(chunks.map((c) => c.content));
    if (!embedded.ok && embedded.retryable) throw new Error(embedded.reason);

    const { error: chunkErr } = await db.from('kb_chunks').insert(
      chunks.map((c, i) => ({
        document_id: documentId,
        chunk_index: c.chunkIndex,
        content: c.content,
        tokens: c.tokens,
        // El mismo trato que en todas partes: un despliegue sin llave de
        // embeddings conserva igual la correspondencia, buscable por palabra.
        embedding: embedded.ok ? embedded.data[i] : null,
        // El modelo viaja con el vector o no se escribe ninguno de los dos (0074).
        embedding_model: embedded.ok ? embedded.usage.modelId : null,
        metadata: c.metadata,
      })),
    );
    if (chunkErr) throw new Error(chunkErr.message);

    if (embedded.ok) {
      await recordEmbeddingUsage(db, {
        organizationId: ctx.organizationId,
        documentId,
        source: 'gmail',
        usage: embedded.usage,
      });
    }

    await db
      .from('kb_documents')
      .update(
        embedded.ok
          ? { status: 'ready', error_message: null }
          : { status: 'pending', error_message: embedded.reason },
      )
      .eq('id', documentId);

    await recordIngest(db, ledger?.id ?? null, {
      userId: ctx.userId,
      threadId: input.threadId,
      internetMessageId: messages[0]?.internetMessageId ?? null,
      subject,
      spaceId: input.spaceId,
      documentId,
      clientId,
      counterpartDomain,
      internalOnly: base.internalOnly,
      messageCount: messages.length,
      firstMessageAt: new Date(startMs).toISOString(),
      lastMessageAt: new Date(endMs).toISOString(),
      sha256,
      status: 'ready',
      error: embedded.ok ? null : embedded.reason,
    });

    const outcome: ThreadIngestOutcome = ledger?.document_id ? 'updated' : 'imported';
    return {
      ...base,
      outcome,
      note: embedded.ok
        ? `${outcome === 'updated' ? 'Actualicé' : 'Guardé'} ${messages.length} mensaje${messages.length === 1 ? '' : 's'} de "${subject}" como un solo hilo: ${chunks.length} pasajes buscables, cada uno con quién lo escribió y cuándo.${clientId ? ' Vinculado al cliente dueño de ese dominio.' : ''}`
        : `Ese hilo quedó guardado pero no se pudo indexar por significado: ${embedded.reason} Se puede encontrar igual por palabras.`,
      documentId,
      chunks: chunks.length,
      messages: messages.length,
    };
  } catch (err) {
    const message = (err as Error).message;
    if (documentId) {
      await db
        .from('kb_documents')
        .update({ status: 'failed', error_message: message })
        .eq('id', documentId)
        .then(undefined, () => undefined);
    }
    await recordIngest(db, ledger?.id ?? null, {
      userId: ctx.userId,
      threadId: input.threadId,
      internetMessageId: messages[0]?.internetMessageId ?? null,
      subject,
      spaceId: input.spaceId,
      documentId,
      clientId,
      counterpartDomain,
      internalOnly: base.internalOnly,
      messageCount: messages.length,
      firstMessageAt: new Date(startMs).toISOString(),
      lastMessageAt: new Date(endMs).toISOString(),
      sha256,
      status: 'failed',
      error: message,
    }).catch((ledgerErr: unknown) => {
      ctx.logger.error(
        { err: (ledgerErr as Error).message, thread: input.threadId },
        'gmail: no se pudo anotar el hilo fallido',
      );
    });
    ctx.logger.error({ err: message, thread: input.threadId }, 'gmail: falló la ingesta del hilo');

    return {
      ...base,
      outcome: 'failed',
      note: `Ese hilo se leyó pero no se pudo guardar: ${message}`,
      documentId,
      chunks: 0,
      messages: messages.length,
    };
  }
}

/**
 * Escribir la fila del libro.
 *
 * Deliberadamente fatal en el camino bueno, por la misma razón que en WhatsApp,
 * en Meet y en Outlook: esta fila es lo que impide que el hilo se archive una
 * segunda vez, así que perderla en silencio cambiaría un fallo visible por una
 * pila ilimitada de documentos duplicados.
 */
async function recordIngest(
  db: SupabaseClient,
  existingId: string | null,
  row: {
    userId: string;
    threadId: string;
    internetMessageId: string | null;
    subject: string;
    spaceId: string;
    documentId: string | null;
    clientId: string | null;
    counterpartDomain: string | null;
    internalOnly: boolean;
    messageCount: number;
    firstMessageAt: string;
    lastMessageAt: string;
    sha256: string | null;
    status: 'ready' | 'failed';
    error: string | null;
  },
): Promise<void> {
  const fields = {
    user_id: row.userId,
    thread_id: row.threadId,
    internet_message_id: row.internetMessageId,
    subject: row.subject,
    space_id: row.spaceId,
    document_id: row.documentId,
    client_id: row.clientId,
    counterpart_domain: row.counterpartDomain,
    internal_only: row.internalOnly,
    message_count: row.messageCount,
    first_message_at: row.firstMessageAt,
    last_message_at: row.lastMessageAt,
    sha256: row.sha256,
    status: row.status,
    error: row.error,
    ingested_at: new Date().toISOString(),
  };

  if (existingId) {
    const { error } = await db.from('gmail_thread_ingests').update(fields).eq('id', existingId);
    if (error) throw new Error(`no se pudo actualizar el libro de Gmail: ${error.message}`);
    return;
  }
  const { error } = await db.from('gmail_thread_ingests').insert(fields);
  if (error) throw new Error(`no se pudo anotar el hilo en el libro de Gmail: ${error.message}`);
}
