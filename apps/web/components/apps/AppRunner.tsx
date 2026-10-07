'use client';

import { LiveViewCanvas } from '@/components/views/LiveViewCanvas';
import type { SubmitTarget } from '@/components/views/ViewCanvas';
import { previewQuery } from '@/lib/apps/preview-query';
import type { ComputedView } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  BadgeCheck,
  BarChart3,
  Calendar,
  Camera,
  ClipboardPlus,
  Home,
  LayoutPanelTop,
  ListChecks,
  type LucideIcon,
  Package,
  Pencil,
  Table2,
  Truck,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { type AppButton, AppButtons, PushToggle } from './AppAutomationBar';
import {
  AppWorker,
  InstallButton,
  KioskIdleGuard,
  KioskMenu,
  OfflineBanner,
  SignOutMenu,
} from './AppSession';

/**
 * EL MARCO DE UNA APLICACIÓN.
 *
 * Barra lateral en escritorio y pestañas fijas abajo en el teléfono (que es
 * donde se usa una app de operación). El contenido es el lienzo de las vistas
 * tal cual: refresco en vivo, cola sin señal, fotos y dictado ya vienen en
 * LiveViewCanvas; aquí no se reimplementa nada de eso. Los íconos que el
 * agente guarda son nombres de lucide de una lista corta; cualquier otra cosa
 * se pinta como emoji.
 */

const ICONS: Record<string, LucideIcon> = {
  ClipboardPlus,
  ListChecks,
  BadgeCheck,
  BarChart3,
  Table2,
  Camera,
  Truck,
  Users,
  Home,
  Calendar,
  Package,
  LayoutPanelTop,
};

function Glyph({ name, className }: { name: string; className?: string }) {
  const Icon = ICONS[name];
  if (Icon) return <Icon className={className} aria-hidden />;
  return (
    <span className={clsx('inline-grid place-items-center leading-none', className)} aria-hidden>
      {name || '▫️'}
    </span>
  );
}

/** Lo que cabe bajo el pulgar: más de cinco pestañas no se leen. */
const MAX_TABS = 5;

export interface AppRunnerProps {
  app: { id: string; slug: string; name: string; icon: string };
  screens: Array<{ slug: string; title: string; icon: string }>;
  current: string;
  role: { key: string; name: string };
  readOnly: boolean;
  canExport: boolean;
  canManage: boolean;
  computed: ComputedView;
  target: SubmitTarget;
  dataUrl: string;
  title: string;
  /**
   * Para la entrada de afuera (/a/<id>, 0209): la base de las direcciones y quién
   * es. Sin esto, la app de un miembro (/apps/<slug>) como siempre.
   */
  basePath?: string;
  session?: {
    appId: string;
    userKey: string;
    external: boolean;
    name: string;
    /** Pantalla de inicio de quien está dentro: se precachea al instalar. */
    homeSlug?: string | null;
    /** Sesión de kiosco (0211): minutos sin uso antes de volver a la lista de nombres. */
    kiosk?: { idleMinutes: number } | null;
    /** El kiosco de la app está encendido: se ofrece «Mi PIN». */
    kioskEnabled?: boolean;
    /** Este rol puede dejar un celular en modo kiosco. */
    canEnrollKiosk?: boolean;
  } | null;
  /** «Ver como… cliente X»: el valor de los atributos con los que se mira (sólo lectura). */
  previewAttributes?: Record<string, string>;
  /** Botones de acción manual de esta pantalla (automatizaciones, 0210). */
  buttons?: AppButton[];
}

