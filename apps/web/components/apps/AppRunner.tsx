'use client';

import { BlockFixProvider } from '@/components/views/blocks/BlockFix';
import { LiveViewCanvas } from '@/components/views/LiveViewCanvas';
import type { SubmitTarget } from '@/components/views/ViewCanvas';
import { BrandScope } from '@/components/views/blocks/brand';
import { headerHidden, shortTabLabels, splitTabs } from '@/lib/apps/app-nav';
import { previewQuery } from '@/lib/apps/preview-query';
import { rememberScreen } from '@/lib/apps/screen-store';
import type {
  ComputedHome,
  ComputedPortal,
  ComputedTablero,
  ComputedView,
  LocationStatus,
} from '@cortex/agent-tools';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { Ellipsis, Info, PanelLeftClose, PanelLeftOpen, Pencil, Plus, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { type AppButton, AppButtons, PushToggle } from './AppAutomationBar';
import { AppCaptureLayer } from './AppCaptureLayer';
import { AppNoticesProvider, NoticeBadge, NoticesBell } from './AppNotices';
import { Glyph } from './AppGlyph';
import { AppHome } from './AppHome';
import { AppNavProvider } from './AppNav';
import { AppWorker, InstallButton, KioskIdleGuard, KioskMenu, SignOutMenu } from './AppSession';
import { AppThemeScope, AppThemeToggle } from './AppTheme';
import { AppToastProvider } from './AppToast';
import { LocationMenu, LocationProvider } from './LocationShare';
import { PortalHome } from './PortalHome';
import { PullToRefresh } from './PullToRefresh';
import { TableroView } from './TableroView';
import { ViewAsBanner, type ViewAsInfo } from './ViewAsBanner';
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
  /** Un tablero ya calculado para este rol (pantalla `tab_<id>`, 0225). */
  tablero?: ComputedTablero;
  /** El portal de un cliente ya calculado (pantalla `portal`, 0225). */
  portal?: ComputedPortal;
  title: string;
  /**
   * Para la entrada de afuera (/a/<id>, 0209): la base de las direcciones y quién
   * es. Sin esto, la app de un miembro (/apps/<slug>) como siempre.
   */
  basePath?: string;
  /**
   * El panel de la app al lado del chat: las direcciones quedan dentro de
   * /panel/apps/<id>/vista, sin cabecera propia ni tema propio (lo manda el panel).
   */
  embedBase?: string;
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
  /** «Ver como…»: los roles para cambiar de mirada y con qué datos se mira (prueba o reales). */
  viewAs?: ViewAsInfo;
  /** Botones de acción manual de esta pantalla (automatizaciones, 0210). */
  buttons?: AppButton[];
  look?: AppLook;
  emptyHints?: EmptyHint[];
  /**
   * Ubicación del equipo (0216): el estado de quien está dentro (consentimiento,
   * turno, texto). Null/ausente = no comparte (app apagada o rol sin permiso).
   */
  location?: LocationStatus | null;
  /**
   * Vista previa de un borrador (dentro del chat): las pantallas se cambian aquí
   * mismo, sin navegar, y el contenido lo pinta `screenContent`. Nada de sesión,
   * ubicación ni avisos del teléfono.
   */
  preview?: { onSelect: (slug: string) => void };
  screenContent?: React.ReactNode;
  /**
   * Quién usa la app (miembro de Cortex): su id y nombre, para la captura sin
   * señal (cola, copia de pantallas, marca de agua). Un usuario externo ya
   * viene en `session`.
   */
  viewer?: { key: string; name: string } | null;
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
        className={clsx(
          'shrink-0 rounded-sm bg-white object-contain p-1 shadow-card ring-1 ring-border',
          className,
        )}
      />
    );
  return (
    <span
      className={clsx(
        'grid shrink-0 place-items-center rounded-sm bg-primary-soft text-primary-ink shadow-card ring-1 ring-primary/15',
        className,
      )}
    >
      <Glyph name={app.icon} className="h-5 w-5 text-lg" />
    </span>
  );
}

