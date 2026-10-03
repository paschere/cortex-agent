import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { buildLauncher } from '@/lib/modules/launcher';
import { companyModules } from '@/lib/modules/server';
import { requireSession } from '@/lib/session';
import { workspaceHref } from '@/lib/workspace-context';
import { ArrowRight, LayoutGrid, Lock, Power } from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Todas las áreas · Cortex' };

/**
 * Todas las áreas de la empresa en una pantalla: lo que está prendido, por
 * área, con acceso directo; y lo apagado, con el camino para prenderlo. El
 * armado es puro (lib/modules/launcher.ts); aquí sólo se lee qué está prendido.
 */
export default async function AreasPage() {
  const user = await requireSession();
  const on = await companyModules(user.organization.id);
  const { areas, off } = buildLauncher(on);
  const href = (path: string) => workspaceHref(user.organization.id, path);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 pb-10">
      <PageHeader
        title="Todas las áreas"
        subtitle="Todo lo que Cortex lleva en tu empresa, por área. Lo apagado se prende en Módulos."
        icon={<LayoutGrid className="h-5 w-5" aria-hidden />}
      />

      {areas.length === 0 ? (
        <Panel className="p-6 text-sm text-ink-muted">
          No hay módulos prendidos.{' '}
          <Link href={href('/settings/modulos')} className="font-semibold text-primary">
            Prende los que necesites
          </Link>
          .
        </Panel>
      ) : (
        areas.map((area) => (
          <section
            key={area.area}
            aria-labelledby={`area-${area.area}`}
            className="flex flex-col gap-3"
          >
            <h2
              id={`area-${area.area}`}
              className="text-base font-extrabold tracking-tight text-ink"
            >
              {area.area}
            </h2>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {area.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={href(link.href)}
                    className="group flex h-full flex-col gap-1.5 rounded-card border border-border bg-surface p-4 shadow-card transition-colors hover:border-primary/40 hover:bg-primary-soft/40"
                  >
                    <span className="flex items-center gap-2 text-sm font-extrabold text-ink">
                      {link.label}
                      {link.beta && (
                        <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-micro font-bold text-amber">
                          Beta
                        </span>
                      )}
                      <ArrowRight
                        className="ml-auto h-4 w-4 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                        aria-hidden
                      />
                    </span>
                    <span className="text-xs leading-relaxed text-ink-muted">
                      {link.description}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <section aria-labelledby="legal-datos" className="flex flex-col gap-3">
        <h2 id="legal-datos" className="text-base font-extrabold tracking-tight text-ink">
          Tus datos y lo legal
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              path: '/settings/privacidad',
              label: 'Privacidad y datos',
              body: 'Descarga los datos de la empresa, borra la cuenta, consultas y reclamos.',
            },
            {
              path: '/tratamiento-de-datos',
              label: 'Política de tratamiento de datos',
              body: 'Cómo Cortex trata los datos personales (Ley 1581).',
            },
            {
              path: '/terminos',
              label: 'Términos y condiciones',
              body: 'Las reglas de uso del servicio.',
            },
          ].map((item) => (
            <li key={item.path}>
              <Link
                href={item.path.startsWith('/settings') ? href(item.path) : item.path}
                className="flex h-full flex-col gap-1.5 rounded-card border border-border bg-surface p-4 shadow-card transition-colors hover:border-primary/40"
              >
                <span className="flex items-center gap-2 text-sm font-extrabold text-ink">
                  <Lock className="h-4 w-4 text-ink-faint" aria-hidden /> {item.label}
                </span>
                <span className="text-xs leading-relaxed text-ink-muted">{item.body}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {off.length > 0 && (
        <Panel className="flex flex-wrap items-center justify-between gap-3 p-5">
          <div className="min-w-0">
            <p className="text-sm font-bold text-ink">
              {off.length === 1 ? 'Hay 1 módulo apagado' : `Hay ${off.length} módulos apagados`}
            </p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {off
                .slice(0, 8)
                .map((m) => m.label)
                .join(' · ')}
              {off.length > 8 ? ' · …' : ''}
            </p>
          </div>
          <Link
            href={href('/settings/modulos')}
            className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-2 text-xs font-bold text-ink hover:bg-surface-2"
          >
            <Power className="h-3.5 w-3.5 text-primary" aria-hidden /> Prender módulos
          </Link>
        </Panel>
      )}
    </div>
  );
}
