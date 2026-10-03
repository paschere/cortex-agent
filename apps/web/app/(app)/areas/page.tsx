import { PageHeader } from '@/components/ui/page-header';
import { buildLauncher } from '@/lib/modules/launcher';
import { companyModules } from '@/lib/modules/server';
import { requireSession } from '@/lib/session';
import { workspaceHref } from '@/lib/workspace-context';
import { clsx } from 'clsx';
import {
  ArrowRight,
  BadgeDollarSign,
  Bot,
  CalendarCheck,
  CalendarClock,
  Compass,
  FileBarChart,
  FileSignature,
  FileText,
  FolderKanban,
  HandCoins,
  Handshake,
  Landmark,
  LayoutGrid,
  Lock,
  type LucideIcon,
  MessageCircle,
  Package,
  Power,
  Receipt,
  Rocket,
  Scale,
  ScrollText,
  ShieldCheck,
  Target,
  Truck,
  UserSearch,
  UsersRound,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Todas las áreas · Cortex' };

/**
 * Todas las áreas de la empresa en una pantalla: lo que está prendido, por
 * área, con acceso directo; y lo apagado, con el camino para prenderlo. El
 * armado es puro (lib/modules/launcher.ts); aquí sólo se lee qué está prendido.
 *
 * Cada área tiene su color y su ícono, y cada pantalla el suyo (el mismo del
 * menú lateral), para que la página se lea de un vistazo.
 */

const AREA_STYLE: Record<string, { tile: string; ring: string; icon: LucideIcon; hint: string }> = {
  Plata: {
    tile: 'bg-emerald-soft text-emerald',
    ring: 'hover:border-emerald/40',
    icon: BadgeDollarSign,
    hint: 'Lo que entra, lo que sale y lo que se debe.',
  },
  Operación: {
    tile: 'bg-amber-soft text-amber',
    ring: 'hover:border-amber/40',
    icon: Truck,
    hint: 'Lo que se mueve todos los días.',
  },
  Personas: {
    tile: 'bg-sky-soft text-sky',
    ring: 'hover:border-sky/40',
    icon: UsersRound,
    hint: 'El equipo, su semana y lo que se le paga.',
  },
  Legal: {
    tile: 'bg-rose-soft text-rose',
    ring: 'hover:border-rose/40',
    icon: Scale,
    hint: 'Contratos, obligaciones y lo que vence.',
  },
  Crecimiento: {
    tile: 'bg-primary-soft text-primary',
    ring: 'hover:border-primary/40',
    icon: Rocket,
    hint: 'Clientes nuevos y ventas por cerrar.',
  },
  Dirección: {
    tile: 'bg-primary-soft text-primary',
    ring: 'hover:border-primary/40',
    icon: Compass,
    hint: 'El rumbo: metas, presupuesto y lo que decide solo.',
  },
  Canales: {
    tile: 'bg-emerald-soft text-emerald',
    ring: 'hover:border-emerald/40',
    icon: MessageCircle,
    hint: 'Por dónde te escriben los clientes.',
  },
};

const FALLBACK_STYLE = {
  tile: 'bg-surface-2 text-ink-muted',
  ring: 'hover:border-primary/40',
  icon: LayoutGrid,
  hint: '',
};

const ROUTE_ICON: Record<string, LucideIcon> = {
  '/finance': Wallet,
  '/pagar': HandCoins,
  '/ventas': Receipt,
  '/inventario': Package,
  '/impuestos': Landmark,
  '/cierre': CalendarCheck,
  '/estados': FileBarChart,
  '/presupuesto': Target,
  '/nomina': Wallet,
  '/sst': ShieldCheck,
  '/contratos': FileSignature,
  '/cumplimiento': Scale,
  '/comercial': Handshake,
  '/proyectos': FolderKanban,
  '/flota': Truck,
  '/documentos-vencen': CalendarClock,
  '/team': UsersRound,
  '/piloto': Bot,
  '/integrations/whatsapp/atencion': MessageCircle,
  '/informe-socios': ScrollText,
  '/prospects': UserSearch,
};

const LEGAL_LINKS = [
  {
    path: '/settings/privacidad',
    label: 'Privacidad y datos',
    body: 'Descarga los datos de la empresa, borra la cuenta, consultas y reclamos.',
    icon: ShieldCheck,
  },
  {
    path: '/tratamiento-de-datos',
    label: 'Política de tratamiento de datos',
    body: 'Cómo Cortex trata los datos personales (Ley 1581).',
    icon: Lock,
  },
  {
    path: '/terminos',
    label: 'Términos y condiciones',
    body: 'Las reglas de uso del servicio.',
    icon: FileText,
  },
];

export default async function AreasPage() {
  const user = await requireSession();
  const on = await companyModules(user.organization.id);
  const { areas, off } = buildLauncher(on);
  const href = (path: string) => workspaceHref(user.organization.id, path);
  const screens = areas.reduce((n, a) => n + a.links.length, 0);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 pb-10">
      <PageHeader
        title="Todas las áreas"
        subtitle="Todo lo que Cortex lleva en tu empresa, por área. Lo apagado se prende en Módulos."
        icon={<LayoutGrid className="h-5 w-5" aria-hidden />}
      />

      <dl className="grid grid-cols-3 gap-3">
        {[
          { label: 'Áreas activas', value: areas.length },
          { label: 'Pantallas', value: screens },
          { label: 'Módulos apagados', value: off.length },
        ].map((s) => (
          <div
            key={s.label}
            className="rounded-card border border-border bg-surface p-4 shadow-card"
          >
            <dt className="text-micro font-bold uppercase tracking-wider text-ink-faint">
              {s.label}
            </dt>
            <dd className="tabular mt-1 text-2xl font-extrabold text-ink">{s.value}</dd>
          </div>
        ))}
      </dl>

      {areas.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-card border-2 border-dashed border-border-strong bg-surface px-6 py-10 text-center">
          <span className="grid h-12 w-12 place-items-center rounded-card bg-primary-soft text-primary">
            <Power className="h-6 w-6" aria-hidden />
          </span>
          <p className="text-base font-extrabold text-ink">No hay módulos prendidos.</p>
          <Link
            href={href('/settings/modulos')}
            className="cortex-primary-button inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2.5 text-sm font-bold text-white hover:bg-primary-strong"
          >
            Prende los que necesites <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      ) : (
        areas.map((area) => {
          const style = AREA_STYLE[area.area] ?? FALLBACK_STYLE;
          const AreaIcon = style.icon;
          return (
            <section
              key={area.area}
              aria-labelledby={`area-${area.area}`}
              className="flex flex-col gap-3"
            >
              <header className="flex items-center gap-3">
                <span
                  className={clsx(
                    'grid h-9 w-9 shrink-0 place-items-center rounded-card',
                    style.tile,
                  )}
                >
                  <AreaIcon className="h-5 w-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <h2
                    id={`area-${area.area}`}
                    className="flex items-center gap-2 text-base font-extrabold tracking-tight text-ink"
                  >
                    {area.area}
                    <span className="tabular rounded-pill bg-surface-2 px-2 py-0.5 text-micro font-bold text-ink-faint">
                      {area.links.length}
                    </span>
                  </h2>
                  {style.hint && <p className="text-xs text-ink-muted">{style.hint}</p>}
                </div>
              </header>
              <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {area.links.map((link) => {
                  const Icon = ROUTE_ICON[link.href] ?? AreaIcon;
                  return (
                    <li key={link.href}>
                      <Link
                        href={href(link.href)}
                        className={clsx(
                          'group flex h-full items-start gap-3 rounded-card border border-border bg-surface p-4 shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:shadow-pop motion-reduce:transform-none',
                          style.ring,
                        )}
                      >
                        <span
                          className={clsx(
                            'grid h-10 w-10 shrink-0 place-items-center rounded-card',
                            style.tile,
                          )}
                        >
                          <Icon className="h-5 w-5" aria-hidden />
                        </span>
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="flex items-center gap-2 text-sm font-extrabold text-ink">
                            <span className="truncate">{link.label}</span>
                            {link.beta && (
                              <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-micro font-bold text-amber">
                                Beta
                              </span>
                            )}
                            <ArrowRight
                              className="ml-auto h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5 group-hover:text-primary motion-reduce:transform-none"
                              aria-hidden
                            />
                          </span>
                          <span className="line-clamp-2 text-xs leading-relaxed text-ink-muted">
                            {link.description}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}

      {off.length > 0 && (
        <section
          aria-labelledby="apagados"
          className="flex flex-col gap-3 rounded-card border border-dashed border-border-strong bg-surface-2/50 p-5"
        >
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 id="apagados" className="text-base font-extrabold tracking-tight text-ink">
                {off.length === 1 ? '1 módulo apagado' : `${off.length} módulos apagados`}
              </h2>
              <p className="text-xs text-ink-muted">
                Prende sólo lo que tu empresa usa; se puede apagar cuando quieras.
              </p>
            </div>
            <Link
              href={href('/settings/modulos')}
              className="inline-flex items-center gap-1.5 rounded-pill bg-ink px-4 py-2 text-xs font-bold text-surface hover:opacity-90"
            >
              <Power className="h-3.5 w-3.5" aria-hidden /> Prender módulos
            </Link>
          </header>
          <ul className="flex flex-wrap gap-2">
            {off.map((m) => {
              const Icon = (AREA_STYLE[m.area] ?? FALLBACK_STYLE).icon;
              return (
                <li key={m.key}>
                  <Link
                    href={href('/settings/modulos')}
                    className="inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:border-primary/40 hover:text-ink"
                  >
                    <Icon className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
                    {m.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <section aria-labelledby="legal-datos" className="flex flex-col gap-3">
        <h2 id="legal-datos" className="text-base font-extrabold tracking-tight text-ink">
          Tus datos y lo legal
        </h2>
        <ul className="grid gap-3 sm:grid-cols-3">
          {LEGAL_LINKS.map((item) => (
            <li key={item.path}>
              <Link
                href={item.path.startsWith('/settings') ? href(item.path) : item.path}
                className="flex h-full items-start gap-3 rounded-card border border-border bg-surface p-4 transition-colors hover:border-primary/40"
              >
                <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                <span className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm font-bold text-ink">{item.label}</span>
                  <span className="text-xs leading-relaxed text-ink-muted">{item.body}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
