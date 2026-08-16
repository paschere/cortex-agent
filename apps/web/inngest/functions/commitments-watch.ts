import { buildToolContext } from '@/lib/agent';
import { sendEmail } from '@/lib/email';
import { renderCommitmentNoticeEmail } from '@/lib/email-templates';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type CommitmentRow,
  type NoticeKind,
  adaptCommitment,
  bogotaToday,
  claimNotice,
  deriveState,
  emailsFor,
  escalationTarget,
  hydrate,
  listCommitments,
  listNoticesFor,
  loadManagerMap,
  noticesOwed,
  orgAdmins,
  recordCalendarError,
  refreshStates,
  settleNotice,
  syncCommitmentToCalendar,
  syncFleetCommitments,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * The part that makes this module a product rather than a table: nobody has to
 * remember to look.
 *
 * Every morning, per workspace, Cortex reads the fleet's registry answers into
 * commitments, recomputes what is in force / lapsing / lapsed against TODAY IN
 * BOGOTÁ, decides which warnings are owed, sends the ones that have never been
 * sent, escalates the ones nobody answered, and moves the calendar events that
 * need moving.
 *
 * IDEMPOTENCE IS NOT BEST-EFFORT HERE. Inngest retries steps, deploys restart
 * them, and a cron that fires twice is a normal Tuesday. So "have we already
 * said this" is not decided by this function at all — it is decided by a unique
 * index on (commitment_id, notice_kind, due_on) in migration 0069. This code
 * claims a notice, and either wins the claim and sends, or loses it and does
 * nothing. Running the whole function ten times in a row sends one email.
 *
 * SHAPE. Cron dispatcher + per-workspace event, the same as schedule-dispatch /
 * schedule-run and memory-derive: one function decides who is due and fans out,
 * one does the work for a single workspace so a failure is contained and
 * Inngest retries only that workspace.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH. Anything with review_state='pending'.
 * Extracted dates are proposals; the watcher never reads them, so a model's
 * guess can never reach somebody's inbox. That filter lives in
 * `listCommitments`, which defaults to confirmed.
 */

/**
 * 06:00 in Bogotá. Late enough that the mail is at the top of the inbox when
 * people sit down, early enough that "vence hoy" still leaves a working day to
 * do something about it. Colombia has no daylight saving, so UTC-5 is fixed and
 * 11:00 UTC is 06:00 there every day of the year.
 */
const WATCH_CRON = '0 11 * * *';

/** Nothing beyond this window can be urgent, and scanning it costs nothing. */
const HORIZON_DAYS = 400;

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** El cuerpo, extraído a la firma de la cola nueva; `event` no se usa. */
export const commitmentsWatchDispatchJob: JobHandler = async ({ step }) => {
  // Unscoped, and only here. "Which workspaces have anything to watch" spans
  // the install and there is no session behind a cron. Every workspace id
  // read here rides on its own event, and the per-workspace function below
  // builds every handle from that id — so one company's watcher can only ever
  // read and write that company's rows.
  const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
    const db = getSupabaseServiceClient();
    const seen = new Set<string>();

    // Two sources, because a workspace with trucks but no hand-written
    // commitments still needs its first fleet sync to happen.
    const [{ data: commitments }, { data: vehicles }] = await Promise.all([
      db.from('commitments').select('organization_id').limit(20_000),
      db.from('vehicles').select('organization_id').eq('archived', false).limit(20_000),
    ]);
    for (const row of [...(commitments ?? []), ...(vehicles ?? [])] as Array<{
      organization_id: string | null;
    }>) {
      if (row.organization_id) seen.add(row.organization_id);
    }
    return [...seen];
  });

  if (workspaces.length > 0) {
    await step.sendEvent(
      'watch-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'commitments/watch.workspace' as const,
        data: { organizationId },
      })),
    );
  }
  return { dispatched: workspaces.length };
};

export const commitmentsWatchDispatch = inngest.createFunction(
  { id: 'commitments-watch-dispatch' },
  { cron: WATCH_CRON },
  async (ctx) => commitmentsWatchDispatchJob(ctx as unknown as JobContext),
);

// ---------------------------------------------------------------------------
// One workspace
// ---------------------------------------------------------------------------

interface PlannedNotice {
  commitmentId: string;
  noticeKind: NoticeKind;
  dueOn: string;
  recipientUserId: string | null;
  recipientEmail: string | null;
}

