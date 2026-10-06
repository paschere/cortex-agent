'use client';

import { LIVE_FLASH_MS, beep, desktopNotify, unlockAudio } from '@/lib/live-signal';
import {
  WATCH_MODES,
  type WatchMode,
  blockFingerprints,
  detectAlertHits,
  flashKeys,
  parseWatchMode,
} from '@/lib/views/live-diff';

import {
  type FilterState,
  encodeFilterState,
  stateFromComputed,
  withFilterParam,
} from '@/lib/views/filter-param';
import type { ComputedView } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Bell, BellOff, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExportMenu } from './ExportMenu';
import { type SubmitTarget, ViewCanvas } from './ViewCanvas';
import { LiveStatus, ViewCover } from './blocks/ViewChrome';
import { useBrandScope, useViewBrand } from './blocks/brand';
import { FlashProvider } from './flash-context';

/**
 * UNA VISTA QUE SE MANTIENE AL DÍA SOLA, Y QUE AVISA.
 *
 * Refresca cada `refreshSeconds` (lo pone el spec: 10, 30, 60 o nunca) mientras
 * la pestaña está visible — una pestaña escondida no gasta consultas — y
 * después de cada edición o botón. Es sondeo y no un canal en vivo, a
 * propósito: el mismo cálculo que la página, sin infraestructura nueva, y 30
 * segundos es «en vivo» para una cartera o un tablero de remates.
 *
 * LAS ALERTAS. Cada refresco trae, por alerta, las filas más recientes que
 * cumplen sus filtros. Lo que aparece y no estaba en el refresco anterior es
 * nuevo: suena (un tono corto hecho con WebAudio, sin archivos), aparece un
 * aviso en pantalla y, si la persona lo permitió, una notificación del
 * sistema. Los navegadores no dejan sonar nada hasta que alguien toca la
 * página, así que el primer clic en «Activar avisos» es también el que
 * desbloquea el audio.
 *
 * FILTROS Y PÁGINAS EN LA DIRECCIÓN. Lo elegido en la barra de filtros viaja
 * como `?f=` (ver lib/views/filter-param.ts) y la pestaña como `?p=`: copiar
 * la dirección comparte la vista tal como se está mirando. Cambiar un filtro
 * pide la vista recalculada en el servidor con ese `f` (los refrescos en vivo
 * también lo llevan), y una respuesta vieja que llega tarde se descarta: la
 * pantalla siempre muestra el ÚLTIMO filtro elegido. Si la página llegó sin
 * filtrar y la dirección trae `f` (la página de adentro no lo lee), se pide
 * filtrada al abrir.
 *
 * LA PORTADA. Con un `heading`, el lienzo pinta la cabecera de la vista
 * (ViewCover): el logo y el nombre de la empresa, el título, el subtítulo, el
 * «en vivo · hace 12 s», los avisos, «Imprimir» y lo que quien la monta ponga
 * en `actions` (compartir, versiones, editar). Con `theme.header: 'hero'` es
 * la banda grande con la portada. Quien monta el lienzo no pinta su propio
 * título.
 */

const PRINTED_AT = new Intl.DateTimeFormat('es-CO', {
  dateStyle: 'long',
  timeStyle: 'short',
  timeZone: 'America/Bogota',
});

