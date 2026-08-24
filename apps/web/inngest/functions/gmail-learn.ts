import { buildToolContext } from '@/lib/agent';
import { type JobHandler, enqueueJob } from '@/lib/jobs';
import { noteMailboxLearningStopped } from '@/lib/notifications/producers';
import { mustRead, mustReadList } from '@/lib/supabase/read';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type ArchivedThread,
  type LearnContext,
  createIntegrationsClient,
  draftReply,
  getSyncState,
  pauseOnLostAccess,
  planReplyProposals,
  proposeAction,
  runBackfillBatch,
  runDailySweep,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * APRENDER DE UN BUZÓN DE GMAIL: la carga histórica y el barrido de cada
 * mañana, en la cola.
 *
 * ===========================================================================
 * LOS TRES TRABAJOS Y POR QUÉ SON TRES
 * ===========================================================================
 *   gmail/backfill.user   Una tanda del histórico de UNA persona, que al
 *                         terminar se vuelve a encolar si quedan páginas. Es
 *                         una escalera y no un bucle: cada peldaño cabe en el
 *                         `maxDuration=800` del puente, y lo que sobrevive
 *                         entre peldaños es una fila en la base, no memoria de
 *                         un proceso.
 *   gmail/sweep           El cron. Mira quién tiene buzón conectado y reparte.
 *   gmail/sweep.user      Lo de una persona: archivar lo que llegó y decidir
 *                         qué proponerle.
 *
 * Es la misma forma que `memory-derive.ts`, `learning-pass.ts` y
 * `actions-sweep.ts`: un repartidor sin espacio de trabajo (no hay sesión
 * detrás de un cron) y un trabajo por persona que sí lo tiene, para que un
 * buzón roto no se lleve por delante los demás y para que el reintento sea de
 * esa persona y no de todas.
 *
 * ===========================================================================
 * QUÉ HACE, EN ORDEN, Y QUÉ NO HACE
 * ===========================================================================
 * ARCHIVA todo lo que llegó, al espacio personal de quien conectó el buzón.
 * PROPONE, como mucho cinco respuestas al día, sobre hilos de fuera que
 * esperan contestación — propuestas que quedan en /actions para que una persona
 * las apruebe, edite o descarte. NUNCA ENVÍA NADA solo.
 *
 * Y NO MANDA UN AVISO POR CADA COSA QUE ENCUENTRA. La regla de
 * `notifications/producers.ts` es explícita: nada que sea una COLA se avisa —
 * una propuesta esperando es estado, vive en /actions con su contador, y
 * seguirá siendo verdad mañana. El resumen de la mañana ya tiene su propio
 * canal (`inbox.deliver_digest`, al que cada persona se apunta). Lo único que
 * este trabajo avisa es lo que nadie más va a contar: que dejó de poder leer el
 * buzón.
 */

/** Cada mañana a las 6:10 en Bogotá, antes de que nadie abra el correo. */
export const GMAIL_SWEEP_CRON = '10 11 * * *';

/**
 * Cuántas personas barre una ejecución del reparto. Un techo por si un día hay
 * mil buzones conectados: el resto entra mañana, y el registro lo dice en vez
 * de dejar la impresión de que se cubrieron todos.
 */
const MAX_MAILBOXES_PER_RUN = 200;

interface Mailbox {
  userId: string;
  organizationId: string;
}

function learnContext(organizationId: string, userId: string): LearnContext {
  const db = getOrgScopedClient(organizationId);
  return {
    organizationId,
    userId,
    db,
    integrations: createIntegrationsClient(db, userId, logger),
    logger,
    signal: undefined,
  };
}

// ---------------------------------------------------------------------------
// La carga histórica, una tanda
// ---------------------------------------------------------------------------

