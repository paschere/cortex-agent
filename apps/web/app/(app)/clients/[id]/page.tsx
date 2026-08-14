import { Panel, PanelHead } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
import {
  APPLYING_METHODS,
  CUSTOMS_ROLE_LABEL,
  ENTITY_KIND_LABEL,
  METHOD_LABEL,
  METHOD_SENTENCE,
  SERVICE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  type ClientService,
  type ClientStatus,
  type CustomsRole,
  type LinkEntityKind,
  type LinkMethod,
} from '@/lib/clients-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  KIND_LABEL,
  STATE_LABEL,
  bogotaToday,
  clientOverview,
  daysBetween,
  fullNit,
} from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  FileText,
  Mail,
  MessageCircle,
  Mic,
  Truck,
  UserRound,
} from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ClientAside } from '../_components/ClientAside';
import { cop, dayOf, shortDate, stamp, whenPhrase } from '../_components/format';
import type {
  CommitmentView,
  ContactView,
  DomainView,
  LinkView,
} from '../_components/types';

/**
 * La ficha del cliente.
 *
 * THE SCREEN THAT JUSTIFIES THE WHOLE MODULE. Somebody types "Coltrans" and
 * sees the mail, what was agreed in the last meeting, the deadlines, the
 * documents and who is spoken to there — in one place, newest first, each with
 * where it came from.
 *
 * None of it is new memory. Every row on this page was already stored by the
 * module that owns it; what changed is that it is now reachable from the
 * customer. So every claim carries a `<Provenance>` chip naming HOW it got
 * here — "Dominio del correo · carlos@coltrans.com" is checkable in a glance,
 * and a link with no such story is not shown as a fact at all: it sits in
 * "Por revisar" until a person says so.
 *
 * Everything is computed once, on the server, against today in Bogotá, and
 * handed down as conclusions — so a card, a count and a section header can
 * never disagree about whether something has lapsed.
 */

export const dynamic = 'force-dynamic';

const KIND_ICON: Record<LinkEntityKind, typeof Mail> = {
  email_thread: Mail,
  meeting: Mic,
  document: FileText,
  whatsapp_group: MessageCircle,
  vehicle: Truck,
  contact: UserRound,
};