export const commitmentsWatchWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  if (!organizationId) return { skipped: 'no workspace on the event' };

  // Computed once and carried through every step. If a run straddles
  // midnight in Bogotá, every step still agrees on which day it was deciding
  // for — otherwise a notice could be claimed for one date and reported
  // against another.
  const today = bogotaToday();

  // 1. The fleet, from what RUNT already told us -------------------------
  const fleet = await step.run('sync-fleet', async () => {
    const db = getOrgScopedClient(organizationId);
    return syncFleetCommitments(db);
  });

  // 2. Recompute in-force / lapsing / lapsed ------------------------------
  const states = await step.run('refresh-states', async () => {
    const db = getOrgScopedClient(organizationId);
    return refreshStates(db, today);
  });

  // 3. Who gets told what, today ------------------------------------------
  const planned = await step.run('plan-notices', async (): Promise<PlannedNotice[]> => {
    const db = getOrgScopedClient(organizationId);
    const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + HORIZON_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);

    const rows = await listCommitments(db, {
      states: ['in_force', 'due_soon', 'overdue'],
      reviewState: 'confirmed',
      dueBefore: horizon,
      today,
      limit: 2000,
    });
    if (rows.length === 0) return [];

    const notices = await listNoticesFor(
      db,
      rows.map((r) => r.id),
    );
    const acknowledged = new Set(
      notices.filter((n) => n.acknowledged_at).map((n) => `${n.commitment_id}#${n.due_on}`),
    );

    // Los dos se resuelven AHORA y no se congelan en la fila: un cambio de
    // jefe o un administrador nuevo tienen efecto esta misma noche.
    const [admins, managers] = await Promise.all([orgAdmins(db), loadManagerMap(db)]);

    const plan: Omit<PlannedNotice, 'recipientEmail'>[] = [];
    for (const row of rows) {
      const owed = noticesOwedFor(row, today, acknowledged);
      for (const noticeKind of owed) {
        // EL ESCALADO SUBE, Y AHORA SABE POR DÓNDE. Lo nombrado a mano en el
        // compromiso gana siempre; si no, el jefe del responsable
        // (`users.manager_id`, migración 0106); y sólo entonces el primer
        // administrador. El orden entero, con su argumento y sus guardas,
        // vive en `escalationTarget` — una función pura con pruebas, porque
        // un escalado que va a la persona equivocada no se ve roto en
        // ninguna pantalla.
        const to =
          noticeKind === 'escalation'
            ? escalationTarget({
                escalateToUserId: row.escalate_to_user_id,
                ownerUserId: row.owner_user_id,
                managers,
                admins,
              }).userId
            : (row.owner_user_id ?? admins[0] ?? null);
        plan.push({
          commitmentId: row.id,
          noticeKind,
          dueOn: row.due_on,
          recipientUserId: to,
        });
      }
    }

    // Las direcciones se buscan SOBRE EL PLAN YA RESUELTO y no sobre las
    // filas. Antes se armaba una agenda con los responsables, los escalados
    // nombrados y los administradores, y funcionaba porque esos tres eran
    // todos los destinatarios posibles. En cuanto un jefe puede serlo, una
    // agenda construida por adelantado es una lista que hay que acordarse de
    // ampliar — y olvidarse cuesta un aviso que se registra «sin destinatario
    // con correo» siendo mentira.
    const recipients = await emailsFor(
      db,
      plan.map((p) => p.recipientUserId).filter(Boolean) as string[],
    );
    return plan.map((p) => ({
      ...p,
      recipientEmail: p.recipientUserId ? (recipients.get(p.recipientUserId) ?? null) : null,
    }));
  });

  // 4. Claim, then send. The claim is what makes this safe to retry. ------
  const sent = await step.run('send-notices', async () => {
    const db = getOrgScopedClient(organizationId);
    let delivered = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of planned) {
      const claim = await claimNotice(db, {
        commitmentId: item.commitmentId,
        noticeKind: item.noticeKind,
        dueOn: item.dueOn,
        sentOn: today,
        recipientUserId: item.recipientUserId,
        recipientEmail: item.recipientEmail,
        channel: item.recipientEmail ? 'email' : 'none',
      });
      // Somebody already said this, on this occurrence. That is the whole
      // point of the ledger; move on without a word.
      if (claim.outcome === 'sent' || !claim.id) {
        skipped += 1;
        continue;
      }

      if (!item.recipientEmail) {
        await settleNotice(db, {
          id: claim.id,
          delivered: false,
          note: 'Sin destinatario con correo: asigna un responsable al compromiso.',
          sentOn: today,
        });
        failed += 1;
        continue;
      }

      const row = await loadRow(db, item.commitmentId);
      if (!row) {
        await settleNotice(db, {
          id: claim.id,
          delivered: false,
          note: 'El compromiso ya no existe.',
        });
        skipped += 1;
        continue;
      }

      const mail = renderCommitmentNoticeEmail({
        commitment: adaptCommitment(row, today),
        noticeKind: item.noticeKind,
        today,
      });
      const outcome = await sendEmail({
        to: item.recipientEmail,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      });

      await settleNotice(db, {
        id: claim.id,
        delivered: outcome.sent,
        note: outcome.sent ? null : (outcome.reason ?? 'No se pudo enviar'),
        sentOn: today,
      });
      if (outcome.sent) delivered += 1;
      else failed += 1;
    }
    return { planned: planned.length, delivered, skipped, failed };
  });

  // 5. The calendar follows the dates -------------------------------------
  const calendar = await step.run('sync-calendar', async () => {
    const db = getOrgScopedClient(organizationId);
    const rows = await listCommitments(db, {
      states: ['in_force', 'due_soon', 'overdue', 'met'],
      reviewState: 'confirmed',
      today,
      limit: 1000,
    });

    // Only what the calendar does not already reflect. An event that already
    // sits on the right day is left alone — this runs every morning and
    // Google's write quota is not free.
    const stale = rows.filter((r) => {
      const state = deriveState(r, today);
      const shouldExist = state !== 'met' && state !== 'dropped';
      if (!r.owner_user_id) return false;
      if (!shouldExist) return Boolean(r.calendar_event_id);
      return !r.calendar_event_id || r.calendar_synced_due_on !== r.due_on;
    });

    let synced = 0;
    let unavailable = 0;
    for (const row of stale.slice(0, 200)) {
      // The OWNER's context: Google credentials are per person, so this is
      // both how the token is found and how the event lands on the calendar
      // of whoever actually has to act.
      const ctx = buildToolContext({
        organizationId,
        userId: row.owner_user_id as string,
        agentId: row.owner_user_id as string,
        surface: 'schedule',
      });
      try {
        await syncCommitmentToCalendar(ctx, row, today);
        synced += 1;
      } catch (err) {
        // A person without Google connected is the ordinary case, not an
        // error worth failing a run over. The reason is recorded on the row
        // so the screen can say "sin calendario" instead of staying silent.
        unavailable += 1;
        await recordCalendarError(ctx, row.id, (err as Error).message).catch(() => undefined);
      }
    }
    return { considered: stale.length, synced, unavailable };
  });

  logger.info(
    { organizationId, today, fleet, states, sent, calendar },
    'commitments watch finished',
  );
  return { organizationId, today, fleet, states, notices: sent, calendar };
};