export const gmailBackfillUserJob: JobHandler = async ({ event, step }) => {
  const userId = event.data.userId as string | undefined;
  const organizationId = event.data.organizationId as string | undefined;
  if (!userId || !organizationId) return { skipped: 'faltan usuario o espacio de trabajo' };

  const result = await step.run('one-batch', async () => {
    const ctx = learnContext(organizationId, userId);
    try {
      return await runBackfillBatch(ctx);
    } catch (err) {
      // Un permiso revocado no es un fallo que reintentar cada mañana: se
      // apaga el buzón, se anota por qué, y se avisa — esto último sí, porque
      // pide algo de la persona y no hay ninguna otra pantalla que lo cuente.
      if (await pauseOnLostAccess(ctx, err)) {
        await notifyLostAccess(organizationId, userId);
        return null;
      }
      throw err;
    }
  });

  if (!result || result.skipped) {
    return { done: true, skipped: result?.skipped ?? 'acceso perdido' };
  }

  // La escalera: el siguiente peldaño se encola desde aquí. Si la cola no
  // acepta, la carga no se pierde — el barrido de mañana la retoma, porque
  // `runBackfillBatch` lee su cursor de la base y no de este proceso.
  if (result.more) {
    await enqueueJob('gmail/backfill.user', { userId, organizationId });
  }

  return {
    threads: result.threads,
    doneSoFar: result.doneSoFar,
    estimatedTotal: result.estimatedTotal,
    more: result.more,
    ...result.tally,
  };
};

// ---------------------------------------------------------------------------
// El reparto
// ---------------------------------------------------------------------------

export const gmailSweepDispatchJob: JobHandler = async ({ step }) => {
  const mailboxes = await step.run('find-mailboxes', async (): Promise<Mailbox[]> => {
    // Sin espacio de trabajo, y sólo aquí: «qué buzones hay conectados» abarca
    // todos los espacios y no hay sesión detrás de un cron. Cada fila nombra el
    // suyo, y el trabajo por persona de abajo construye su handle a partir de
    // ese nombre — así que lo que se lea o escriba después vive dentro de un
    // solo espacio.
    const db = getSupabaseServiceClient();
    const { data, error } = await db
      .from('gmail_sync_state')
      .select('user_id, organization_id')
      .eq('paused', false)
      .limit(MAX_MAILBOXES_PER_RUN + 1);
    if (error) throw new Error(`No se pudieron listar los buzones: ${error.message}`);
    const rows = (data ?? []) as Array<{ user_id: string; organization_id: string }>;
    if (rows.length > MAX_MAILBOXES_PER_RUN) {
      logger.warn('gmail-sweep: hay más buzones que el techo de una ejecución', {
        found: rows.length,
        cap: MAX_MAILBOXES_PER_RUN,
      });
    }
    return rows
      .slice(0, MAX_MAILBOXES_PER_RUN)
      .map((r) => ({ userId: r.user_id, organizationId: r.organization_id }));
  });

  if (mailboxes.length > 0) {
    await step.sendEvent(
      'sweep-per-mailbox',
      mailboxes.map((m) => ({
        name: 'gmail/sweep.user' as const,
        data: { userId: m.userId, organizationId: m.organizationId },
      })),
    );
  }
  return { dispatched: mailboxes.length };
};

// ---------------------------------------------------------------------------
// Una persona
// ---------------------------------------------------------------------------

export const gmailSweepUserJob: JobHandler = async ({ event, step }) => {
  const userId = event.data.userId as string | undefined;
  const organizationId = event.data.organizationId as string | undefined;
  if (!userId || !organizationId) return { skipped: 'faltan usuario o espacio de trabajo' };

  // 1. Lo que llegó, dentro del cerebro ------------------------------------
  const swept = await step.run('archive-new-mail', async () => {
    const ctx = learnContext(organizationId, userId);
    try {
      return await runDailySweep(ctx);
    } catch (err) {
      if (await pauseOnLostAccess(ctx, err)) {
        await notifyLostAccess(organizationId, userId);
        return null;
      }
      throw err;
    }
  });

  if (!swept || swept.skipped) {
    return { skipped: swept?.skipped ?? 'acceso perdido' };
  }

  // 2. De qué merece la pena proponer algo ---------------------------------
  // Paso aparte a propósito, con la misma disciplina que `actions-sweep`: si el
  // modelo que redacta se cae, o la cuota se agota, eso no puede costarle a la
  // persona lo ya archivado, que es la parte irrecuperable.
  const proposed = await step.run('propose-replies', async () =>
    proposeForMailbox(organizationId, userId, swept.documents),
  );

  return {
    via: swept.via,
    threads: swept.threads,
    capped: swept.capped,
    proposed,
    ...swept.tally,
  };
};