const SOURCE_ORDER: LinkEntityKind[] = [
  'email_thread',
  'meeting',
  'document',
  'whatsapp_group',
  'vehicle',
  'contact',
];

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();

  const overview = await clientOverview(db, id, today).catch(() => null);
  if (!overview) notFound();

  // Names for whoever vouched for each domain. A domain with no author would
  // undercut the reason every automatic link is trusted, so the card shows it.
  const witnessIds = [...new Set(overview.domains.map((d) => d.verified_by))];
  const witnesses = witnessIds.length
    ? await db
        .from('users')
        .select('id, name, email')
        .in('id', witnessIds)
        .then(({ data }) =>
          new Map(
            ((data ?? []) as Array<{ id: string; name: string | null; email: string }>).map((u) => [
              u.id,
              u.name?.trim() || u.email,
            ]),
          ),
        )
    : new Map<string, string>();

  const client = overview.client;
  const status = client.status as ClientStatus;

  const toLinkView = (row: (typeof overview.links)[number]): LinkView => {
    const method = row.method as LinkMethod;
    return {
      id: row.id,
      kind: row.entity_kind as LinkEntityKind,
      kindLabel: ENTITY_KIND_LABEL[row.entity_kind as LinkEntityKind] ?? row.entity_kind,
      label: row.label?.trim() || 'Sin título',
      whenLabel: dayOf(row.occurred_at) ?? dayOf(row.created_at),
      occurredAt: row.occurred_at ?? row.created_at,
      method,
      methodLabel: METHOD_LABEL[method] ?? method,
      why: METHOD_SENTENCE[method] ?? '',
      evidence: row.evidence,
      automatic: APPLYING_METHODS.includes(method),
    };
  };

  const links = overview.links
    .map(toLinkView)
    .sort((a, b) => (b.occurredAt ?? '').localeCompare(a.occurredAt ?? ''));
  const proposals = overview.proposals.map(toLinkView);

  const commitments: CommitmentView[] = overview.commitments.map((c) => ({
    id: c.id,
    title: c.title,
    kindLabel: KIND_LABEL[c.kind as keyof typeof KIND_LABEL] ?? c.kind,
    dueLabel: shortDate(c.dueOn),
    daysLeft: daysBetween(today, c.dueOn),
    state: c.state as CommitmentView['state'],
    stateLabel: STATE_LABEL[c.state as keyof typeof STATE_LABEL] ?? c.state,
    amountCop: c.amountCop,
  }));
  const openCommitments = commitments.filter((c) => c.state !== 'met' && c.state !== 'dropped');

  const contacts: ContactView[] = overview.contacts.map((c) => ({
    id: c.id,
    name: c.full_name,
    email: c.email,
    phone: c.phone,
    role: c.role_title,
    isPrimary: c.is_primary,
    statusLabel: c.status === 'left' ? 'Ya no está' : c.status === 'unknown' ? 'Sin confirmar' : '',
    sourceLabel: c.source === 'manual' ? 'Registrado a mano' : `Visto en ${c.source}`,
    lastSeenLabel: stamp(c.last_seen_at),
  }));

  const domains: DomainView[] = overview.domains.map((d) => ({
    id: d.id,
    domain: d.domain,
    verifiedBy: witnesses.get(d.verified_by) ?? null,
    verifiedLabel: stamp(d.verified_at),
  }));

  const byKind = new Map<LinkEntityKind, number>();
  for (const link of links) byKind.set(link.kind, (byKind.get(link.kind) ?? 0) + 1);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-8">
      <Link
        href="/clients"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-ink-muted transition-colors duration-150 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Clientes
      </Link>

      {/* --- Identity ------------------------------------------------------ */}
      <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-card bg-primary-soft text-primary ring-1 ring-inset ring-primary/10">
            <Building2 className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-extrabold tracking-[-0.02em] text-ink">
                {client.name}
              </h1>
              <span
                className={clsx(
                  'rounded-pill px-2 py-0.5 text-micro font-bold',
                  STATUS_TONE[status] === 'emerald' && 'bg-emerald-soft text-emerald',
                  STATUS_TONE[status] === 'amber' && 'bg-amber-soft text-amber',
                  STATUS_TONE[status] === 'sky' && 'bg-sky-soft text-sky',
                  STATUS_TONE[status] === 'rose' && 'bg-rose-soft text-rose',
                )}
              >
                {STATUS_LABEL[status] ?? status}
              </span>
            </div>
            {client.legal_name && (
              <p className="mt-0.5 text-sm text-ink-muted">{client.legal_name}</p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-muted">
              {client.tax_id && (
                <span className="tabular font-medium text-ink">NIT {fullNit(client.tax_id)}</span>
              )}
              {client.city && (
                <span>
                  {client.city}
                  {client.department ? `, ${client.department}` : ''}
                </span>
              )}
              {client.phone && <span className="tabular">{client.phone}</span>}
              {client.customs_role && (
                <span>{CUSTOMS_ROLE_LABEL[client.customs_role as CustomsRole]}</span>
              )}
              {client.payment_terms_days != null && (
                <span>
                  Paga a <span className="tabular">{client.payment_terms_days}</span> días
                </span>
              )}
              {client.owner_name && <span>Responsable: {client.owner_name}</span>}
            </div>
            {(client.services ?? []).length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {(client.services ?? []).map((s) => (
                  <span
                    key={s}
                    className="rounded-pill bg-surface-2 px-2.5 py-1 text-micro font-medium text-ink-muted"
                  >
                    {SERVICE_LABEL[s as ClientService] ?? s}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* --- What is hanging here ------------------------------------------ */}
      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Panel>
            <PanelHead
              icon={<CalendarClock className="h-4 w-4" aria-hidden />}
              title="Vencimientos"
              right={
                openCommitments.length > 0
                  ? `${openCommitments.length} abierto${openCommitments.length === 1 ? '' : 's'}`
                  : undefined
              }
            />
            {openCommitments.length === 0 ? (
              <p className="px-5 pb-5 pt-3 text-sm leading-snug text-ink-muted">
                No hay nada con fecha a nombre de este cliente. Los vencimientos se registran en la
                pantalla de Vencimientos y llegan acá solos cuando la contraparte es este cliente.
              </p>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {openCommitments.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink">{c.title}</p>
                      <p className="mt-0.5 text-xs text-ink-faint">
                        {c.kindLabel}
                        {c.amountCop ? ` · ${cop(c.amountCop)}` : ''}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p
                        className={clsx(
                          'tabular text-sm font-semibold',
                          c.state === 'overdue' && 'text-rose',
                          c.state === 'due_soon' && 'text-amber',
                          c.state === 'in_force' && 'text-ink',
                        )}
                      >
                        {c.dueLabel}
                      </p>
                      <p className="text-micro text-ink-faint">{whenPhrase(c.daysLeft)}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel>
            <PanelHead
              icon={<Mail className="h-4 w-4" aria-hidden />}
              title="Lo que ya está guardado"
              right={
                links.length > 0
                  ? SOURCE_ORDER.filter((k) => byKind.has(k))
                      .map((k) => `${byKind.get(k)} ${ENTITY_KIND_LABEL[k].toLowerCase()}`)
                      .join(' · ')
                  : undefined
              }
            />
            {links.length === 0 ? (
              <div className="px-5 pb-6 pt-3">
                <p className="text-sm leading-snug text-ink-muted">
                  Todavía no hay nada colgado de este cliente. Cortex ya guarda correos, reuniones,
                  documentos y grupos: lo que falta es decirle cuáles son de esta empresa.
                </p>
                <p className="mt-2 text-sm leading-snug text-ink-muted">
                  Registrar el dominio de su correo —acá al lado— es lo que más rinde: desde ese
                  momento, todo lo que llegue de ahí se le atribuye solo.
                </p>
              </div>
            ) : (
              <ul className="mt-2 divide-y divide-border">
                {links.map((link) => {
                  const Icon = KIND_ICON[link.kind] ?? FileText;
                  return (
                    <li key={link.id} className="flex items-start gap-3 px-5 py-3.5">
                      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-faint">
                        <Icon className="h-3.5 w-3.5" aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="truncate text-sm font-medium text-ink">
                            {link.label}
                          </span>
                          <span className="text-micro text-ink-faint">{link.kindLabel}</span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          {/*
                            The signature element. Every row on this list is
                            Cortex asserting "this belongs to Coltrans", and the
                            chip is the receipt: how it got here, and the literal
                            thing that justified it.
                          */}
                          <Provenance
                            source={link.methodLabel}
                            readAt={link.whenLabel ?? undefined}
                            detail={link.evidence ?? undefined}
                          />
                          {!link.automatic && (
                            <span className="text-micro text-ink-faint">
                              confirmado por una persona
                            </span>
                          )}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>

        <ClientAside
          clientId={client.id}
          clientName={client.name}
          status={status}
          contacts={contacts}
          domains={domains}
          proposals={proposals}
        />
      </div>
    </div>
  );
}