export function AppRunner({
  app,
  screens,
  current,
  role,
  readOnly,
  canExport,
  canManage,
  computed,
  target,
  dataUrl,
  title,
  basePath,
  session = null,
  previewAttributes,
  buttons = [],
}: AppRunnerProps) {
  const como = readOnly ? previewQuery(role.key, previewAttributes) : '';
  const base = basePath ?? `/apps/${app.slug}`;
  const hrefFor = (slug: string) => `${base}/${slug}${como}`;
  const editHref = `/apps/${app.slug}/edit`;
  const tabs = screens.slice(0, MAX_TABS);

  return (
    <div className="md:flex md:gap-6">
      <aside className="view-no-print hidden w-56 shrink-0 md:block">
        <div className="sticky top-4 flex flex-col gap-4">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary-soft text-primary-ink">
              <Glyph name={app.icon} className="h-4.5 w-4.5 text-base" />
            </span>
            <span className="min-w-0 text-sm font-semibold text-ink">{app.name}</span>
          </div>
          <nav aria-label={`Pantallas de ${app.name}`} className="flex flex-col gap-0.5">
            {screens.map((s) => (
              <Link
                key={s.slug}
                href={hrefFor(s.slug)}
                aria-current={s.slug === current ? 'page' : undefined}
                className={clsx(
                  'flex items-center gap-2.5 rounded-card px-3 py-2 text-sm font-medium transition-colors',
                  s.slug === current
                    ? 'bg-primary-soft text-primary-ink'
                    : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                )}
              >
                <Glyph name={s.icon} className="h-4 w-4 shrink-0" />
                <span className="truncate">{s.title}</span>
              </Link>
            ))}
          </nav>
          <div className="flex flex-col items-start gap-2">
            <span className="inline-flex h-6 items-center rounded-pill border border-border bg-surface px-2.5 text-micro font-semibold text-ink-muted">
              {role.name}
            </span>
            {session?.external && <span className="text-xs text-ink-muted">{session.name}</span>}
            {session && <InstallButton />}
            {session?.external && (
              <KioskMenu
                appId={session.appId}
                kiosk={Boolean(session.kiosk)}
                canEnroll={Boolean(session.canEnrollKiosk)}
                enabled={Boolean(session.kioskEnabled)}
              />
            )}
            {session?.external && (
              <SignOutMenu appId={session.appId} kiosk={Boolean(session.kiosk)} />
            )}
            {canManage && (
              <Link
                href={editHref}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-faint transition-colors hover:text-ink"
              >
                <Pencil className="h-3.5 w-3.5" aria-hidden /> Editar la app
              </Link>
            )}
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 pb-24 md:pb-0">
        {session?.external && (
          <div className="view-no-print mb-3 flex flex-wrap items-start justify-between gap-3 md:hidden">
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-ink">{session.name}</span>
              <InstallButton />
            </div>
            <div className="flex flex-col items-end gap-2">
              <KioskMenu
                appId={session.appId}
                kiosk={Boolean(session.kiosk)}
                canEnroll={Boolean(session.canEnrollKiosk)}
                enabled={Boolean(session.kioskEnabled)}
              />
              <SignOutMenu appId={session.appId} kiosk={Boolean(session.kiosk)} />
            </div>
          </div>
        )}
        {session?.kiosk && (
          <KioskIdleGuard appId={session.appId} idleMinutes={session.kiosk.idleMinutes} />
        )}
        {session && (
          <AppWorker
            appId={session.appId}
            userKey={session.userKey}
            homeSlug={session.homeSlug ?? null}
          />
        )}
        {session && <OfflineBanner computedAt={computed.computedAt} />}
        {!readOnly && (
          <div className="view-no-print mb-3 flex flex-col items-start gap-2">
            <AppButtons appId={app.id} screen={current} buttons={buttons} />
            <PushToggle appId={app.id} />
          </div>
        )}
        {readOnly && (
          <output className="view-no-print mb-4 flex flex-wrap items-center justify-between gap-2 rounded-card border border-amber/40 bg-amber-soft px-4 py-2.5 text-sm font-medium text-ink">
            <span>Viendo como {role.name}. Nada se guarda.</span>
            <Link href={editHref} className="text-xs font-semibold text-primary hover:underline">
              Volver al editor
            </Link>
          </output>
        )}
        <LiveViewCanvas
          // Una pantalla distinta es otro lienzo: sin estado de la anterior.
          key={`${app.slug}:${current}:${role.key}`}
          initial={computed}
          target={target}
          dataUrl={dataUrl}
          heading={{ title }}
          showBrand={false}
          canExport={canExport}
          readOnly={readOnly}
        />
      </main>

      {tabs.length > 1 && (
        <nav
          aria-label={`Pantallas de ${app.name}`}
          className="view-no-print fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        >
          {tabs.map((s) => (
            <Link
              key={s.slug}
              href={hrefFor(s.slug)}
              aria-current={s.slug === current ? 'page' : undefined}
              className={clsx(
                'flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 py-2 text-micro font-semibold',
                s.slug === current ? 'text-primary' : 'text-ink-faint',
              )}
            >
              <Glyph name={s.icon} className="h-5 w-5 text-lg" />
              <span className="max-w-full truncate">{s.title}</span>
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
