import { buildToolContext } from '@/lib/agent';
import { type JobHandler, enqueueJob } from '@/lib/jobs';
import { noteMailWorthSeeing, noteMailboxLearningStopped } from '@/lib/notifications/producers';
import { mustRead, mustReadList } from '@/lib/supabase/read';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type ArchivedThread,
  GMAIL_PERMALINK_PREFIX,
  type LearnContext,
  MAX_PROPOSALS_PER_DAY,
  createIntegrationsClient,
  draftReply,
  getSyncState,
  loadDigestPreferences,
  pauseOnLostAccess,
  planMailAlerts,
  planReplyProposals,
  proposeAction,
  runBackfillBatch,
  runDailySweep,
  withinQuietHours,
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

/**
 * Cada diez minutos, y ya no cada mañana.
 *
 * ERA DIARIO (6:10 en Bogotá) porque lo único que hacía era archivar, y archivar
 * puede esperar a mañana. Desde la 0126 este mismo barrido decide además de qué
 * INTERRUMPIR, y un aviso que llega ocho horas tarde no es un aviso. Diez
 * minutos y «al instante» son lo mismo para una persona; para Gmail son una
 * llamada al historial por buzón, que devuelve vacío casi siempre y no cuesta
 * cuota apreciable. El empuje de Gmail (Pub/Sub `users.watch`) daría segundos en
 * vez de minutos y se monta encima de esto sin tirar nada: el cron seguiría
 * siendo la red de seguridad de la que hoy es el único camino.
 *
 * LO QUE HUBO QUE MOVER AL CAMBIAR ESTO: el techo de propuestas de respuesta era
 * «cinco por barrido», que con un barrido diario es cinco al día y con uno cada
 * diez minutos son setecientas veinte. Ahora es un presupuesto de 24 horas que
 * se calcula abajo. Un número que sólo era correcto por la cadencia es
 * exactamente lo que se rompe al cambiarla.
 */
