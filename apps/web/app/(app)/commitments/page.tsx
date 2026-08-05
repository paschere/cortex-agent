import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type CommitmentRow,
  adaptCommitment,
  bogotaToday,
  listCommitments,
  listNoticesFor,
} from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { CalendarClock } from 'lucide-react';
import { CommitmentBoard } from './_components/CommitmentBoard';
import { longDate, shortDate, stamp } from './_components/format';
import type { CommitmentView } from './_components/types';

/**
 * Vencimientos.
 *
 * THE NAME. "Compromisos" is what the data model calls these and it is not what
 * anybody says out loud; "obligaciones" is what a lawyer would write on the
 * folder. A jefe de operaciones in Bogotá asks "¿qué se nos vence este mes?",
 * and the same word covers all of it — el SOAT se vence, la póliza se vence, el
 * plazo de aduana se vence, el pago se vence. The screen is named after the
 * question people already ask, not after the table underneath it. The code
 * stays English (`commitments`), the way every other screen in this codebase
 * does.
 *
 * Everything on this page is computed against TODAY IN BOGOTÁ, once, on the
 * server, and handed down as conclusions — so a card, a section header and a
 * count can never disagree about whether something is lapsed.
 */

export const dynamic = 'force-dynamic';

/** How far ahead the "vigente" tail is worth listing. */
const HORIZON_DAYS = 400;

