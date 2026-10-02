import { createHash } from 'node:crypto';
import { sendEmail } from '@/lib/email';
import { renderWorkOverdueDigestEmail } from '@/lib/email-templates/work-overdue-digest';
import { inngest } from '@/lib/inngest';
import type { JobContext, JobHandler } from '@/lib/jobs';
import { notify } from '@/lib/notifications/notify';
import { getOrgScopedClient, getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  type AgingPlan,
  type DigestRecipient,
  actionHeadline,
  agingClaimKey,
  agingNotice,
  bogotaToday,
  claimFollowThroughNotice,
  draftsFromManagementCases,
  draftsFromWorkSignals,
  evaluateRecommendations,
  isBusinessDay,
  lastDaysPeriod,
  listActions,
  listDirectory,
  listFollowThroughClaims,
  listFollowUpCases,
  listWorkItems,
  listWorkPeopleMeta,
  loadTeamReport,
  personLabel,
  planApprovalAging,
  planOverdueDigests,
  readOverdueDigestEnabled,
  recordRecommendations,
  rowToPreferences,
  settleFollowThroughNotice,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';

/**
 * PERSEGUIR LO PENDIENTE Y LLEVAR LA CUENTA DE LO RECOMENDADO (0177).
 *
 * Qué se decide está en packages/agent-tools/src/follow-through (reglas puras,
 * con pruebas). Aquí se orquesta, con la forma de siempre: un cron reparte por
 * empresa y cada empresa corre en su trabajo, así que un fallo queda contenido.
 *
 *   1. aging     Lo redactado que lleva un día esperando: UN recordatorio por
 *                persona y día. A los cinco días, «¿lo descarto?» (una vez por
 *                borrador). A quien tiene que decidir, nunca a otro.
 *   2. digest    A cada responsable, UN resumen de lo suyo vencido en el
 *                registro de trabajo. En la campana cada mañana hábil; por
 *                correo sólo los lunes. Dentro de su franja, nunca en sus días
 *                fuera, y si la empresa no lo apagó.
 *   3. learn     Una vez al día (la primera corrida): anotar las señales del
 *                equipo y los asuntos de Gerencia que piden moverse como
 *                recomendaciones, y volver a juzgar lo recomendado — ¿se
 *                siguió? ¿qué pasó después?
 *
 * Reclamar primero, avisar después (follow_through_notices, índice único):
 * correr esto diez veces, o dos a la vez, avisa una. El aviso en la campana
 * lleva además `dedupeKey`.
 *
 * CADA HORA HÁBIL, DE 07:45 A 16:45 DE BOGOTÁ. No porque haya algo nuevo cada
 * hora, sino porque cada quien tiene su franja (la de los avisos del buzón): a
 * quien la empieza a las 09:00 le llega a las 09:45, no nunca. La reclamación
 * diaria impide el segundo aviso. Colombia no cambia la hora: 12:45 UTC son las
 * 07:45 todo el año. Los festivos se saltan en el código.
 */
export const FOLLOW_THROUGH_CRON = '45 12-21 * * 1-5';

/** La hora UTC de la primera corrida del día: la que además aprende. */
const FIRST_RUN_UTC_HOUR = 12;

export const followThroughDispatchJob: JobHandler = async ({ step }) => {
  const today = bogotaToday();
  if (!isBusinessDay(today)) return { skipped: 'día no hábil', today };
  const learn = new Date().getUTCHours() === FIRST_RUN_UTC_HOUR;

  // Sin alcance, y sólo aquí: «qué empresas tienen algo pendiente o algo
  // recomendado» cruza la instalación. Se lee sólo organization_id.
  const workspaces = await step.run('find-workspaces', async (): Promise<string[]> => {
    const raw = getSupabaseServiceClient();
    const since = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const reads = await Promise.all([
      raw.from('work_items').select('organization_id').eq('status', 'open').limit(50_000),
      raw.from('actions').select('organization_id').eq('state', 'proposed').limit(50_000),
      raw.from('recommendations').select('organization_id').gte('created_at', since).limit(50_000),
    ]);
    const seen = new Set<string>();
    for (const { data, error } of reads) {
      if (error) throw error;
      for (const row of (data ?? []) as Array<{ organization_id: string | null }>)
        if (row.organization_id) seen.add(row.organization_id);
    }
    return [...seen];
  });

  if (workspaces.length > 0) {
    await step.sendEvent(
      'follow-through-per-workspace',
      workspaces.map((organizationId) => ({
        name: 'follow-through/workspace' as const,
        data: { organizationId, today, learn },
      })),
    );
  }
  return { dispatched: workspaces.length, today, learn };
};

export const followThroughDispatch = inngest.createFunction(
  { id: 'follow-through-dispatch' },
  { cron: FOLLOW_THROUGH_CRON },
  async (ctx) => followThroughDispatchJob(ctx as unknown as JobContext),
);

/** Ventana de lectura de lo ya reclamado: el borrador vive siete días. */
const CLAIMS_LOOKBACK_DAYS = 10;

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export const followThroughWorkspaceJob: JobHandler = async ({ event, step }) => {
  const organizationId = event.data.organizationId as string | undefined;
  if (!organizationId) return { skipped: 'no workspace on the event' };
  const today = (event.data.today as string | undefined) ?? bogotaToday();
  const learn = event.data.learn === true;
  if (!isBusinessDay(today)) return { skipped: 'día no hábil', today };

  // ── 1. Lo que lleva días esperando tu visto bueno ────────────────────────
  const aging = await step.run('aging', async () => {
    const db = getOrgScopedClient(organizationId);
    const now = new Date();
    const [rows, claimed, directory] = await Promise.all([
      listActions(db, { states: ['proposed'], approvableAt: now, limit: 500 }),
      listFollowThroughClaims(db, {
        kinds: ['approval_reminder', 'approval_discard'],
        sinceDay: shiftDay(today, -CLAIMS_LOOKBACK_DAYS),
      }),
      listDirectory(db),
    ]);
    const people = new Set(directory.map((p) => p.id));
    const plans = planApprovalAging({
      actions: rows.map((r) => ({
        id: r.id,
        userId: r.user_id,
        state: r.state,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        headline: actionHeadline(r),
      })),
      now,
      today,
      claimed,
    });
    let sent = 0;
    for (const plan of plans) {
      // Quien ya no está en la empresa no recibe nada: no hay a quién.
      if (!people.has(plan.userId)) continue;
      if (await deliverAging(db, plan, today)) sent += 1;
    }
    return { planned: plans.length, sent };
  });

  // ── 2. El resumen diario de vencidos ─────────────────────────────────────
  const digest = await step.run('digest', async () => {
    const db = getOrgScopedClient(organizationId);
    const enabled = await readOverdueDigestEnabled(db);
    if (!enabled) return { enabled: false, sent: 0 };
    const now = new Date();
    const [{ items }, directory, meta, claimed] = await Promise.all([
      listWorkItems(db, { status: 'open', limit: 5000 }),
      listDirectory(db),
      listWorkPeopleMeta(db),
      listFollowThroughClaims(db, { kinds: ['work_digest'], sinceDay: today }),
    ]);
    const owners = [...new Set(items.map((i) => i.assigneeId).filter((v): v is string => !!v))];
    const prefs = new Map<string, Record<string, unknown>>();
    if (owners.length) {
      const { data, error } = await db
        .from('user_preferences')
        .select('user_id, timezone, mail_alerts_from, mail_alerts_to')
        .in('user_id', owners);
      if (error) throw error;
      for (const row of (data ?? []) as Array<Record<string, unknown>>)
        prefs.set(String(row.user_id), row);
    }
    const recipients = new Map<string, DigestRecipient & { email: string }>();
    for (const p of directory) {
      const pref = rowToPreferences(p.id, (prefs.get(p.id) ?? null) as never);
      recipients.set(p.id, {
        id: p.id,
        name: personLabel(p),
        email: p.email,
        timezone: pref.timezone,
        windowFrom: pref.mailAlertsFrom,
        windowTo: pref.mailAlertsTo,
        awayDays: meta.get(p.id)?.awayDays ?? [],
      });
    }
    const alreadySent = new Set(
      [...claimed]
        .filter((k) => k.endsWith(`|work_digest|${today}`))
        .map((k) => k.split('|')[0] as string),
    );
    const plans = planOverdueDigests({ items, recipients, today, now, alreadySent, enabled });
    const monday = new Date(`${today}T12:00:00Z`).getUTCDay() === 1;
    let sent = 0;
    for (const plan of plans) {
      const id = await claimFollowThroughNotice(db, {
        userId: plan.userId,
        kind: 'work_digest',
        ref: today,
        sentOn: today,
        itemCount: plan.count,
      });
      if (!id) continue;
      const inApp = await notify(db, {
        userId: plan.userId,
        kind: 'work_overdue',
        title: plan.title,
        body: plan.body,
        href: '/team/yo',
        dedupeKey: `work-overdue:${plan.userId}:${today}`,
      });
      let mailed = false;
      const person = recipients.get(plan.userId);
      if (monday && person?.email.includes('@')) {
        const mail = renderWorkOverdueDigestEmail({
          title: plan.title,
          count: plan.count,
          lines: plan.lines.map((l) => ({ title: l.title, daysOverdue: l.daysOverdue })),
        });
        const out = await sendEmail({
          to: person.email,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
        mailed = out.sent;
      }
      await settleFollowThroughNotice(db, id, Boolean(inApp) || mailed);
      if (inApp || mailed) sent += 1;
    }
    return { enabled: true, planned: plans.length, sent };
  });

  // ── 3. Llevar la cuenta de lo recomendado ────────────────────────────────
  const learned = learn
    ? await step.run('learn', async () => {
        const db = getOrgScopedClient(organizationId);
        const now = new Date();
        const team = await loadTeamReport(db, lastDaysPeriod(today), { today }).catch(() => null);
        const cases = await listFollowUpCases(db).catch(() => []);
        const drafts = [
          ...(team ? draftsFromWorkSignals(team.report) : []),
          ...draftsFromManagementCases(cases, today),
        ];
        const recorded = drafts.length ? await recordRecommendations(db, drafts, { now }) : 0;
        const evaluated = await evaluateRecommendations(db, {
          now,
          workItems: team ? team.items : null,
        });
        return { recorded, considered: evaluated.considered, updated: evaluated.updated };
      })
    : { skipped: 'sólo en la primera corrida del día' };

  logger.info({ organizationId, today, aging, digest, learned }, 'follow-through finished');
  return { organizationId, today, aging, digest, learned };
};

/**
 * Reclama y entrega un aviso de aprobaciones paradas. Para el «¿lo descarto?»
 * se reclama cada borrador por su cuenta (una vez en su vida); si todos ya
 * estaban reclamados, no se avisa nada.
 */
async function deliverAging(
  db: ReturnType<typeof getOrgScopedClient>,
  plan: AgingPlan,
  today: string,
): Promise<boolean> {
  const kind = plan.step === 'discard' ? 'approval_discard' : 'approval_reminder';
  const won: Array<{ id: string; ref: string }> = [];
  for (const ref of plan.refs) {
    const id = await claimFollowThroughNotice(db, {
      userId: plan.userId,
      kind,
      ref,
      sentOn: today,
      itemCount: plan.actionIds.length,
    });
    if (id) won.push({ id, ref });
  }
  if (!won.length) return false;
  const keep = plan.step === 'discard' ? new Set(won.map((w) => w.ref)) : null;
  const effective: AgingPlan = keep
    ? {
        ...plan,
        actionIds: plan.actionIds.filter((a) => keep.has(a)),
        headlines: plan.headlines.filter((_, i) => keep.has(plan.actionIds[i] as string)),
      }
    : plan;
  const copy = agingNotice(effective);
  const key = createHash('sha256')
    .update(won.map((w) => agingClaimKey(plan.userId, kind, w.ref)).join(','))
    .digest('hex')
    .slice(0, 32);
  const id = await notify(db, {
    userId: plan.userId,
    kind: 'approval_waiting',
    title: copy.title,
    body: copy.body,
    href: copy.href,
    dedupeKey: `approval-waiting:${key}`,
  });
  for (const w of won) await settleFollowThroughNotice(db, w.id, Boolean(id));
  return Boolean(id);
}

export const followThroughWorkspace = inngest.createFunction(
  { id: 'follow-through-workspace', concurrency: { limit: 5 } },
  { event: 'follow-through/workspace' },
  async (ctx) => followThroughWorkspaceJob(ctx as unknown as JobContext),
);