/** Las iniciales de una persona («Ana Gómez» → «AG»): su cara en el menú. */
function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((w) => /^[\p{L}\p{N}]/u.test(w))
    .slice(0, 2)
    .map((w) => w.charAt(0).toLocaleUpperCase('es-CO'))
    .join('');
  return letters || '·';
}

function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'grid shrink-0 place-items-center rounded-pill bg-primary-soft font-extrabold text-primary-ink ring-1 ring-primary/20',
        className,
      )}
    >
      {initialsOf(name)}
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
  tablero,
  portal,
  title,
  basePath,
  embedBase,
  session = null,
  previewAttributes,
  viewAs,
  buttons = [],
  look,
  emptyHints = [],
  location = null,
  preview,
  screenContent,
  viewer = null,
}: AppRunnerProps) {
  const router = useRouter();
  const como = readOnly && !preview ? previewQuery(role.key, previewAttributes, viewAs?.mode) : '';
  const base = basePath ?? embedBase ?? `/apps/${app.slug}`;
  const hrefFor = (slug: string) => `${base}/${slug}${como}`;
  const editHref = `/apps/${app.slug}/edit`;
  const { tabs, more, moreActive } = splitTabs(screens, current);
  const tabLabels = shortTabLabels(tabs);
  const standalone = Boolean(basePath);
  const computedAt =
    computed?.computedAt ??
    home?.computedAt ??
    tablero?.computedAt ??
    portal?.computedAt ??
    new Date().toISOString();
  const [sheet, setSheet] = useState(false);
  // Pantallas hermanas precargadas en un rato libre: tocar una pestaña se siente inmediato.
  // Sólo con buena conexión y sin «ahorro de datos»; son las primeras de la barra, no todas.
  // biome-ignore lint/correctness/useExhaustiveDependencies: depende del conjunto de pantallas y de la actual.
  useEffect(() => {
    if (preview || readOnly) return;
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
      .connection;
    if (conn?.saveData || /(^|-)2g$/.test(conn?.effectiveType ?? '')) return;
    const run = () => {
      for (const sc of screens.filter((x) => x.slug !== current).slice(0, 4))
        router.prefetch(hrefFor(sc.slug));
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number; cancelIdleCallback?: (id: number) => void };
    if (w.requestIdleCallback) {
      const id = w.requestIdleCallback(run);
      return () => w.cancelIdleCallback?.(id);
    }
    const t = window.setTimeout(run, 1500);
    return () => window.clearTimeout(t);
  }, [current, screens.length, base, como]);
  // Avisos automáticos (0231): sólo con quien usa la app de verdad, no en vista previa ni «Ver como…».
  const noticesOn = !readOnly && !preview && !embedBase;
  // Captura sin señal (cola, copia de pantallas, marca de agua): sólo con quien escribe de verdad.
  const captureWho =
    readOnly || preview
      ? null
      : (viewer ?? (session ? { key: session.userKey, name: session.name } : null));
  const appKey =
    target?.kind === 'custom_app' ? target.appId : session?.external ? app.id : app.slug;

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

  // El menú de pantallas se pliega a una franja de íconos para que la hoja o
  // el tablero ganen ancho; se recuerda por app en este navegador.
  const railKey = `cortex:app-rail:${app.id}`;
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    try {
      setCompact(window.localStorage.getItem(railKey) === '1');
    } catch {}
  }, [railKey]);
  function toggleRail() {
    setCompact((was) => {
      try {
        window.localStorage.setItem(railKey, was ? '0' : '1');
      } catch {}
      return !was;
    });
  }

  async function refresh() {
    // El lienzo se actualiza solo (LiveViewCanvas escucha este evento); el
    // servidor vuelve a calcular lo que no es lienzo (Inicio, tarjetas).
    window.dispatchEvent(new Event('cortex:refresh-view'));
    router.refresh();
  }

  const accountActions = (
    <div className="flex flex-col items-start gap-3">
      {noticesOn && <NoticesBell variant="row" />}
      {!readOnly && !preview && <LocationMenu />}
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
    <LocationProvider appId={app.id} initial={readOnly ? null : location}>
      <AppToastProvider>
        <AppNoticesProvider
          appId={app.id}
          base={base}
          suffix={como}
          current={current}
          enabled={noticesOn}
        >
          <AppNavProvider base={base} suffix={como}>
            {!embedBase && <AppThemeScope />}
            <div
              className="app-frame"
              style={look ? { fontFamily: look.font } : undefined}
              onClickCapture={
                preview
                  ? (e) => {
                      const a = (e.target as HTMLElement).closest('a[href]');
                      const href = a?.getAttribute('href') ?? '';
                      if (!a || !href.startsWith(`${base}/`)) return;
                      e.preventDefault();
                      preview.onSelect(href.slice(base.length + 1).split(/[?#]/)[0] ?? '');
                    }
                  : undefined
              }
            >
              <BrandScope className="md:flex md:gap-5">
                <aside
                  className={clsx(
                    'view-no-print hidden shrink-0 transition-[width] duration-200 md:block',
                    compact ? 'w-14' : 'w-52',
                  )}
                >
                  <div className="sticky top-4 flex flex-col gap-3">
                    <div
                      className={clsx(
                        'app-hero flex items-center rounded-card border border-border shadow-card',
                        compact ? 'justify-center p-1.5' : 'gap-2.5 p-2.5',
                      )}
                      title={compact ? `${app.name} · ${role.name}` : undefined}
                    >
                      <AppMark
                        app={app}
                        iconUrl={look?.iconUrl ?? null}
                        className={compact ? 'h-9 w-9' : 'h-9 w-9'}
                      />
                      {!compact && (
                        <div className="min-w-0 leading-tight">
                          <p className="truncate text-sm font-extrabold tracking-tight text-ink">
                            {app.name}
                          </p>
                          <p className="mt-0.5 truncate text-micro font-semibold text-ink-muted">
                            {role.name}
                            {session?.external ? ` · ${session.name}` : ''}
                          </p>
                        </div>
                      )}
                    </div>
                    <nav
                      aria-label={`Pantallas de ${app.name}`}
                      className="flex flex-col gap-0.5 rounded-card border border-border bg-surface p-1 shadow-card"
                    >
                      {screens.map((s) => {
                        const active = s.slug === current;
                        return (
                          <Link
                            key={s.slug}
                            href={hrefFor(s.slug)}
                            aria-current={active ? 'page' : undefined}
                            aria-label={compact ? s.title : undefined}
                            title={compact ? s.title : undefined}
                            className={clsx(
                              'app-press relative flex min-h-10 items-center rounded-sm text-sm font-semibold',
                              compact ? 'justify-center px-0' : 'gap-2.5 px-2.5',
                              active
                                ? 'bg-primary-soft text-primary-ink'
                                : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
                            )}
                          >
                            {active && (
                              <span
                                aria-hidden
                                className="absolute inset-y-2.5 left-0 w-1 rounded-r-pill bg-primary"
                              />
                            )}
                            <Glyph name={s.icon} className="h-5 w-5 shrink-0" />
                            {!compact && <span className="min-w-0 flex-1 truncate">{s.title}</span>}
                            <NoticeBadge
                              slugs={[s.slug]}
                              className={compact ? 'absolute right-0.5 top-0.5' : undefined}
                            />
                          </Link>
                        );
                      })}
                    </nav>
                    <div
                      className={clsx(
                        'flex flex-col gap-3 px-1',
                        compact ? 'items-center' : 'items-start',
                      )}
                    >
                      {!compact && accountActions}
                      {!compact && standalone && <AppThemeToggle className="w-full" />}
                      {canManage && (
                        <Link
                          href={editHref}
                          title={compact ? 'Editar la app' : undefined}
                          aria-label={compact ? 'Editar la app' : undefined}
                          className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted transition-colors hover:text-ink"
                        >
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                          {!compact && 'Editar la app'}
                        </Link>
                      )}
                      <button
                        type="button"
                        onClick={toggleRail}
                        title={compact ? 'Mostrar el menú' : 'Plegar el menú'}
                        aria-label={compact ? 'Mostrar el menú' : 'Plegar el menú'}
                        aria-expanded={!compact}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted transition-colors hover:text-ink"
                      >
                        {compact ? (
                          <PanelLeftOpen className="h-4 w-4" aria-hidden />
                        ) : (
                          <>
                            <PanelLeftClose className="h-3.5 w-3.5" aria-hidden /> Plegar el menú
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </aside>

                <main className="min-w-0 flex-1 pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-0">
                  {standalone && (
                    <header
                      className="app-header-bar view-no-print sticky top-0 z-30 -mx-4 mb-4 bg-surface/85 pt-[env(safe-area-inset-top)] backdrop-blur-xl sm:-mx-6"
                      style={{ transform: hidden ? 'translateY(-100%)' : 'translateY(0)' }}
                    >
                      <span aria-hidden className="view-brand-stripe block h-[3px]" />
                      <div className="flex min-h-14 items-center gap-3 border-b border-border px-4 sm:px-6">
                        <AppMark app={app} iconUrl={look?.iconUrl ?? null} className="h-9 w-9" />
                        <div className="min-w-0 flex-1 leading-tight">
                          <p className="truncate text-micro font-semibold text-ink-muted">
                            {app.name}
                          </p>
                          <p className="truncate text-base font-extrabold tracking-tight text-ink">
                            {title}
                          </p>
                        </div>
                        {noticesOn && <NoticesBell variant="icon" />}
                        <button
                          type="button"
                          onClick={() => setSheet(true)}
                          aria-label="Abrir el menú de la app"
                          className="app-press -mr-1.5 grid h-11 w-11 place-items-center rounded-pill"
                        >
                          <Avatar name={session?.name || role.name} className="h-9 w-9 text-xs" />
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
                  {readOnly && !preview && viewAs && (
                    <ViewAsBanner
                      roleKey={role.key}
                      roleName={role.name}
                      view={viewAs}
                      basePath={base}
                      current={current}
                      attributes={previewAttributes}
                      editHref={editHref}
                    />
                  )}
                  {readOnly && !preview && !viewAs && (
                    <output className="view-no-print mb-4 flex flex-wrap items-center justify-between gap-2 rounded-card border border-amber/40 bg-amber-soft px-4 py-3 text-sm font-semibold text-ink">
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
                  <AppCaptureLayer
                    appKey={appKey}
                    appName={app.name}
                    external={Boolean(session?.external)}
                    who={captureWho}
                    base={base}
                    current={current}
                    computedAt={computedAt}
                    canExport={canExport}
                  >
                    <div key={`${app.slug}:${current}:${role.key}`} className="app-screen">
                      {!readOnly && !preview && buttons.length > 0 && (
                        <div className="view-no-print mb-3 flex flex-col items-start gap-2">
                          <AppButtons appId={app.id} screen={current} buttons={buttons} />
                        </div>
                      )}
                      {!readOnly && !preview && !home && !tablero && !portal && (
                        <PushToggle appId={app.id} />
                      )}
                      {preview && screenContent ? (
                        screenContent
                      ) : home ? (
                        <AppHome
                          home={home}
                          base={base}
                          como={como}
                          appName={app.name}
                          roleName={role.name}
                        />
                      ) : tablero ? (
                        <TableroView tablero={tablero} />
                      ) : portal ? (
                        <PortalHome portal={portal} />
                      ) : (
                        computed &&
                        target && (
                          <>
                            {emptyHints.length > 0 && (
                              <ul className="view-no-print mb-3 space-y-2">
                                {emptyHints.map((h) => (
                                  <li
                                    key={h.blockId}
                                    className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-dashed border-border-strong bg-surface px-4 py-3"
                                  >
                                    <span className="flex min-w-0 items-center gap-2 text-sm text-ink-muted">
                                      <Info
                                        className="h-4 w-4 shrink-0 text-ink-faint"
                                        aria-hidden
                                      />
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
                                        className="app-press inline-flex min-h-11 items-center gap-1.5 rounded-pill bg-primary-soft px-4 text-xs font-semibold text-primary-ink hover:bg-primary-soft/70"
                                      >
                                        <Plus className="h-3.5 w-3.5" aria-hidden />
                                        {h.screenTitle
                                          ? `Registrar en ${h.screenTitle}`
                                          : 'Registrar'}
                                      </Link>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                            <BlockFixProvider
                              value={{
                                kind: 'app',
                                appName: app.name,
                                appRef: target && 'appId' in target ? target.appId : app.slug,
                                screenTitle: title,
                                screenSlug: current,
                                canFix: readOnly ? false : canManage ? true : undefined,
                              }}
                            >
                              <LiveViewCanvas
                                initial={computed}
                                target={target}
                                dataUrl={dataUrl ?? null}
                                heading={{ title }}
                                showBrand={false}
                                canExport={canExport}
                                readOnly={readOnly && !viewAs?.sampled}
                                onView={
                                  captureWho
                                    ? (view) =>
                                        void rememberScreen(
                                          { appKey, userKey: captureWho.key, screen: current, title },
                                          view,
                                        )
                                    : undefined
                                }
                              />
                            </BlockFixProvider>
                          </>
                        )
                      )}
                    </div>
                  </AppCaptureLayer>
                </main>

                {standalone && <PullToRefresh onRefresh={refresh} />}

                {screens.length > 1 && (
                  <nav
                    aria-label={`Pantallas de ${app.name}`}
                    className="app-tabbar view-no-print fixed inset-x-0 bottom-0 z-40 flex rounded-t-[1.25rem] bg-surface/95 pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-1 backdrop-blur-xl md:hidden"
                  >
                    {tabs.map((s) => {
                      const active = s.slug === current;
                      return (
                        <Link
                          key={s.slug}
                          href={hrefFor(s.slug)}
                          title={s.title}
                          aria-label={s.title}
                          aria-current={active ? 'page' : undefined}
                          className="app-press flex min-h-[3.75rem] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 text-micro font-semibold"
                        >
                          <span
                            className={clsx(
                              'relative grid h-8 w-14 place-items-center rounded-pill transition-colors duration-200 motion-reduce:transition-none',
                              active
                                ? 'app-pill-in bg-primary-soft text-primary-ink'
                                : 'text-ink-faint',
                            )}
                          >
                            <Glyph name={s.icon} className="h-[1.375rem] w-[1.375rem] text-xl" />
                            <NoticeBadge slugs={[s.slug]} className="absolute -right-0.5 -top-1" />
                          </span>
                          <span
                            className={clsx(
                              'max-w-full truncate',
                              active ? 'font-bold text-ink' : 'text-ink-faint',
                            )}
                          >
                            {tabLabels.get(s.slug) ?? s.title}
                          </span>
                        </Link>
                      );
                    })}
                    {more.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setSheet(true)}
                        aria-label="Más pantallas y cuenta"
                        className="app-press flex min-h-[3.75rem] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 text-micro font-semibold"
                      >
                        <span
                          className={clsx(
                            'relative grid h-8 w-14 place-items-center rounded-pill transition-colors duration-200 motion-reduce:transition-none',
                            moreActive
                              ? 'app-pill-in bg-primary-soft text-primary-ink'
                              : 'text-ink-faint',
                          )}
                        >
                          <Ellipsis className="h-[1.375rem] w-[1.375rem]" aria-hidden />
                          <NoticeBadge
                            slugs={more.map((m) => m.slug)}
                            className="absolute -right-0.5 -top-1"
                          />
                        </span>
                        <span className={moreActive ? 'font-bold text-ink' : 'text-ink-faint'}>
                          Más
                        </span>
                      </button>
                    )}
                  </nav>
                )}

                <Dialog.Root open={sheet} onOpenChange={setSheet}>
                  <Dialog.Portal>
                    <BrandScope>
                      <Dialog.Overlay className="app-overlay fixed inset-0 z-50 bg-black/45 backdrop-blur-[2px] md:hidden" />
                      <Dialog.Content
                        aria-describedby={undefined}
                        className="app-sheet fixed inset-x-0 bottom-0 z-50 max-h-[88dvh] overflow-y-auto rounded-t-[1.75rem] bg-surface px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-2 shadow-pop md:hidden"
                      >
                        <div
                          aria-hidden
                          className="mx-auto mb-3 h-1.5 w-10 rounded-pill bg-border-strong"
                        />
                        <div className="mb-4 flex items-center gap-3">
                          <Avatar name={session?.name || role.name} className="h-11 w-11 text-sm" />
                          <div className="min-w-0 flex-1 leading-tight">
                            <Dialog.Title className="truncate text-base font-extrabold tracking-tight text-ink">
                              {session?.external ? session.name : app.name}
                            </Dialog.Title>
                            <p className="mt-0.5 truncate text-xs text-ink-muted">
                              {role.name}
                              {session?.external ? ` · ${app.name}` : ''}
                            </p>
                          </div>
                          <Dialog.Close
                            aria-label="Cerrar"
                            className="app-press -mr-1.5 grid h-11 w-11 place-items-center rounded-pill bg-surface-2 text-ink-muted"
                          >
                            <X className="h-5 w-5" aria-hidden />
                          </Dialog.Close>
                        </div>
                        {more.length > 0 && (
                          <nav aria-label="Más pantallas" className="mb-4 grid grid-cols-2 gap-2">
                            {more.map((s) => {
                              const active = s.slug === current;
                              return (
                                <Link
                                  key={s.slug}
                                  href={hrefFor(s.slug)}
                                  onClick={() => setSheet(false)}
                                  aria-current={active ? 'page' : undefined}
                                  className={clsx(
                                    'app-press flex min-h-14 items-center gap-3 rounded-card border px-3 text-sm font-semibold',
                                    active
                                      ? 'border-primary/40 bg-primary-soft text-primary-ink'
                                      : 'border-border bg-surface text-ink',
                                  )}
                                >
                                  <span
                                    className={clsx(
                                      'grid h-9 w-9 shrink-0 place-items-center rounded-sm',
                                      active
                                        ? 'bg-surface text-primary'
                                        : 'bg-surface-2 text-ink-muted',
                                    )}
                                  >
                                    <Glyph name={s.icon} className="h-5 w-5 text-lg" />
                                  </span>
                                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                                  <NoticeBadge slugs={[s.slug]} />
                                </Link>
                              );
                            })}
                          </nav>
                        )}
                        <div className="space-y-4 rounded-card bg-surface-2/70 p-4">
                          {accountActions}
                          <AppThemeToggle />
                        </div>
                        <div className="mt-3 flex items-center justify-between gap-3 px-1">
                          {canManage ? (
                            <Link
                              href={editHref}
                              className="app-press inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink"
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden /> Editar la app
                            </Link>
                          ) : (
                            <span />
                          )}
                          {standalone && (
                            <p className="text-micro text-ink-faint">Hecho con Cortex</p>
                          )}
                        </div>
                      </Dialog.Content>
                    </BrandScope>
                  </Dialog.Portal>
                </Dialog.Root>
              </BrandScope>
            </div>
          </AppNavProvider>
        </AppNoticesProvider>
      </AppToastProvider>
    </LocationProvider>
  );
}
