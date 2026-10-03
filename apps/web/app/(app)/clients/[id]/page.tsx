import { Client360 } from '@/components/clients/Client360';
import { SubjectExpirations } from '@/components/doc-expirations/SubjectExpirations';
import { ClientSalesCard } from '@/components/sales/ClientSalesCard';
import {
  APPLYING_METHODS,
  type ClientStatus,
  ENTITY_KIND_LABEL,
  type LinkEntityKind,
  type LinkMethod,
  METHOD_LABEL,
  METHOD_SENTENCE,
} from '@/lib/clients-shape';
import { loadTeam } from '@/lib/clients/read';
import { client360View } from '@/lib/clients/view360';
import { clientSalesSummary } from '@/lib/sales/view';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  adaptExpiration,
  bogotaToday,
  listExpirations,
  listLinks,
  listSalesDocuments,
  loadClient360,
} from '@cortex/agent-tools';
import { notFound } from 'next/navigation';
import { ClientAside } from '../_components/ClientAside';
import { dayOf, stamp } from '../_components/format';
import type { ContactView, DomainView, LinkView } from '../_components/types';
import {
  addAliasAction,
  addClientNote,
  createClientCommitment,
  setClientOwner,
  setClientTags,
  splitAliasAction,
} from '../actions';

/**
 * La ficha 360 del cliente.
 *
 * Todo lo que Cortex sabe de esta empresa en una pantalla: quién es, cómo va
 * en plata (facturado, saldo, vencido, días de pago, recuperado, lo que se
 * espera cobrar), lo abierto, lo que pasó, y qué pedirle a Cortex. Nada es
 * memoria nueva; es lo que cada módulo ya guardó, ahora alcanzable desde el
 * cliente. Cada sección se lee aparte y, si falla, dice «sin dato».
 *
 * A la derecha siguen los contactos, los dominios y las propuestas de 0075
 * (ClientAside): son las afirmaciones que hacen que lo demás llegue solo.
 */

export const dynamic = 'force-dynamic';

export default async function ClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();

  const [hub, team, proposalRows, expiring, sales] = await Promise.all([
    loadClient360(db, id, { today }),
    loadTeam(db).catch(() => []),
    listLinks(db, { clientId: id, state: 'suggested', limit: 100 }).catch(() => []),
    // Sus documentos que vencen (0184). Si falla, el panel dice «sin dato».
    listExpirations(db, { clientId: id, includeClosed: false, limit: 50 }).then(
      (rows) => ({ rows, error: null as string | null }),
      () => ({ rows: [], error: 'No pude leer sus documentos que vencen.' }),
    ),
    // Sus cotizaciones, pedidos y facturas de Cortex (0182). Si falla, «sin dato».
    listSalesDocuments(db, { clientId: id, limit: 50 }).catch(() => null),
  ]);
  if (!hub) notFound();

  const view = client360View(hub, today);

  // Lo de la columna derecha de 0075, con su forma de siempre.
  const witnesses = new Map(team.map((m) => [m.id, m.name]));
  const contacts: ContactView[] = hub.contacts.map((c) => ({
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
  const domains: DomainView[] = hub.domains.map((d) => ({
    id: d.id,
    domain: d.domain,
    verifiedBy: witnesses.get(d.verified_by) ?? null,
    verifiedLabel: stamp(d.verified_at),
  }));
  const proposals: LinkView[] = proposalRows.map((row) => {
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
  });

  return (
    <Client360
      view={view}
      team={team}
      today={today}
      sales={
        <ClientSalesCard
          clientId={hub.client.id}
          summary={clientSalesSummary(sales, today, 'No pude leer sus cotizaciones y pedidos.')}
        />
      }
      expiring={
        <SubjectExpirations
          error={expiring.error}
          href={`/documentos-vencen?sujeto=${encodeURIComponent(hub.client.name)}`}
          items={expiring.rows.map((r) => {
            const e = adaptExpiration(r, today);
            return {
              id: e.id,
              title: e.title,
              kindLabel: e.kindLabel,
              expiresOn: e.expiresOn,
              when: e.when,
              status: e.status,
              statusLabel: e.statusLabel,
              needsReview: e.needsReview,
            };
          })}
        />
      }
      handlers={{
        addNote: addClientNote,
        createCommitment: createClientCommitment,
        setTags: setClientTags,
        setOwner: setClientOwner,
        addAlias: addAliasAction,
        splitAlias: splitAliasAction,
      }}
      aside={
        <ClientAside
          clientId={hub.client.id}
          clientName={hub.client.name}
          status={hub.client.status as ClientStatus}
          contacts={contacts}
          domains={domains}
          proposals={proposals}
        />
      }
    />
  );
}
