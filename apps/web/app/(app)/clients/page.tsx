import { ClientsList } from '@/components/clients/ClientsList';
import { ReviewQueue } from '@/components/clients/ReviewQueue';
import type { GridView } from '@/components/datagrid/types';
import { PageHeader } from '@/components/ui/page-header';
import {
  CLIENTS_ASK_CONTEXT,
  CLIENTS_VIEW_SCOPE,
  clientColumns,
  clientGridRow,
  clientPresets,
  tagsInUse,
} from '@/lib/clients/grid';
import { loadReviewQueue, loadTeam } from '@/lib/clients/read';
import { listGridViews } from '@/lib/datagrid/views-store';
import { requireSession } from '@/lib/session';
import { chipClass } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, loadClientList } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Building2 } from 'lucide-react';
import Link from 'next/link';
import { NewClientButton } from './_components/NewClient';
import {
  assignCounterparty,
  bulkEditClients,
  claimCounterparty,
  confirmProposals,
  deleteClientView,
  editClientCell,
  mergeClientsAction,
  quickCreateClient,
  rejectProposals,
  runClientLinking,
  saveClientView,
} from './actions';

/**
 * Clientes: el eje de Cortex.
 *
 * Una fila por cliente con lo que importa para decidir a quién llamar hoy —
 * facturado en el año, saldo, vencido, cuánto se demora en pagar, cuándo se
 * habló por última vez, qué vence después y su salud en palabras—, en la
 * grilla compartida con vistas guardadas del equipo (scope `clients`).
 *
 * La segunda pestaña, «Por confirmar», es lo que Cortex sospecha y nadie ha
 * dicho: propuestas por nombre, posibles duplicados, clientes del programa
 * contable que chocan, contrapartes sueltas. Nada de eso cuenta hasta que una
 * persona decide (0075, 0179).
 */

export const dynamic = 'force-dynamic';

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = await searchParams;
  const tab = q.tab === 'confirmar' ? 'confirmar' : 'lista';
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();

  const [list, team, savedViews, review] = await Promise.all([
    loadClientList(db, { today }),
    loadTeam(db).catch(() => []),
    listGridViews(CLIENTS_VIEW_SCOPE).catch((): GridView[] => []),
    tab === 'confirmar' ? loadReviewQueue(db) : Promise.resolve(null),
  ]);

  const tabs = [
    { id: 'lista', label: 'Clientes', href: '/clients', count: list.rows.length },
    {
      id: 'confirmar',
      label: 'Por confirmar',
      href: '/clients?tab=confirmar',
      count: list.pending,
    },
  ];

  return (
    <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
      <PageHeader
        title="Clientes"
        subtitle="Cada empresa con la que trabajas y todo lo de ella: facturas, pagos, correos, reuniones, compromisos y trabajo del equipo."
        icon={<Building2 className="h-5 w-5" aria-hidden />}
      />

      <nav className="mb-5 flex gap-1 border-b border-border" aria-label="Secciones de clientes">
        {tabs.map((t) => (
          <Link
            key={t.id}
            href={t.href}
            aria-current={tab === t.id ? 'page' : undefined}
            className={clsx(
              '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold transition-colors duration-150 motion-reduce:transition-none',
              tab === t.id
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
            {t.count > 0 && (
              <span className={chipClass(t.id === 'confirmar' ? 'amber' : 'neutral')}>
                {t.count}
              </span>
            )}
          </Link>
        ))}
      </nav>

      {tab === 'confirmar' && review ? (
        <ReviewQueue
          groups={review.groups}
          duplicates={review.duplicates}
          backlog={review.backlog}
          conflicts={review.conflicts}
          handlers={{
            confirm: confirmProposals,
            reject: rejectProposals,
            merge: mergeClientsAction,
            assignCounterparty,
            claimCounterparty,
          }}
        />
      ) : (
        <ClientsList
          columns={clientColumns(team, tagsInUse(list.rows))}
          rows={list.rows.map(clientGridRow)}
          presets={clientPresets(user.id)}
          savedViews={savedViews}
          missing={list.missing}
          pending={list.pending}
          reviewHref="/clients?tab=confirmar"
          askCortexContext={CLIENTS_ASK_CONTEXT}
          createSlot={<NewClientButton />}
          onEdit={editClientCell}
          onBulkEdit={bulkEditClients}
          onCreate={quickCreateClient}
          onSaveView={saveClientView}
          onDeleteView={deleteClientView}
          onRunLinking={runClientLinking}
        />
      )}
    </div>
  );
}