export default async function CommitmentsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();
  const horizon = new Date(Date.parse(`${today}T00:00:00Z`) + HORIZON_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const [open, pendingRows, people] = await Promise.all([
    listCommitments(db, {
      states: ['overdue', 'due_soon', 'in_force'],
      reviewState: 'confirmed',
      dueBefore: horizon,
      today,
      limit: 500,
    }),
    listCommitments(db, { reviewState: 'pending', today, limit: 100 }),
    db
      .from('users')
      .select('id, name, email')
      .order('name', { ascending: true })
      .limit(200)
      .then(({ data }) =>
        ((data ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => ({
          id: u.id,
          name: u.name?.trim() || u.email,
        })),
      ),
  ]);

  // One query for every notice on every open commitment, so a card can say "ya
  // avisado" without the list fanning out into one query per row.
  const notices = await listNoticesFor(
    db,
    [...open, ...pendingRows].map((r) => r.id),
  );
  const noticeIndex = new Map<string, { count: number; last: string | null; acked: boolean }>();
  for (const n of notices) {
    const entry = noticeIndex.get(`${n.commitment_id}#${n.due_on}`) ?? {
      count: 0,
      last: null,
      acked: false,
    };
    entry.count += n.delivered ? 1 : 0;
    if (!entry.last || n.sent_on > entry.last) entry.last = n.sent_on;
    if (n.acknowledged_at) entry.acked = true;
    noticeIndex.set(`${n.commitment_id}#${n.due_on}`, entry);
  }

  const toView = (row: CommitmentRow): CommitmentView => {
    const c = adaptCommitment(row, today);
    const notice = noticeIndex.get(`${row.id}#${row.due_on}`);
    return {
      id: c.id,
      title: c.title,
      detail: c.detail,
      kind: c.kind,
      kindLabel: c.kindLabel,
      counterparty: c.counterparty,
      amountCop: c.amountCop,
      dueOn: c.dueOn,
      dueLabel: shortDate(c.dueOn),
      daysLeft: c.daysLeft,
      state: c.state,
      stateLabel: c.stateLabel,
      noticeDays: c.noticeDays,
      owner: c.owner,
      vehiclePlate: c.vehiclePlate,
      recurrence: c.recurrence,
      source: {
        kind: c.source.kind,
        label: c.source.label,
        readAt: stamp(c.source.readAt),
        quote: c.source.quote,
        documentId: c.source.documentId,
        confirmed: c.source.confirmed,
      },
      calendarError: row.calendar_error,
      hasCalendarEvent: Boolean(row.calendar_event_id),
      noticesSent: notice?.count ?? 0,
      lastNoticeOn: notice?.last ?? null,
      acknowledged: notice?.acked ?? false,
    };
  };

  const views = open.map(toView);
  const overdue = views.filter((v) => v.state === 'overdue');
  const dueSoon = views.filter((v) => v.state === 'due_soon');
  const inForce = views.filter((v) => v.state === 'in_force');
  const pending = pendingRows.map(toView);

  // The money at risk this month: what a payment deadline actually costs if it
  // slips. Only counted for what is overdue or lapsing, because a payment due
  // in November is not "en riesgo" in August.
  const atRisk = [...overdue, ...dueSoon].reduce((sum, v) => sum + (v.amountCop ?? 0), 0);

  const stats: Array<{
    label: string;
    value: string;
    sub: string;
    tone?: 'emerald' | 'amber' | 'rose';
  }> = [
    {
      label: 'Vencido',
      value: String(overdue.length),
      sub: overdue.length > 0 ? 'hay que resolverlo hoy' : 'nada pendiente',
      tone: overdue.length > 0 ? 'rose' : undefined,
    },
    {
      label: 'Por vencer',
      value: String(dueSoon.length),
      sub: 'dentro de su ventana de aviso',
      tone: dueSoon.length > 0 ? 'amber' : undefined,
    },
    {
      label: 'Vigente',
      value: String(inForce.length),
      sub: 'con holgura',
      tone: inForce.length > 0 ? 'emerald' : undefined,
    },
    {
      label: 'Sin confirmar',
      value: String(pending.length),
      sub: pending.length > 0 ? 'nadie los ha revisado' : 'bandeja vacía',
      tone: pending.length > 0 ? 'amber' : undefined,
    },
    {
      label: 'En riesgo',
      value: atRisk > 0 ? `$${Math.round(atRisk).toLocaleString('es-CO')}` : '—',
      sub: 'pagos vencidos o por vencer',
    },
  ];

  return (
    <>
      <PageHeader
        title="Vencimientos"
        subtitle="Lo que se le vence a la empresa y quién responde por cada cosa. Cortex lo revisa todos los días y avisa antes, no después. Cada fecha muestra de dónde salió."
        icon={<CalendarClock className="h-5 w-5" />}
      />

      <Panel className="mb-5 grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-5">
        {stats.map((s) => (
          <div key={s.label} className="bg-surface px-4 py-3">
            <div className="field-label truncate" title={s.label}>
              {s.label}
            </div>
            <div
              className={clsx(
                'stat-num mt-1 truncate text-[20px] leading-none',
                s.tone === 'rose'
                  ? 'text-rose'
                  : s.tone === 'amber'
                    ? 'text-amber'
                    : s.tone === 'emerald'
                      ? 'text-emerald'
                      : 'text-ink',
              )}
              title={s.value}
            >
              {s.value}
            </div>
            <div className="mt-1 truncate text-[10.5px] text-ink-faint" title={s.sub}>
              {s.sub}
            </div>
          </div>
        ))}
      </Panel>

      {views.length === 0 && pending.length === 0 ? (
        <Panel className="p-8 text-center">
          <h2 className="text-[15px] font-semibold text-ink">Todavía no hay nada que vigilar</h2>
          <p className="mx-auto mt-2 max-w-lg text-[13px] leading-relaxed text-ink-muted">
            Registra el primero, o pídele a Cortex en el chat que lea un contrato del cerebro y te
            proponga las fechas. Los SOAT y las tecnomecánicas de la flota entran solos apenas
            consultes el RUNT de cada placa.
          </p>
          <p className="mt-3 text-[11.5px] text-ink-faint">Hoy es {longDate(today)} en Colombia.</p>
        </Panel>
      ) : null}

      <CommitmentBoard
        overdue={overdue}
        dueSoon={dueSoon}
        inForce={inForce}
        pending={pending}
        people={people}
      />
    </>
  );
}
