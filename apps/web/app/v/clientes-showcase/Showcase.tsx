'use client';

import { Client360 } from '@/components/clients/Client360';
import { ClientsList } from '@/components/clients/ClientsList';
import { ReviewQueue } from '@/components/clients/ReviewQueue';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import { PageHeader } from '@/components/ui/page-header';
import type {
  AccountingConflictView,
  ActionResult,
  BacklogView,
  Client360View,
  DuplicateView,
  Piece,
  ProposalGroupView,
  TeamMember,
} from '@/lib/clients/types';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Building2 } from 'lucide-react';
import { useEffect } from 'react';

/**
 * Clientes con datos inventados: la lista (grilla + vistas rápidas), «Por
 * confirmar» y la ficha 360 de Nexa. Las acciones son de mentira: contestan
 * en pantalla sin tocar ninguna base.
 */

const fake = async (note: string): Promise<ActionResult> => {
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, note: `(escaparate) ${note}` };
};

export function ClientesFixture({
  dark,
  pantalla,
  list,
  ficha,
  review,
  team,
  today,
}: {
  dark: boolean;
  pantalla: 'lista' | 'confirmar' | 'ficha';
  list: {
    columns: GridColumn[];
    rows: GridRow[];
    presets: Array<{ id: string; label: string; view: Partial<GridView> }>;
    savedViews: GridView[];
    missing: string[];
    pending: number;
  };
  ficha: Client360View;
  review: {
    groups: Piece<ProposalGroupView[]>;
    duplicates: Piece<DuplicateView[]>;
    backlog: Piece<BacklogView[]>;
    conflicts: Piece<AccountingConflictView[]>;
  };
  team: TeamMember[];
  today: string;
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  if (pantalla === 'ficha') {
    return (
      <div className="cortex-workspace min-h-screen bg-canvas">
        <Client360
          view={ficha}
          team={team}
          today={today}
          handlers={{
            addNote: () => fake('Nota guardada.'),
            createCommitment: () => fake('Compromiso creado.'),
            setTags: () => fake('Etiquetas guardadas.'),
            setOwner: () => fake('Responsable cambiado.'),
            addAlias: () => fake('Nombre guardado.'),
            splitAlias: () => fake('Separado.'),
          }}
        />
      </div>
    );
  }

  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
        <PageHeader
          title="Clientes"
          subtitle="Cada empresa con la que trabajas y todo lo de ella: facturas, pagos, correos, reuniones, compromisos y trabajo del equipo."
          icon={<Building2 className="h-5 w-5" aria-hidden />}
        />
        <nav className="mb-5 flex gap-1 border-b border-border" aria-label="Secciones de clientes">
          {[
            { id: 'lista', label: 'Clientes', href: '?', count: list.rows.length },
            {
              id: 'confirmar',
              label: 'Por confirmar',
              href: '?pantalla=confirmar',
              count: list.pending,
            },
          ].map((t) => (
            <a
              key={t.id}
              href={t.href}
              aria-current={pantalla === t.id ? 'page' : undefined}
              className={clsx(
                '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold',
                pantalla === t.id
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
            </a>
          ))}
        </nav>
        {pantalla === 'confirmar' ? (
          <ReviewQueue
            {...review}
            handlers={{
              confirm: () => fake('Confirmé. Desde ahora, ese nombre se vincula solo.'),
              reject: () => fake('Descartado.'),
              merge: () => fake('Quedaron unidos.'),
              assignCounterparty: () => fake('Quedaron a su nombre.'),
              claimCounterparty: () => fake('Cliente creado.'),
            }}
          />
        ) : (
          <ClientsList
            {...list}
            reviewHref="?pantalla=confirmar"
            askCortexContext="Estoy mirando la lista de clientes."
            onRunLinking={() => fake('Vinculé 12 cosas por NIT o dominio; dejé 4 por confirmar.')}
            onEdit={async () => {}}
            onBulkEdit={async () => {}}
            onSaveView={async (v) => ({ ...v, id: v.id ?? `v-${Date.now()}`, canManage: true })}
            onDeleteView={async () => {}}
          />
        )}
      </div>
    </div>
  );
}
