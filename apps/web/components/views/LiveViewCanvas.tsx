'use client';

import {
  type FilterState,
  encodeFilterState,
  stateFromComputed,
  withFilterParam,
} from '@/lib/views/filter-param';
import type { ComputedView } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Bell, BellOff, Radio, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type SubmitTarget, ViewCanvas } from './ViewCanvas';
import { ViewHero } from './blocks/ViewChrome';

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
 * LA CABECERA GRANDE. Con `theme.header: 'hero'` y un `heading`, el lienzo
 * pinta la banda con el título, el subtítulo y la portada; quien lo monta no
 * pinta su propio título.
 */

interface Toast {
  id: number;
  title: string;
  body: string;
}

function beep(ctx: AudioContext) {
  const now = ctx.currentTime;
  for (const [i, freq] of [880, 1318].entries()) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + i * 0.14);
    gain.gain.exponentialRampToValueAtTime(0.18, now + i * 0.14 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.14 + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + i * 0.14);
    osc.stop(now + i * 0.14 + 0.25);
  }
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
}: {
  initial: ComputedView;
  target: SubmitTarget;
  /** De dónde se refresca: /api/views/<id>/data o /api/views/public/data?token=… */
  dataUrl: string;
  /** Título y subtítulo para la cabecera `hero`, si el tema la pide. */
  heading?: { title: string; subtitle?: string | null };
}) {
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
  const [alertsOn, setAlertsOn] = useState(false);
  const seen = useRef(new Map<string, Set<string>>());
  const audio = useRef<AudioContext | null>(null);
  const inFlight = useRef(false);

  const hasAlerts = view.alerts.length > 0;
  const wantsDesktop = view.alerts.some((a) => a.desktop);

  // Lo que ya estaba al abrir no es nuevo.
  useEffect(() => {
    for (const a of initial.alerts) seen.current.set(a.id, new Set(a.rows.map((r) => r.id)));
  }, [initial]);

  // La preferencia de avisos de esta persona, en este navegador.
  useEffect(() => {
    try {
      setAlertsOn(window.localStorage.getItem('cortex:view-alerts') === 'on');
    } catch {
      /* Sin almacenamiento: los avisos arrancan apagados. */
    }
  }, []);

  const announce = useCallback(
    (next: ComputedView) => {
      const fresh: Toast[] = [];
      let sound = false;
      let desktop = false;
      for (const alert of next.alerts) {
        const known = seen.current.get(alert.id);
        const ids = new Set(alert.rows.map((r) => r.id));
        if (known) {
          const added = alert.rows.filter((r) => !known.has(r.id));
          for (const row of added.slice(0, 3)) {
            fresh.push({
              id: Date.now() + Math.random(),
              title: alert.message ?? `Nuevo en ${alert.source}`,
              body: row.label,
            });
            sound ||= alert.sound;
            desktop ||= alert.desktop;
          }
        }
        seen.current.set(alert.id, ids);
      }
      if (!fresh.length) return;
      setToasts((t) => [...fresh, ...t].slice(0, 4));
      if (!alertsOn) return;
      if (sound && audio.current) beep(audio.current);
      if (desktop && typeof Notification !== 'undefined' && Notification.permission === 'granted')
        for (const t of fresh.slice(0, 2))
          new Notification(t.title, { body: t.body, tag: t.title });
    },
    [alertsOn],
  );

  /**
   * `force`: un cambio de filtro o una escritura; va aunque haya un sondeo en
   * vuelo, y el que llegue después de otro más nuevo se descarta.
   */
  const refresh = useCallback(
    async (force = false) => {
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
    [dataUrl, announce],
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

  async function toggleAlerts() {
    const next = !alertsOn;
    setAlertsOn(next);
    try {
      window.localStorage.setItem('cortex:view-alerts', next ? 'on' : 'off');
    } catch {
      /* Preferencia local: si no se guarda, vale por esta visita. */
    }
    if (!next) return;
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctx && !audio.current) audio.current = new Ctx();
    await audio.current?.resume().catch(() => undefined);
    if (audio.current) beep(audio.current);
    if (
      wantsDesktop &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'default'
    )
      await Notification.requestPermission().catch(() => undefined);
  }

  return (
    <div>
      {heading && view.theme?.header === 'hero' && (
        <ViewHero title={heading.title} subtitle={heading.subtitle} theme={view.theme} />
      )}
      {(view.refreshSeconds > 0 || hasAlerts) && (
        <div className="mb-3 flex flex-wrap items-center justify-end gap-2 text-micro text-ink-faint">
          {view.refreshSeconds > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Radio
                className={clsx('h-3.5 w-3.5', failing ? 'text-amber' : 'text-emerald')}
                aria-hidden
              />
              {failing
                ? 'Sin conexión, reintentando'
                : `En vivo · actualizado ${ago(Date.now() - updatedAt)}`}
            </span>
          )}
          {hasAlerts && (
            <button
              type="button"
              onClick={() => void toggleAlerts()}
              className={clsx(
                'inline-flex items-center gap-1 rounded-pill border px-2.5 py-1 font-semibold transition-colors',
                alertsOn
                  ? 'border-primary/40 bg-primary-soft text-primary'
                  : 'border-border bg-surface text-ink-muted hover:text-ink',
              )}
            >
              {alertsOn ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
              {alertsOn ? 'Avisos con sonido' : 'Activar avisos'}
            </button>
          )}
        </div>
      )}

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

      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto flex items-start gap-3 rounded-card border border-primary/30 bg-surface p-3 shadow-pop"
          >
            <Bell className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
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
