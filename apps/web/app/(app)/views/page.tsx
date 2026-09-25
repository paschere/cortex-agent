import { PageHeader } from '@/components/ui/page-header';
import { ViewStudio } from '@/components/views/ViewStudio';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { BLOCK_LABEL, listTrackers, listViews, shareIsOpen } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Globe, LayoutPanelTop, Lock, Pin, Users } from 'lucide-react';
import Link from 'next/link';

/**
 * Vistas: las pantallas que esta empresa se armó hablando.
 *
 * LA FORMA. Arriba la estantería —lo que ya existe, fijadas primero—, abajo el
 * estudio vacío con la caja para describir una nueva. Sin plantillas ni
 * constructor de arrastrar y soltar: la plantilla es la frase, y las
 * sugerencias salen de las tablas que el espacio ya tiene, para que el primer
 * clic produzca algo con datos de verdad y no un ejemplo de mentira.
 */

export const dynamic = 'force-dynamic';

const DOOR = {
  workspace: { icon: Users, label: 'Equipo', tone: 'bg-surface-2 text-ink-muted' },
  link: { icon: Globe, label: 'Enlace', tone: 'bg-sky-soft text-sky' },
  password: { icon: Lock, label: 'Contraseña', tone: 'bg-amber-soft text-amber' },
} as const;

export default async function ViewsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [views, trackers] = await Promise.all([listViews(db, 60), listTrackers(db, 6)]);

  const suggestions = trackers.length
    ? trackers
        .slice(0, 3)
        .map(
          (t) =>
            `Tablero de ${t.name.toLowerCase()} con las cifras clave, un gráfico y la lista completa`,
        )
        .concat('Un formulario público para que los clientes nos dejen solicitudes')
    : [
        'Seguimiento de solicitudes de clientes por estado, con un formulario para registrarlas',
        'Tablero de ventas del mes: total, por vendedor y la lista de negocios',
        'Control de facturas de proveedores con las que vencen esta semana',
      ];

  return (
    <>
      <PageHeader
        title="Vistas"
        subtitle="Pantallas a la medida sobre las tablas de tu empresa: tableros, portales y formularios. Se piden y se cambian escribiendo, se fijan en Inicio o se comparten por enlace, con contraseña si hace falta."
        icon={<LayoutPanelTop className="h-5 w-5" />}
      />

      {views.length > 0 && (
        <section className="mb-8">
          <h2 className="field-label mb-3">Tus vistas</h2>
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {views.map((v) => {
              const door = DOOR[v.visibility];
              const expired = v.visibility !== 'workspace' && !shareIsOpen(v);
              const kinds = [...new Set(v.spec.blocks.map((b) => BLOCK_LABEL[b.type]))];
              return (
                <li key={v.id}>
                  <Link
                    href={`/views/${v.slug}`}
                    className="group flex h-full flex-col rounded-card border border-border bg-surface p-4 shadow-card transition-all duration-150 hover:-translate-y-px hover:border-border-strong hover:shadow-pop"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-base font-semibold text-ink group-hover:text-primary">
                        {v.name}
                      </span>
                      {v.pinned && (
                        <Pin
                          className="mt-1 h-3.5 w-3.5 shrink-0 text-primary"
                          aria-label="Fijada en Inicio"
                        />
                      )}
                    </div>
                    {v.description && (
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-muted">
                        {v.description}
                      </p>
                    )}
                    <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
                      <span
                        className={clsx(
                          'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-micro font-semibold',
                          door.tone,
                        )}
                      >
                        <door.icon className="h-3 w-3" />
                        {expired ? 'Enlace vencido' : door.label}
                      </span>
                      <span className="text-micro text-ink-faint">{kinds.join(' · ')}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section>
        <h2 className="field-label mb-3">Nueva vista</h2>
        <ViewStudio suggestions={suggestions} />
      </section>
    </>
  );
}