export const commitmentsWatchWorkspace = inngest.createFunction(
  { id: 'commitments-watch-workspace', concurrency: { limit: 5 } },
  { event: 'commitments/watch.workspace' },
  async (ctx) => commitmentsWatchWorkspaceJob(ctx as unknown as JobContext),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function loadRow(
  db: ReturnType<typeof getOrgScopedClient>,
  id: string,
): Promise<CommitmentRow | null> {
  const { data } = await db.from('commitments').select('*').eq('id', id).maybeSingle();
  if (!data) return null;
  const [row] = await hydrate(db, [data as CommitmentRow]);
  return row ?? null;
}

/**
 * Which notices this row has earned today.
 *
 * Thin wrapper over the pure `noticesOwed` so the acknowledgement lookup — the
 * one piece that needs the database — stays out of the rule itself.
 */
function noticesOwedFor(
  row: CommitmentRow,
  today: string,
  acknowledged: Set<string>,
): NoticeKind[] {
  return noticesOwed({
    dueOn: row.due_on,
    noticeDays: row.notice_days,
    escalateAfterDays: row.escalate_after_days,
    state: deriveState(row, today),
    today,
    acknowledged: acknowledged.has(`${row.id}#${row.due_on}`),
  });
}

// `orgAdmins` y `emailsFor` vivían aquí y se mudaron a
// packages/agent-tools/src/directory/store.ts, junto a la línea de mando que
// ahora decide con ellas. La mudanza arregló dos cosas de paso: la consulta de
// administradores no tenía `order by` —así que `admins[0]`, el último recurso de
// TODO escalado que nadie nombró, lo elegía el planificador de Postgres— y
// ninguna de las dos miraba su `error`, de modo que una base caída se leía como
// «esta empresa no tiene administradores» y el aviso se archivaba como entregado
// a nadie.