interface Toast {
  id: number;
  title: string;
  body: string;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${s} s`;
  return `hace ${Math.round(s / 60)} min`;
}

export function LiveViewCanvas({
  initial,
  target,
  dataUrl,
  heading,
  actions,
  showBrand = true,
}: {
  initial: ComputedView;
  target: SubmitTarget;
  /**
   * De dónde se refresca: /api/views/<id>/data o /api/views/public/data?token=….
   * Null: no se refresca (el escaparate de desarrollo).
   */
  dataUrl: string | null;
  /** Título y subtítulo de la portada. Sin esto, quien monta pinta su cabecera. */
  heading?: { title: string; subtitle?: string | null };
  /** Controles de quien administra, a la derecha de la portada. */
  actions?: React.ReactNode;
  /** El logo en la portada; el enlace público lo lleva en su barra de arriba. */
  showBrand?: boolean;
}) {
  const brand = useViewBrand();
  const scope = useBrandScope();
  const [view, setView] = useState(initial);
  const [filters, setFilters] = useState<FilterState>(() => stateFromComputed(initial.filtersBar));
  const [filtering, setFiltering] = useState(false);
  const [page, setPage] = useState<string | null>(null);
  const filterParam = useRef(encodeFilterState(stateFromComputed(initial.filtersBar)));
  const seq = useRef(0);
  const [updatedAt, setUpdatedAt] = useState(() => Date.now());
  const [, tick] = useState(0);
  const [failing, setFailing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [mode, setMode] = useState<WatchMode | null>(null);
  const [flashing, setFlashing] = useState<ReadonlySet<string>>(new Set());
  const seen = useRef(new Map<string, Map<string, string>>());
  const prints = useRef<Map<string, string> | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const inFlight = useRef(false);

  const hasAlerts = view.alerts.length > 0;
  const wantsDesktop = view.alerts.some((a) => a.desktop);
  // Mientras no se lee la preferencia, la de por defecto.
  const watch: WatchMode = mode ?? (hasAlerts ? 'toast' : 'flash');

  // Lo que ya estaba al abrir no es nuevo.
  useEffect(() => {
    for (const a of initial.alerts)
      seen.current.set(a.id, new Map(a.rows.map((r) => [r.id, r.rev])));
    prints.current = blockFingerprints(initial.blocks);
  }, [initial]);

  // La preferencia de avisos de esta persona, en este navegador.
  useEffect(() => {
    try {
      setMode(parseWatchMode(window.localStorage.getItem('cortex:view-alerts'), hasAlerts));
    } catch {
      /* Sin almacenamiento: vale el modo por defecto. */
    }
  }, [hasAlerts]);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  // Lo que llegó o cambió titila unos segundos, haya o no alertas.
  const flashChanges = useCallback(
    (next: ComputedView) => {
      const now = blockFingerprints(next.blocks);
      const keys = flashKeys(prints.current, now);
      prints.current = now;
      if (!keys.size || watch === 'off') return;
      setFlashing(keys);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlashing(new Set()), LIVE_FLASH_MS);
    },
    [watch],
  );

  const announce = useCallback(
    (next: ComputedView) => {
      const fresh: Toast[] = [];
      let sound = false;
      let desktop = false;
      for (const alert of next.alerts) {
        const known = seen.current.get(alert.id);
        const hits = detectAlertHits(known, alert.rows, alert.on ?? 'new');
        for (const hit of hits.slice(0, 3)) {
          fresh.push({
            id: Date.now() + Math.random(),
            title:
              hit.kind === 'change'
                ? `Cambió: ${hit.row.label}`
                : (alert.message ?? `Nuevo en ${alert.source}`),
            body: hit.kind === 'change' ? alert.source : hit.row.label,
          });
          sound ||= alert.sound;
          desktop ||= alert.desktop;
        }
        seen.current.set(alert.id, new Map(alert.rows.map((r) => [r.id, r.rev])));
      }
      if (!fresh.length || watch === 'off' || watch === 'flash') return;
      setToasts((t) => [...fresh, ...t].slice(0, 4));
      if (sound && watch === 'sound') beep(unlockAudio());
      if (desktop) for (const t of fresh.slice(0, 2)) desktopNotify(t.title, t.body);
    },
    [watch],
  );

  /**
   * `force`: un cambio de filtro o una escritura; va aunque haya un sondeo en
   * vuelo, y el que llegue después de otro más nuevo se descarta.
   */
  const refresh = useCallback(
    async (force = false) => {
      if (!dataUrl) {
        setFiltering(false);
        return;
      }
      if (inFlight.current && !force) return;
      inFlight.current = true;
      const mine = ++seq.current;
      try {
        const url = withFilterParam(dataUrl, filterParam.current, window.location.origin);
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { view: ComputedView };
        if (mine !== seq.current) return;
        setView(body.view);
        setUpdatedAt(Date.now());
        setFailing(false);
        flashChanges(body.view);
        announce(body.view);
      } catch {
        if (mine === seq.current) setFailing(true);
      } finally {
        if (mine === seq.current) {
          inFlight.current = false;
          setFiltering(false);
        }
      }
    },
    [dataUrl, announce, flashChanges],
  );

  /** Escribe `?f=` / `?p=` sin recargar ni agregar pasos al historial. */
  const writeUrl = useCallback((key: 'f' | 'p', value: string | null) => {
    try {
      const url = new URL(window.location.href);
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
      window.history.replaceState(window.history.state, '', url);
    } catch {
      /* Sin historial (un iframe raro): el filtro vale igual en pantalla. */
    }
  }, []);

  const changeFilters = useCallback(
    (next: FilterState) => {
      setFilters(next);
      const f = encodeFilterState(next);
      if (f === filterParam.current) return;
      filterParam.current = f;
      writeUrl('f', f || null);
      setFiltering(true);
      void refresh(true);
    },
    [refresh, writeUrl],
  );

  // Al abrir: la pestaña y el filtro que traiga la dirección.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo al montar.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const p = params.get('p');
    if (p && initial.pages?.some((x) => x.id === p)) setPage(p);
    const f = params.get('f') ?? '';
    if ((initial.filtersBar?.length ?? 0) > 0 && f !== filterParam.current) {
      filterParam.current = f;
      setFiltering(true);
      void refresh(true);
    }
  }, []);

  // Lo que el servidor validó manda: si descartó parte del filtro, la barra lo refleja.
  useEffect(() => {
    if (!filtering) setFilters(stateFromComputed(view.filtersBar));
  }, [view.filtersBar, filtering]);

  useEffect(() => {
    const every = view.refreshSeconds * 1000;
    if (!every) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, every);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [view.refreshSeconds, refresh]);

  // El «hace 12 s» se mueve solo.
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 5000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!toasts.length) return;
    const id = window.setTimeout(() => setToasts((t) => t.slice(0, -1)), 8000);
    return () => window.clearTimeout(id);
  }, [toasts]);

  async function chooseMode(next: WatchMode) {
    setMode(next);
    try {
      window.localStorage.setItem('cortex:view-alerts', next);
    } catch {
      /* Preferencia local: si no se guarda, vale por esta visita. */
    }
    if (next === 'sound') beep(unlockAudio());
    if (
      (next === 'toast' || next === 'sound') &&
      wantsDesktop &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'default'
    )
      await Notification.requestPermission().catch(() => undefined);
  }

  const status = (
    <>
      {view.refreshSeconds > 0 && (
        <LiveStatus
          failing={failing}
          label={
            failing ? 'Sin conexión, reintentando' : `En vivo · ${ago(Date.now() - updatedAt)}`
          }
        />
      )}
      <label
        className={clsx(
          'inline-flex h-8 items-center gap-1.5 rounded-pill border px-3 text-micro font-semibold transition-colors',
          watch === 'off'
            ? 'border-border bg-surface text-ink-muted shadow-card'
            : 'border-primary/40 bg-primary-soft text-primary-ink',
        )}
      >
        {watch === 'off' ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
        <span>Avisos:</span>
        <select
          aria-label="Avisos de lo nuevo"
          value={watch}
          onChange={(e) => void chooseMode(e.target.value as WatchMode)}
          className="cursor-pointer bg-transparent font-semibold outline-none"
        >
          {WATCH_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <ExportMenu
        dataUrl={dataUrl}
        filterParam={filterParam.current}
        title={heading?.title ?? 'Vista'}
      />
    </>
  );

  return (
    <div className={clsx('view-print-root', scope.className)} style={scope.style}>
      {heading ? (
        <ViewCover
          title={heading.title}
          subtitle={heading.subtitle}
          theme={view.theme}
          brand={brand}
          showBrand={showBrand}
          status={status}
          actions={actions}
          printedAt={PRINTED_AT.format(new Date(view.computedAt))}
        />
      ) : (
        <div className="view-no-print mb-4 flex flex-wrap items-center justify-end gap-2">
          {status}
        </div>
      )}

      <FlashProvider value={flashing}>
        <ViewCanvas
          view={view}
          target={target}
          onChanged={() => void refresh(true)}
          filters={{ state: filters, onChange: changeFilters, pending: filtering }}
          page={{
            current: page,
            onSelect: (id) => {
              setPage(id);
              writeUrl('p', id === view.pages?.[0]?.id ? null : id);
            },
          }}
        />
      </FlashProvider>

      <div
        aria-live="polite"
        className="view-no-print pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-3 rounded-card border border-primary/30 bg-surface p-3.5 shadow-pop"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-pill bg-primary-soft text-primary">
              <Bell className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-ink">{t.title}</p>
              <p className="truncate text-xs text-ink-muted">{t.body}</p>
            </div>
            <button
              type="button"
              aria-label="Cerrar"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              className="text-ink-faint hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
