'use client';

import { LiveViewCanvas } from '@/components/views/LiveViewCanvas';
import type { SubmitTarget } from '@/components/views/ViewCanvas';
import { BrandScope } from '@/components/views/blocks/brand';
import { headerHidden, splitTabs } from '@/lib/apps/app-nav';
import { previewQuery } from '@/lib/apps/preview-query';
import type { ComputedHome, ComputedView } from '@cortex/agent-tools';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { Ellipsis, Info, Menu, Pencil, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { type AppButton, AppButtons, PushToggle } from './AppAutomationBar';
import { Glyph } from './AppGlyph';
import { AppHome } from './AppHome';
import {
  AppWorker,
  InstallButton,
  KioskIdleGuard,
  KioskMenu,
  OfflineBanner,
  SignOutMenu,
} from './AppSession';
import { AppThemeScope, AppThemeToggle } from './AppTheme';
import { AppToastProvider } from './AppToast';
import { PullToRefresh } from './PullToRefresh';
import './app-runner.css';

/**
 * EL MARCO DE UNA APLICACIÓN.
 *
 * Barra lateral en escritorio; en el teléfono (que es donde se usa una app de
 * operación) se siente como una app de verdad:
 *
 *   - una barra inferior con íconos y la etiqueta de la pantalla activa (hasta
 *     cinco; con más, cuatro y «Más»), de 56 px de alto y con el margen del
 *     iPhone (`env(safe-area-inset-*)`);
 *   - una cabecera compacta con la marca de la app, que se esconde al bajar y
 *     vuelve al subir (sólo en /a/<app>: dentro del espacio de trabajo ya hay
 *     una barra de arriba);
 *   - tirar hacia abajo para actualizar, sin romper el gesto de «atrás»;
 *   - una transición suave entre pantallas (apagada con prefers-reduced-motion);
 *   - «Más»: la cuenta, instalar, cerrar sesión y el tema (claro, oscuro o el
 *     del sistema, a elección de cada persona).
 *
 * El contenido es el lienzo de las vistas tal cual: refresco en vivo, cola sin
 * señal, fotos y dictado ya vienen en LiveViewCanvas; aquí no se reimplementa
 * nada de eso. La pantalla «Inicio» (0215) no es un lienzo: son las tarjetas
 * de `AppHome`. Los íconos de pantalla son nombres de lucide de una lista corta;
 * cualquier otra cosa se pinta como emoji.
 */

/** Cómo se ve la app: lo que el servidor resolvió de su marca (lib/apps/app-brand.ts). */
export interface AppLook {
  font: string;
  /** Ícono cuadrado (o logo) para la cabecera; null = el emoji de la app. */
  iconUrl: string | null;
}

/** Un bloque vacío y a dónde ir a llenarlo («Aún no hay vuelos hoy · Registrar»). */
export interface EmptyHint {
  blockId: string;
  title: string;
  /** Pantalla donde se registra; null = el formulario está en esta misma pantalla. */
  screen: string | null;
  screenTitle: string | null;
}

export interface AppRunnerProps {
  app: { id: string; slug: string; name: string; icon: string };
  screens: Array<{ slug: string; title: string; icon: string }>;
  current: string;
  role: { key: string; name: string };
  readOnly: boolean;
  canExport: boolean;
  canManage: boolean;
  /** Ausente en «Inicio», que se pinta con `home`. */
  computed?: ComputedView;
  target?: SubmitTarget;
  dataUrl?: string;
  /** Las tarjetas ya calculadas para este rol (pantalla «Inicio»). */
  home?: ComputedHome;
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
  look?: AppLook;
  emptyHints?: EmptyHint[];
}

function AppMark({
  app,
  iconUrl,
  className,
}: {
  app: { name: string; icon: string };
  iconUrl: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (iconUrl && !failed)
    return (
      <img
        src={iconUrl}
        alt=""
        decoding="async"
        onError={() => setFailed(true)}
        className={clsx('shrink-0 rounded-card bg-white object-contain p-0.5', className)}
      />
    );
  return (
    <span
      className={clsx(
        'grid shrink-0 place-items-center rounded-card bg-primary-soft text-primary-ink',
        className,
      )}
    >
      <Glyph name={app.icon} className="h-4.5 w-4.5 text-base" />
    </span>
  );
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
  home,
  title,
  basePath,
  session = null,
  previewAttributes,
  buttons = [],
  look,
  emptyHints = [],
}: AppRunnerProps) {
  const router = useRouter();
  const como = readOnly ? previewQuery(role.key, previewAttributes) : '';
  const base = basePath ?? `/apps/${app.slug}`;
  const hrefFor = (slug: string) => `${base}/${slug}${como}`;
  const editHref = `/apps/${app.slug}/edit`;
  const { tabs, more, moreActive } = splitTabs(screens, current);
  const standalone = Boolean(basePath);
  const computedAt = computed?.computedAt ?? home?.computedAt ?? new Date().toISOString();
  const [sheet, setSheet] = useState(false);

  // La cabecera compacta se esconde al bajar y vuelve al subir.
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);
  useEffect(() => {
    if (!standalone) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const y = Math.max(0, window.scrollY);
        setHidden((was) => headerHidden(lastY.current, y, was));
        lastY.current = y;
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [standalone]);

  async function refresh() {
    // El lienzo se actualiza solo (LiveViewCanvas escucha este evento); el
    // servidor vuelve a calcular lo que no es lienzo (Inicio, tarjetas).
    window.dispatchEvent(new Event('cortex:refresh-view'));
    router.refresh();
  }

  const accountActions = (
    <div className="flex flex-col items-start gap-3">
      {session && <InstallButton />}
      {session?.external && (
        <KioskMenu
          appId={session.appId}
          kiosk={Boolean(session.kiosk)}
          canEnroll={Boolean(session.canEnrollKiosk)}
          enabled={Boolean(session.kioskEnabled)}
        />
      )}
      {session?.external && <SignOutMenu appId={session.appId} kiosk={Boolean(session.kiosk)} />}
    </div>
  );

  return (
    <AppToastProvider>
      <AppThemeScope />
      <div style={look ? { fontFamily: look.font } : undefined}>
        <BrandScope className="md:flex md:gap-6">
          <aside className="view-no-print hidden w-56 shrink-0 md:block">
            <div className="sticky top-4 flex flex-col gap-4">
              <div className="flex items-center gap-2.5">
                <AppMark app={app} iconUrl={look?.iconUrl ?? null} className="h-9 w-9" />
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
                {session?.external && (
                  <span className="text-xs text-ink-muted">{session.name}</span>
                )}
                {accountActions}
                {standalone && <AppThemeToggle />}
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

          <main className="min-w-0 flex-1 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0">
            {standalone && (
              <header
                className="app-header-bar view-no-print sticky top-0 z-30 -mx-4 mb-3 border-b border-border bg-surface/90 pt-[env(safe-area-inset-top)] backdrop-blur sm:-mx-6"
                style={{ transform: hidden ? 'translateY(-100%)' : 'translateY(0)' }}
              >
                <div className="flex min-h-12 items-center gap-2.5 px-4 sm:px-6">
                  <AppMark app={app} iconUrl={look?.iconUrl ?? null} className="h-8 w-8" />
                  <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink">
                    {title}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSheet(true)}
                    aria-label="Abrir el menú de la app"
                    className="-mr-2 grid h-11 w-11 place-items-center rounded-pill text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
                  >
                    <Menu className="h-5 w-5" aria-hidden />
                  </button>
                </div>
              </header>
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
            {session && <OfflineBanner computedAt={computedAt} />}
            {readOnly && (
              <output className="view-no-print mb-4 flex flex-wrap items-center justify-between gap-2 rounded-card border border-amber/40 bg-amber-soft px-4 py-2.5 text-sm font-medium text-ink">
                <span>Viendo como {role.name}. Nada se guarda.</span>
                <Link
                  href={editHref}
                  className="text-xs font-semibold text-primary hover:underline"
                >
                  Volver al editor
                </Link>
              </output>
            )}
            {/* Una pantalla distinta es otro lienzo: sin estado de la anterior, y entra suave. */}
            <div key={`${app.slug}:${current}:${role.key}`} className="app-screen">
              {!readOnly && buttons.length > 0 && (
                <div className="view-no-print mb-3 flex flex-col items-start gap-2">
                  <AppButtons appId={app.id} screen={current} buttons={buttons} />
                </div>
              )}
              {!readOnly && !home && <PushToggle appId={app.id} />}
              {home ? (
                <AppHome home={home} base={base} como={como} appName={app.name} />
              ) : (
                computed &&
                target && (
                  <>
                    {emptyHints.length > 0 && (
                      <ul className="view-no-print mb-3 space-y-2">
                        {emptyHints.map((h) => (
                          <li
                            key={h.blockId}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-dashed border-border-strong bg-surface px-4 py-2.5"
                          >
                            <span className="flex min-w-0 items-center gap-2 text-sm text-ink-muted">
                              <Info className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
                              <span>
                                Aún no hay registros en{' '}
                                <span className="font-semibold text-ink">{h.title}</span>.
                                {!h.screen &&
                                  !readOnly &&
                                  ' Registra el primero con el formulario.'}
                              </span>
                            </span>
                            {h.screen && !readOnly && (
                              <Link
                                href={hrefFor(h.screen)}
                                className="inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-primary-soft px-4 text-xs font-semibold text-primary-ink transition-colors hover:bg-primary-soft/70"
                              >
                                <Plus className="h-3.5 w-3.5" aria-hidden />
                                {h.screenTitle ? `Registrar en ${h.screenTitle}` : 'Registrar'}
                              </Link>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    <LiveViewCanvas
                      initial={computed}
                      target={target}
                      dataUrl={dataUrl ?? null}
                      heading={{ title }}
                      showBrand={false}
                      canExport={canExport}
                      readOnly={readOnly}
                    />
                  </>
                )
              )}
            </div>
          </main>

          {standalone && <PullToRefresh onRefresh={refresh} />}

          {screens.length > 1 && (
            <nav
              aria-label={`Pantallas de ${app.name}`}
              className="view-no-print fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] backdrop-blur md:hidden"
            >
              {tabs.map((s) => {
                const active = s.slug === current;
                return (
                  <Link
                    key={s.slug}
                    href={hrefFor(s.slug)}
                    aria-current={active ? 'page' : undefined}
                    aria-label={s.title}
                    className={clsx(
                      'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-micro font-semibold transition-colors',
                      active ? 'text-primary' : 'text-ink-faint',
                    )}
                  >
                    <Glyph name={s.icon} className="h-5 w-5 text-lg" />
                    {active && <span className="max-w-full truncate">{s.title}</span>}
                  </Link>
                );
              })}
              {more.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSheet(true)}
                  aria-label="Más pantallas y cuenta"
                  className={clsx(
                    'flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-micro font-semibold transition-colors',
                    moreActive ? 'text-primary' : 'text-ink-faint',
                  )}
                >
                  <Ellipsis className="h-5 w-5" aria-hidden />
                  {moreActive && <span>Más</span>}
                </button>
              )}
            </nav>
          )}

          <Dialog.Root open={sheet} onOpenChange={setSheet}>
            <Dialog.Portal>
              <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 md:hidden" />
              <Dialog.Content
                aria-describedby={undefined}
                className="app-sheet fixed inset-x-0 bottom-0 z-50 max-h-[85dvh] overflow-y-auto rounded-t-card border-t border-border bg-surface p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-pop md:hidden"
              >
                <div className="mb-3 flex items-center justify-between gap-2">
                  <Dialog.Title className="text-sm font-bold text-ink">{app.name}</Dialog.Title>
                  <Dialog.Close
                    aria-label="Cerrar"
                    className="-mr-2 grid h-11 w-11 place-items-center rounded-pill text-ink-faint hover:text-ink"
                  >
                    <X className="h-5 w-5" aria-hidden />
                  </Dialog.Close>
                </div>
                {more.length > 0 && (
                  <nav aria-label="Más pantallas" className="mb-3 flex flex-col gap-0.5">
                    {more.map((s) => (
                      <Link
                        key={s.slug}
                        href={hrefFor(s.slug)}
                        onClick={() => setSheet(false)}
                        aria-current={s.slug === current ? 'page' : undefined}
                        className={clsx(
                          'flex min-h-12 items-center gap-3 rounded-card px-3 text-sm font-medium',
                          s.slug === current
                            ? 'bg-primary-soft text-primary-ink'
                            : 'text-ink hover:bg-surface-2',
                        )}
                      >
                        <Glyph name={s.icon} className="h-5 w-5 shrink-0" />
                        <span className="truncate">{s.title}</span>
                      </Link>
                    ))}
                  </nav>
                )}
                <div className="space-y-3 border-t border-border pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex h-6 items-center rounded-pill border border-border bg-surface px-2.5 text-micro font-semibold text-ink-muted">
                      {role.name}
                    </span>
                    {session?.external && (
                      <span className="text-xs text-ink-muted">{session.name}</span>
                    )}
                  </div>
                  {accountActions}
                  <AppThemeToggle />
                  {canManage && (
                    <Link
                      href={editHref}
                      className="inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-ink-faint hover:text-ink"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden /> Editar la app
                    </Link>
                  )}
                  {standalone && <p className="text-micro text-ink-faint">Hecho con Cortex</p>}
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </BrandScope>
      </div>
    </AppToastProvider>
  );
}