export const GMAIL_SWEEP_CRON = '*/10 * * * *';

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

  // 2. De qué hay que enterarse AHORA --------------------------------------
  // Antes que proponer, y en su propio paso: un aviso llega tarde por minutos,
  // un borrador no. Si el modelo que redacta se cae, la interrupción ya salió.
  const alerted = await step.run('alert-worth-seeing', async () =>
    alertForMailbox(organizationId, userId, swept.documents),
  );

  // 3. De qué merece la pena proponer algo ---------------------------------
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
    alerted,
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

  // EL TECHO ES DE 24 HORAS, no de este barrido. Con el barrido corriendo cada
  // diez minutos (0126), «cinco por barrido» serían setecientas veinte al día.
  // Ventana móvil y no día natural, por lo mismo que en los avisos: un techo que
  // se reinicia a medianoche deja pasar diez en veinte minutos.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recent = mustReadList(
    await db
      .from('actions')
      .select('id')
      .eq('origin_kind', 'email_thread')
      .gte('created_at', since)
      .limit(MAX_PROPOSALS_PER_DAY + 1),
    'las propuestas de correo de las últimas 24 horas',
  ) as Array<{ id: string }>;
  const budget = MAX_PROPOSALS_PER_DAY - recent.length;
  if (budget <= 0) return 0;

  const candidates = planReplyProposals({
    threads: documents,
    mailbox: state.emailAddress,
    alreadyProposed,
    budget,
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

/**
 * DE QUÉ HAY QUE ENTERARSE AHORA.
 *
 * Todo lo que decide QUÉ está en `mail/alerts.ts`, que es una función pura y se
 * puede auditar sin levantar un buzón. Aquí vive lo que esa función no puede
 * saber: quién quiere que le interrumpan, a qué horas, cuántas veces ya se le
 * interrumpió hoy, y qué dominios son de un cliente.
 *
 * NUNCA LANZA. Un aviso que no sale es un aviso que no sale; lo archivado —la
 * parte irrecuperable— ya está guardado antes de llegar aquí, y perderlo por un
 * fallo del directorio de clientes sería cambiar una molestia por una pérdida.
 */
async function alertForMailbox(
  organizationId: string,
  userId: string,
  documents: ArchivedThread[],
): Promise<number> {
  if (documents.length === 0) return 0;

  try {
    const db = getOrgScopedClient(organizationId);

    const prefs = await loadDigestPreferences(db, userId);
    if (!prefs.mailAlertsEnabled || prefs.mailAlertsMaxPerDay <= 0) return 0;
    // Fuera de la franja el correo no se pierde: se archivó igual y sale en el
    // resumen. Lo único que no pasa es que suene a las tres de la mañana.
    if (!withinQuietHours(new Date(), prefs.timezone, prefs.mailAlertsFrom, prefs.mailAlertsTo)) {
      return 0;
    }

    const state = await getSyncState(db, userId);
    if (!state?.emailAddress) return 0;

    // Ventana móvil de 24 horas y no día natural: un techo que se reinicia a
    // medianoche permite cinco a las 23:50 y cinco a las 00:10.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [recent, everAlerted, domains, commitments] = await Promise.all([
      db
        .from('mail_alerts')
        .select('id')
        .eq('user_id', userId)
        .gte('notified_at', since)
        .limit(prefs.mailAlertsMaxPerDay + 1),
      // Sin ventana: un hilo interrumpe UNA vez, no una vez al día.
      db
        .from('mail_alerts')
        .select('thread_id')
        .eq('user_id', userId)
        .limit(5000),
      db.from('client_domains').select('domain, clients(name)').limit(2000),
      db
        .from('commitments')
        .select('title, counterparty, due_on, state')
        .in('state', ['due_soon', 'overdue'])
        .limit(500),
    ]);

    // Una lectura que falla aquí NO se lee como vacía: creer que nadie ha sido
    // avisado nunca es exactamente cómo se vuelve a avisar de todo.
    if (recent.error || everAlerted.error) return 0;

    const budget = prefs.mailAlertsMaxPerDay - (recent.data?.length ?? 0);
    if (budget <= 0) return 0;

    const alreadyAlerted = new Set(
      ((everAlerted.data ?? []) as Array<{ thread_id: string }>).map((r) => r.thread_id),
    );

    // El directorio de clientes y los compromisos SÍ pueden faltar sin que pase
    // nada: sin ellos quedan las razones más anchas, no ninguna.
    const clientsByDomain = new Map<string, string>();
    for (const row of (domains.data ?? []) as Array<{
      domain: string;
      clients: { name: string } | { name: string }[] | null;
    }>) {
      const client = Array.isArray(row.clients) ? row.clients[0] : row.clients;
      const name = client?.name?.trim();
      if (row.domain && name) clientsByDomain.set(row.domain.toLowerCase(), name);
    }

    const commitmentsByClient = new Map<string, { title: string; dueLabel: string }>();
    for (const row of (commitments.data ?? []) as Array<{
      title: string;
      counterparty: string | null;
      due_on: string;
      state: string;
    }>) {
      const who = row.counterparty?.trim().toLowerCase();
      if (!who) continue;
      // El primero gana: la consulta no ordena, y de dos compromisos con el
      // mismo cliente cualquiera de los dos justifica igual la interrupción.
      if (commitmentsByClient.has(who)) continue;
      commitmentsByClient.set(who, {
        title: row.title,
        dueLabel: row.state === 'overdue' ? `vencido el ${row.due_on}` : `para el ${row.due_on}`,
      });
    }

    const alerts = planMailAlerts({
      threads: documents,
      mailbox: state.emailAddress,
      alreadyAlerted,
      clientsByDomain,
      commitmentsByClient,
      budget,
    });

    let sent = 0;
    for (const alert of alerts) {
      // La fila del libro PRIMERO. Si se escribiera después y el aviso saliera,
      // un fallo aquí dejaría un hilo que puede volver a interrumpir mañana; al
      // revés, lo peor que pasa es un hilo que no interrumpió nunca — que es el
      // lado bueno de equivocarse cuando lo que está en juego es molestar.
      const { error } = await db.from('mail_alerts').insert({
        user_id: userId,
        provider: 'gmail',
        thread_id: alert.thread.threadId,
        reason: alert.reason,
        detail: alert.detail,
        subject: alert.thread.subject,
      });
      // El índice único es la carrera perdida entre dos barridos solapados: si
      // otro ya lo anotó, ya lo avisó.
      if (error) continue;

      await noteMailWorthSeeing(db, {
        userId,
        threadId: alert.thread.threadId,
        subject: alert.thread.subject,
        from: alert.thread.lastFrom ?? alert.from,
        detail: alert.detail,
        permalink: `${GMAIL_PERMALINK_PREFIX}${alert.thread.threadId}`,
      });
      sent += 1;
    }

    return sent;
  } catch (err) {
    logger.warn('gmail-sweep: no se pudo decidir de qué avisar', {
      organizationId,
      userId,
      error: (err as Error).message,
    });
    return 0;
  }
}
