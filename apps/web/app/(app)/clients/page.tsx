import { PageHeader } from '@/components/ui/page-header';
import { StatCard } from '@/components/ui/panel';
import { STATUS_LABEL, type ClientStatus } from '@/lib/clients-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  bogotaToday,
  deriveState,
  fullNit,
  listClients,
  listDomains,
  unlinkedCounterparties,
} from '@cortex/agent-tools';
import { Building2, CalendarClock, Link2, Users } from 'lucide-react';
import { Directory } from './_components/Directory';
import { dayOf } from './_components/format';
import type { BacklogView, ClientRowView } from './_components/types';

/**
 * Clientes.
 *
 * THE PAGE THAT GIVES EVERYTHING ELSE AN AXIS. Cortex already stored the mail,
 * the transcripts, the documents, the WhatsApp groups and the deadlines; every
 * one of them was filed under its own identity and none of them under the
 * customer. This is the customer.
 *
 * Two things share the screen on purpose. The directory is the list people came
 * for. Underneath it sits the BACKLOG: the counterparties that already exist as
 * free text on a deadline and that no client answers for yet. That panel is the
 * migration, made visible and finishable — the alternative was a number in a
 * commit message that nobody can act on.
 */

export const dynamic = 'force-dynamic';

export default async function ClientsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();

  const [clients, domains, backlogRows, linkRows, commitmentRows, proposalCount] =
    await Promise.all([
      listClients(db, { limit: 500 }),
      listDomains(db),
      unlinkedCounterparties(db, 12),
      db
        .from('client_links')
        .select('client_id, entity_kind')
        .eq('state', 'confirmed')
        .limit(5000)
        .then(({ data }) => (data ?? []) as Array<{ client_id: string; entity_kind: string }>),
      db
        .from('commitments')
        .select('client_id, due_on, notice_days, state')
        .not('client_id', 'is', null)
        .eq('review_state', 'confirmed')
        .limit(3000)
        .then(
          ({ data }) =>
            (data ?? []) as Array<{
              client_id: string;
              due_on: string;
              notice_days: number;
              state: string;
            }>,
        ),
      db
        .from('client_links')
        .select('id')
        .eq('state', 'suggested')
        .limit(500)
        .then(({ data }) => (data ?? []).length),
    ]);

  const attachedBy = new Map<string, number>();
  for (const link of linkRows) {
    attachedBy.set(link.client_id, (attachedBy.get(link.client_id) ?? 0) + 1);
  }

  const domainsBy = new Map<string, string[]>();
  for (const d of domains) {
    domainsBy.set(d.client_id, [...(domainsBy.get(d.client_id) ?? []), d.domain]);
  }

  const openBy = new Map<string, number>();
  const overdueBy = new Map<string, number>();
  for (const row of commitmentRows) {
    // Derived from the date, not read off the cached column — the same rule the
    // vencimientos screen follows, so the two can never disagree by a day.
    const state =
      row.state === 'met' || row.state === 'dropped' ? row.state : deriveState(row, today);
    if (state === 'met' || state === 'dropped') continue;
    openBy.set(row.client_id, (openBy.get(row.client_id) ?? 0) + 1);
    if (state === 'overdue') {
      overdueBy.set(row.client_id, (overdueBy.get(row.client_id) ?? 0) + 1);
    }
  }

  const rows: ClientRowView[] = clients.map((c) => ({
    id: c.id,
    name: c.name,
    legalName: c.legal_name,
    nit: fullNit(c.tax_id),
    status: c.status as ClientStatus,
    statusLabel: STATUS_LABEL[c.status as ClientStatus] ?? c.status,
    city: c.city,
    services: c.services ?? [],
    owner: c.owner_name ?? null,
    attached: attachedBy.get(c.id) ?? 0,
    openCommitments: openBy.get(c.id) ?? 0,
    overdueCommitments: overdueBy.get(c.id) ?? 0,
    domains: domainsBy.get(c.id) ?? [],
    updatedLabel: dayOf(c.updated_at) ?? '',
  }));

  const backlog: BacklogView[] = backlogRows.map((b) => ({
    counterparty: b.counterparty,
    count: b.count,
    candidates: b.candidates
      .map((cand) => {
        const client = clients.find((c) => c.id === cand.clientId);
        return client
          ? {
              id: client.id,
              name: client.name,
              why: cand.method === 'tax_id' ? `coincide el ${cand.evidence}` : 'coincide el nombre',
            }
          : null;
      })
      .filter((c): c is { id: string; name: string; why: string } => c !== null),
  }));

  const active = rows.filter((r) => r.status === 'active').length;
  const withoutDomain = rows.filter((r) => r.domains.length === 0).length;
  const overdue = rows.reduce((sum, r) => sum + r.overdueCommitments, 0);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8">
      <PageHeader
        title="Clientes"
        subtitle="Cada empresa con la que trabajas, y todo lo que Cortex ya tiene de ella: correos, reuniones, documentos, grupos y vencimientos."
        icon={<Building2 className="h-5 w-5" aria-hidden />}
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Clientes activos"
          value={String(active)}
          sub={rows.length === active ? 'todos activos' : `de ${rows.length} en total`}
          icon={<Building2 className="h-4 w-4" aria-hidden />}
          tone="emerald"
        />
        <StatCard
          label="Vencido"
          value={String(overdue)}
          sub={overdue > 0 ? 'hay que resolverlo hoy' : 'nada pendiente'}
          icon={<CalendarClock className="h-4 w-4" aria-hidden />}
          tone={overdue > 0 ? 'rose' : 'emerald'}
          delay={60}
        />
        <StatCard
          label="Sin dominio"
          value={String(withoutDomain)}
          sub={
            withoutDomain > 0
              ? 'sus correos no se vinculan solos'
              : 'todos vinculan correo automáticamente'
          }
          icon={<Users className="h-4 w-4" aria-hidden />}
          tone={withoutDomain > 0 ? 'amber' : 'emerald'}
          delay={120}
        />
        <StatCard
          label="Por revisar"
          value={String(proposalCount)}
          sub={proposalCount > 0 ? 'propuestas sin confirmar' : 'nada esperando'}
          icon={<Link2 className="h-4 w-4" aria-hidden />}
          tone={proposalCount > 0 ? 'amber' : 'emerald'}
          delay={180}
        />
      </div>

      <div className="mt-7">
        <Directory clients={rows} backlog={backlog} />
      </div>
    </div>
  );
}