/**
 * De lo archivado esta mañana, qué se le propone a esta persona.
 *
 * EL AGENTE AL QUE SE ATRIBUYE sale del espacio de trabajo, igual que en
 * `actions-sweep.ts`: una propuesta tiene que nombrar uno porque ejecutarla más
 * tarde construye un contexto de herramienta, y cada fila de auditoría de este
 * producto se escribe contra un agente. No hay sesión aquí de la que sacarlo.
 */
async function proposeForMailbox(
  organizationId: string,
  userId: string,
  documents: ArchivedThread[],
): Promise<number> {
  if (documents.length === 0) return 0;

  const db = getOrgScopedClient(organizationId);
  const state = await getSyncState(db, userId);
  if (!state?.emailAddress) return 0;

  const agentId = await defaultAgentId(organizationId);
  if (!agentId) return 0;

  // Un hilo sobre el que ya se propuso algo —lo aprobaran, lo descartaran o
  // siga esperando— no vuelve a proponerse. Descartar es una decisión.
  // Comprobadas, y no por formalismo: si esta lectura falla y se lee como
  // vacía, el barrido cree que nunca propuso nada sobre ningún hilo y vuelve a
  // proponerlo todo — incluido lo que alguien descartó ayer.
  const seen = mustReadList(
    await db.from('actions').select('origin_id').eq('origin_kind', 'email_thread').limit(5000),
    'las propuestas que ya existen sobre hilos de correo',
  ) as Array<{ origin_id: string | null }>;
  const alreadyProposed = new Set(
    seen.map((r) => r.origin_id).filter((id): id is string => Boolean(id)),
  );

  const me = mustRead(
    await db.from('users').select('name').eq('id', userId).maybeSingle(),
    'tu ficha del directorio',
  ) as { name: string | null } | null;
  const authorName = (me?.name ?? '').trim() || null;

  const candidates = planReplyProposals({
    threads: documents,
    mailbox: state.emailAddress,
    alreadyProposed,
  });

  let count = 0;
  for (const candidate of candidates) {
    try {
      const draft = await draftReply(candidate, { authorName });
      // Sin borrador no hay propuesta. Un texto genérico enseñaría a la gente a
      // aprobar sin leer, que es lo único que esta función no puede permitirse.
      if (!draft) continue;

      const result = await proposeAction(db, {
        userId,
        agentId,
        kind: 'reply_to_client',
        toolId: 'gmail.send_message',
        payload: { to: [candidate.to], subject: draft.subject, body: draft.body },
        originKind: 'email_thread',
        originId: candidate.thread.threadId,
        rationale: draft.rationale,
      });
      if (result.outcome === 'proposed') count += 1;
    } catch (err) {
      // Un hilo malo no puede costarle a la persona los otros cuatro.
      logger.warn('gmail-sweep: no se pudo proponer una respuesta', {
        organizationId,
        thread: candidate.thread.threadId,
        error: (err as Error).message,
      });
    }
  }
  return count;
}

async function defaultAgentId(organizationId: string): Promise<string | null> {
  const db = getOrgScopedClient(organizationId);
  const named = mustRead(
    await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle(),
    'el agente Cortex del espacio de trabajo',
  ) as { id: string } | null;
  if (named?.id) return named.id;
  const fallback = mustRead(
    await db.from('agents').select('id').limit(1).maybeSingle(),
    'algún agente del espacio de trabajo',
  ) as { id: string } | null;
  return fallback?.id ?? null;
}

/**
 * El único aviso que manda este trabajo.
 *
 * Pide algo de la persona (volver a conectar su cuenta) y no hay ninguna otra
 * pantalla que se lo vaya a contar — las dos condiciones que, según
 * `notifications/producers.ts`, hacen que un aviso esté justificado.
 */
async function notifyLostAccess(organizationId: string, userId: string): Promise<void> {
  const db = getOrgScopedClient(organizationId);
  const state = await getSyncState(db, userId).catch(() => null);
  await noteMailboxLearningStopped(db, { userId, mailbox: state?.emailAddress ?? null });
}
