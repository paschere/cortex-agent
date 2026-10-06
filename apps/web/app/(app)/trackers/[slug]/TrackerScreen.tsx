'use client';

import { DataGrid } from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import { PageHeader } from '@/components/ui/page-header';
import { formatDateTime } from '@/lib/datagrid/format';
import {
  ALERT_MODES,
  type AlertMode,
  type AlertPrefs,
  type ChangesResponse,
  DEFAULT_ALERTS,
  alertsKey,
  markSeen,
  mergeChanges,
  nextSince,
  parseAlerts,
  summarizeChanges,
} from '@/lib/datagrid/tracker-live';
import { LIVE_FLASH_MS, beep, desktopNotify, unlockAudio } from '@/lib/live-signal';
import { DOT_TONE, type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  Bell,
  CopyX,
  ExternalLink,
  FolderSync,
  History,
  LayoutPanelTop,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Ruler,
  ScanSearch,
  Table2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ActionResult,
  HistoryEntry,
  LookupActions,
  SyncBadge,
  TrackerActions,
  TrackerScreenData,
} from '../types';
import { AddLookupDialog, LookupsSection } from './LookupsPanel';

/**
 * UNA TABLA DE LA EMPRESA, ENTERA.
 *
 * Encabezado con lo que la llena sola (y si falló, por qué, con «Sincronizar
 * ahora»), si se mide como trabajo, y la grilla con todas las filas. Todo lo
 * que se escribe pasa por las acciones de `../actions.ts` — el mismo camino
 * que `trackers.upsert` en el chat — y se ve al instante (la grilla deshace si
 * el servidor dice que no).
 */

const pill =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-1.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2';

const STATE: Record<SyncBadge['state'], { tone: StatusTone; label: string }> = {
  ok: { tone: 'emerald', label: 'Funcionando' },
  error: { tone: 'rose', label: 'Falló' },
  paused: { tone: 'neutral', label: 'En pausa' },
  waiting: { tone: 'amber', label: 'Por arrancar' },
};

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'nunca';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.round((now - t) / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return d === 1 ? 'ayer' : `hace ${d} días`;
  return formatDateTime(iso);
}

async function unwrap<T>(p: Promise<ActionResult<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(r.error);
  return r as T;
}

export function SyncCard({
  sync,
  onRun,
}: {
  sync: SyncBadge;
  onRun: ((sync: SyncBadge) => Promise<void>) | null;
}) {
  const [busy, setBusy] = useState(false);
  const s = STATE[sync.state];
  return (
    <div
      className={clsx(
        'flex min-w-0 flex-1 basis-80 flex-col gap-1.5 rounded-card border bg-surface p-4 shadow-card',
        sync.state === 'error' ? 'border-rose/30' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <FolderSync className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-bold text-ink">{sync.source}</span>
        <span className={chipClass(s.tone)}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', DOT_TONE[s.tone])} aria-hidden />
          {s.label}
        </span>
      </div>
      <p className="text-micro text-ink-muted">
        La llena sola {sync.every}. Última vez{' '}
        <span className="tabular" suppressHydrationWarning>
          {timeAgo(sync.lastRunAt)}
        </span>
        {sync.state === 'ok' && (sync.lastInserted || sync.lastUpdated)
          ? ` · ${sync.lastInserted} nuevas, ${sync.lastUpdated} cambiaron`
          : ''}
        .
      </p>
      {sync.lastError ? (
        <p className="rounded-sm bg-rose-soft px-2.5 py-1.5 text-micro font-semibold text-rose">
          {sync.lastError}
        </p>
      ) : null}
      {onRun && sync.state !== 'paused' ? (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await onRun(sync);
            setBusy(false);
          }}
          className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-pill px-2.5 py-1 text-micro font-bold text-primary hover:bg-primary-soft disabled:opacity-50"
        >
          {busy ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />
          )}
          Sincronizar ahora
        </button>
      ) : null}
    </div>
  );
}

function RowHistory({
  trackerId,
  row,
  load,
}: { trackerId: string; row: GridRow; load: TrackerActions['history'] }) {
  const [state, setState] = useState<{
    loading: boolean;
    entries: HistoryEntry[];
    error: string | null;
  }>({
    loading: true,
    entries: [],
    error: null,
  });
  // Se vuelve a leer cuando la fila cambia (una edición desde el detalle).
  const stamp = String(row.values._updated_at ?? '');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` relee tras editar.
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true }));
    load(trackerId, row.id).then((r) => {
      if (!alive) return;
      setState(
        r.ok
          ? { loading: false, entries: r.entries, error: null }
          : { loading: false, entries: [], error: r.error },
      );
    });
    return () => {
      alive = false;
    };
  }, [trackerId, row.id, load, stamp]);
  return (
    <section aria-label="Historial">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-bold text-ink">
        <History className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
        Historial
      </h3>
      {state.loading ? (
        <p className="text-micro text-ink-faint">Leyendo…</p>
      ) : state.error ? (
        <p className="text-micro font-semibold text-rose">{state.error}</p>
      ) : !state.entries.length ? (
        <p className="text-micro text-ink-faint">Sin cambios registrados.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {state.entries.map((e, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: el historial no se reordena.
            <li key={i} className="text-micro leading-relaxed">
              <span className="font-semibold text-ink">{e.who}</span>{' '}
              <span className="text-ink-muted">{e.what}</span>
              <span className="tabular block text-ink-faint" suppressHydrationWarning>
                {timeAgo(e.at)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export interface TrackerLinks {
  /** `/chat` con el espacio de trabajo puesto; aquí se le agrega `prompt`. */
  chatBase: string;
  viewHref: string;
  teamHref: string;
  backHref: string;
}

export function chatWith(base: string, prompt: string): string {
  const url = new URL(base, 'https://cortex.invalid');
  url.searchParams.set('prompt', prompt.slice(0, 4000));
  return `${url.pathname}${url.search}`;
}

export function TrackerScreen({
  data,
  actions,
  lookupActions,
  links,
}: {
  data: TrackerScreenData;
  actions: TrackerActions;
  /** Consultas automáticas por fila (0198); sin ellas el panel no aparece. */
  lookupActions?: LookupActions;
  links: TrackerLinks;
}) {
  const { viewHref, teamHref, backHref } = links;
  const chatHref = (prompt: string) => chatWith(links.chatBase, prompt);
  const router = useRouter();
  const { tracker } = data;
  const scope = `tracker:${tracker.id}`;
  const [columns, setColumns] = useState<GridColumn[]>(data.columns);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [lookupOpen, setLookupOpen] = useState(false);
  const lookups = data.lookups ?? [];
  const canLookups = Boolean(lookupActions && data.canManageLookups);
  useEffect(() => setColumns(data.columns), [data.columns]);

  // --- En vivo -----------------------------------------------------------------
  // Las filas viven aquí (no sólo en la grilla) para poder mezclarles lo que
  // llega sin recargar. Una recarga del servidor (router.refresh) las reemplaza.
  const [rows, setRows] = useState<GridRow[]>(data.rows);
  const [total, setTotal] = useState(data.total);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    setRows(data.rows);
    setTotal(data.total);
  }, [data.rows, data.total]);
  const applyRows = useCallback((next: GridRow[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);
  // Lo que esta persona acaba de escribir: se integra, pero no avisa.
  const mine = useRef(new Map<string, number>());
  const markMine = useCallback((ids: string[]) => {
    const until = Date.now() + 45_000;
    for (const id of ids) mine.current.set(id, until);
  }, []);

  const [flashIds, setFlashIds] = useState<ReadonlySet<string>>(new Set());
  const [prefs, setPrefs] = useState<AlertPrefs>(DEFAULT_ALERTS);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const [liveToast, setLiveToast] = useState<{ text: string; ids: string[] } | null>(null);
  // Lo que la grilla muestra: todo, sólo duplicados, o sólo lo que llegó.
  const [focus, setFocus] = useState<'duplicates' | { ids: Set<string> } | null>(null);

  // La preferencia es de cada persona y de cada tabla: vive en su navegador.
  useEffect(() => {
    try {
      setPrefs(parseAlerts(window.localStorage.getItem(alertsKey(tracker.slug))));
    } catch {
      // Sin localStorage (ventana privada): se queda el default.
    }
  }, [tracker.slug]);
  const savePrefs = (next: AlertPrefs) => {
    setPrefs(next);
    try {
      window.localStorage.setItem(alertsKey(tracker.slug), JSON.stringify(next));
    } catch {
      // No se pudo guardar: vale para esta sesión.
    }
  };
  const onMode = (mode: AlertMode) => {
    // El navegador sólo deja sonar tras un gesto: este clic es ese gesto.
    if (mode === 'sound') unlockAudio();
    savePrefs({ ...prefs, mode });
  };
  const onSystem = async (on: boolean) => {
    if (!on) return savePrefs({ ...prefs, system: false });
    if (typeof Notification === 'undefined') {
      setNotice({ tone: 'error', text: 'Este navegador no muestra notificaciones del sistema.' });
      return;
    }
    const perm =
      Notification.permission === 'default'
        ? await Notification.requestPermission()
        : Notification.permission;
    if (perm !== 'granted') {
      setNotice({
        tone: 'error',
        text: 'El navegador no dio permiso para notificaciones. Se activa en los ajustes del sitio.',
      });
      return;
    }
    savePrefs({ ...prefs, system: true });
  };
  // Con sonido guardado de otra visita no hay gesto todavía: el primer toque lo destraba.
  useEffect(() => {
    if (prefs.mode !== 'sound') return;
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true });
    return () => window.removeEventListener('pointerdown', unlock);
  }, [prefs.mode]);

  const flashTimers = useRef(new Set<number>());
  const pendingFlash = useRef<string[]>([]);
  const flash = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setFlashIds((cur) => new Set([...cur, ...ids]));
    const t = window.setTimeout(() => {
      flashTimers.current.delete(t);
      setFlashIds((cur) => {
        const next = new Set(cur);
        for (const id of ids) next.delete(id);
        return next;
      });
    }, LIVE_FLASH_MS);
    flashTimers.current.add(t);
  }, []);
  useEffect(() => {
    const timers = flashTimers.current;
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, []);

  const sinceRef = useRef(nextSince(data.loadedAt ?? new Date().toISOString()));
  useEffect(() => {
    sinceRef.current = nextSince(data.loadedAt ?? new Date().toISOString());
  }, [data.loadedAt]);
  const toastTimer = useRef<number | undefined>(undefined);

  // Pregunta qué cambió y lo integra. Una sola a la vez.
  const polling = useRef(false);
  const slug = tracker.slug;
  const trackerName = tracker.name;
  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      for (let guard = 0; guard < 5; guard++) {
        const res = await fetch(
          `/api/trackers/${encodeURIComponent(slug)}/changes?since=${encodeURIComponent(sinceRef.current)}`,
          { cache: 'no-store' },
        );
        if (!res.ok) return;
        const body = (await res.json()) as ChangesResponse;
        const nowMs = Date.now();
        for (const [id, until] of mine.current) if (until < nowMs) mine.current.delete(id);
        const merged = mergeChanges(rowsRef.current, body.rows, new Set(mine.current.keys()));
        sinceRef.current = nextSince(body.now);
        if (merged.rows !== rowsRef.current && body.rows.length) applyRows(merged.rows);
        if (merged.created) setTotal((t) => t + merged.created);
        const p = prefsRef.current;
        if (merged.fresh.length && p.mode !== 'off') {
          if (document.visibilityState === 'visible') flash(merged.fresh);
          else pendingFlash.current.push(...merged.fresh);
          const text = summarizeChanges(merged, trackerName);
          if (p.mode === 'toast' || p.mode === 'sound') {
            setLiveToast({ text, ids: merged.fresh });
            window.clearTimeout(toastTimer.current);
            toastTimer.current = window.setTimeout(() => setLiveToast(null), 9000);
          }
          if (p.mode === 'sound') beep();
          if (p.system) desktopNotify(trackerName, text);
        }
        if (!body.truncated) return;
      }
    } catch {
      // Sin red un momento: la próxima vuelta lo reintenta.
    } finally {
      polling.current = false;
    }
  }, [slug, trackerName, applyRows, flash]);

  useEffect(() => {
    const tick = () => {
      // Oculta no se pregunta, salvo que pidan notificación del sistema:
      // esa es justo para cuando la pestaña no se ve.
      if (document.visibilityState === 'hidden' && !prefsRef.current.system) return;
      void poll();
    };
    const id = window.setInterval(tick, 15_000);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (pendingFlash.current.length) {
        flash(pendingFlash.current);
        pendingFlash.current = [];
      }
      void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(toastTimer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll, flash]);

  // Visitada: el índice deja de marcarla «nueva» hasta el próximo cambio.
  useEffect(() => {
    markSeen(slug);
    const onHide = () => markSeen(slug);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      markSeen(slug);
    };
  }, [slug]);

  const duplicateCount = useMemo(() => rows.filter((r) => r.alert).length, [rows]);
  const shownRows = useMemo(() => {
    if (!focus) return rows;
    if (focus === 'duplicates') return rows.filter((r) => r.alert);
    return rows.filter((r) => focus.ids.has(r.id));
  }, [rows, focus]);
  // Con un recorte activo la grilla trabaja sobre lo cargado, no sobre el servidor.
  useEffect(() => {
    if (focus === 'duplicates' && !duplicateCount) setFocus(null);
  }, [focus, duplicateCount]);

  const onEdit = useCallback(
    async (rowId: string, key: string, value: unknown) => {
      const out = await unwrap(actions.edit(tracker.id, rowId, key, value));
      markMine([rowId]);
      // La fila que devuelve el servidor es la verdad: así una mezcla en vivo
      // no deshace la edición con una copia vieja.
      if (out.row) applyRows(rowsRef.current.map((r) => (r.id === rowId ? out.row : r)));
    },
    [actions, tracker.id, markMine, applyRows],
  );
  const onCreate = useCallback(
    async (values: Record<string, unknown>) => {
      const { row } = await unwrap(actions.create(tracker.id, values));
      markMine([row.id]);
      if (!rowsRef.current.some((r) => r.id === row.id)) {
        applyRows([row, ...rowsRef.current]);
        setTotal((t) => t + 1);
      }
      return row;
    },
    [actions, tracker.id, markMine, applyRows],
  );
  const onDelete = useCallback(
    async (ids: string[]) => {
      await unwrap(actions.remove(tracker.id, ids));
      const gone = new Set(ids);
      const left = rowsRef.current.filter((r) => !gone.has(r.id));
      setTotal((t) => Math.max(0, t - (rowsRef.current.length - left.length)));
      applyRows(left);
    },
    [actions, tracker.id, applyRows],
  );
  const onBulkEdit = useCallback(
    async (ids: string[], key: string, value: unknown) => {
      await unwrap(actions.bulkEdit(tracker.id, ids, key, value));
      markMine(ids);
      const set = new Set(ids);
      applyRows(
        rowsRef.current.map((r) =>
          set.has(r.id) ? { ...r, values: { ...r.values, [key]: value } } : r,
        ),
      );
    },
    [actions, tracker.id, markMine, applyRows],
  );
  const onAddColumn = useCallback(
    async (col: Omit<GridColumn, 'key'> & { key?: string }) => {
      const out = await unwrap(
        actions.addColumn(tracker.id, {
          label: col.label,
          type: col.type,
          options: col.options?.map((o) => o.value),
          required: col.required,
        }),
      );
      return out.column;
    },
    [actions, tracker.id],
  );
  const onQuery = useCallback(
    async (view: GridView, page: { offset: number; limit: number }) => {
      const r = await unwrap(actions.query(tracker.id, view, page));
      return { rows: r.rows, total: r.total };
    },
    [actions, tracker.id],
  );
  const onSaveView = useCallback((v: GridView) => actions.saveView(scope, v), [actions, scope]);
  const onDeleteView = useCallback((id: string) => actions.deleteView(id), [actions]);

  const runSync = async (sync: SyncBadge) => {
    const r = await actions.syncNow(sync.kind, sync.id);
    setNotice(r.ok ? { tone: 'ok', text: r.message } : { tone: 'error', text: r.error });
    if (r.ok) window.setTimeout(() => router.refresh(), 4000);
  };

  // «Abrir en Google Sheets» / «Abrir carpeta», uno por fuente con enlace conocido.
  const sheetLinks = useMemo(() => {
    const seen = new Set<string>();
    const out: Array<{ href: string; label: string }> = [];
    for (const sy of data.syncs) {
      if (!sy.openUrl || seen.has(sy.openUrl)) continue;
      seen.add(sy.openUrl);
      out.push({
        href: sy.openUrl,
        label: sy.kind === 'drive_folder' ? 'Abrir carpeta' : 'Abrir en Google Sheets',
      });
    }
    return out;
  }, [data.syncs]);

  const describe = useMemo(
    () => `Sobre la tabla «${tracker.name}» (${tracker.fields.map((f) => f.label).join(', ')}):`,
    [tracker.name, tracker.fields],
  );

  return (
    <>
      <Link
        href={backHref}
        className="mb-4 inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
        Tablas
      </Link>
      <PageHeader
        title={tracker.name}
        subtitle={tracker.description || undefined}
        icon={<Table2 className="h-5 w-5" />}
        actions={
          <>
            {canLookups && !lookups.length ? (
              <button type="button" onClick={() => setLookupOpen(true)} className={pill}>
                <ScanSearch className="h-4 w-4" aria-hidden />
                Consultar una API por fila
              </button>
            ) : null}
            {sheetLinks.map((l) => (
              <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className={pill}>
                <ExternalLink className="h-4 w-4" aria-hidden />
                {l.label}
              </a>
            ))}
            <Link href={viewHref} className={pill}>
              <LayoutPanelTop className="h-4 w-4" aria-hidden />
              Crear una vista con esta tabla
            </Link>
            <Link
              href={chatHref(`Abre la tabla «${tracker.name}» (${tracker.slug}) y dime qué ves.`)}
              className={pill}
            >
              <MessageSquareText className="h-4 w-4" aria-hidden />
              Abrir en el chat
            </Link>
          </>
        }
      />

      {lookupActions && lookups.length ? (
        <div className="-mt-3 mb-5 flex flex-col gap-3">
          <LookupsSection
            lookups={lookups}
            canManage={canLookups}
            actions={lookupActions}
            onNotice={setNotice}
            onAdd={() => setLookupOpen(true)}
            onChanged={() => window.setTimeout(() => router.refresh(), 1500)}
          />
          {notice && !data.syncs.length && !data.workType && !data.syncedRows ? (
            <p
              role={notice.tone === 'error' ? 'alert' : 'status'}
              className={clsx(
                'w-fit rounded-pill px-3 py-1.5 text-micro font-semibold',
                notice.tone === 'error' ? 'bg-rose-soft text-rose' : 'bg-emerald-soft text-emerald',
              )}
            >
              {notice.text}
            </p>
          ) : null}
        </div>
      ) : null}

      {data.syncs.length || data.workType || data.syncedRows ? (
        <div className="-mt-3 mb-5 flex flex-col gap-3">
          {data.workType ? (
            <Link
              href={teamHref}
              className="inline-flex w-fit items-center gap-2 rounded-pill border border-primary/15 bg-primary-soft px-3 py-1.5 text-micro font-semibold text-primary-ink hover:brightness-95"
            >
              <Ruler className="h-3.5 w-3.5" aria-hidden />
              Se mide como trabajo · {data.workType}
            </Link>
          ) : null}
          {data.syncs.length ? (
            <div className="flex flex-wrap gap-3">
              {data.syncs.map((s) => (
                <SyncCard key={s.id} sync={s} onRun={runSync} />
              ))}
            </div>
          ) : null}
          {data.syncedRows ? (
            <p className="text-micro text-ink-muted">
              <span className="tabular">{data.syncedRows}</span> filas las trae la sincronización:
              si cambias una columna que la fuente también trae, la próxima corrida la vuelve a
              poner como en la fuente.
            </p>
          ) : null}
          {notice ? (
            <p
              role={notice.tone === 'error' ? 'alert' : 'status'}
              className={clsx(
                'w-fit rounded-pill px-3 py-1.5 text-micro font-semibold',
                notice.tone === 'error' ? 'bg-rose-soft text-rose' : 'bg-emerald-soft text-emerald',
              )}
            >
              {notice.text}
            </p>
          ) : null}
        </div>
      ) : null}

      {lookupActions && canLookups ? (
        <AddLookupDialog
          open={lookupOpen}
          onOpenChange={setLookupOpen}
          trackerId={tracker.id}
          trackerName={tracker.name}
          columns={columns}
          credentials={data.lookupCredentials ?? []}
          actions={lookupActions}
          onDone={(text) => {
            setNotice({ tone: 'ok', text });
            router.refresh();
          }}
        />
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {duplicateCount ? (
          <button
            type="button"
            aria-pressed={focus === 'duplicates'}
            onClick={() => setFocus((f) => (f === 'duplicates' ? null : 'duplicates'))}
            className={clsx(
              'inline-flex min-h-8 items-center gap-1.5 rounded-pill border px-3 py-1 text-xs font-bold transition-colors',
              focus === 'duplicates'
                ? 'border-rose bg-rose text-white'
                : 'border-rose/30 bg-rose-soft text-rose hover:brightness-95',
            )}
          >
            <CopyX className="h-3.5 w-3.5" aria-hidden />
            {duplicateCount} {duplicateCount === 1 ? 'duplicado' : 'duplicados'}
          </button>
        ) : null}
        {focus && focus !== 'duplicates' ? (
          <button
            type="button"
            onClick={() => setFocus(null)}
            className="inline-flex min-h-8 items-center gap-1.5 rounded-pill border border-primary/20 bg-primary-soft px-3 py-1 text-xs font-bold text-primary-ink"
          >
            Mostrando lo que llegó ({focus.ids.size})
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-3 text-xs text-ink-muted">
          <label className="inline-flex items-center gap-1.5 font-semibold">
            <Bell className="h-3.5 w-3.5" aria-hidden />
            Avisos
            <select
              value={prefs.mode}
              onChange={(e) => onMode(e.target.value as AlertMode)}
              aria-label="Avisos cuando llegan filas nuevas"
              className="rounded-pill border border-border-strong bg-surface px-2.5 py-1 text-xs font-semibold text-ink"
            >
              {ALERT_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          {prefs.mode !== 'off' ? (
            <label className="inline-flex cursor-pointer items-center gap-1.5 font-semibold">
              <input
                type="checkbox"
                checked={prefs.system}
                onChange={(e) => void onSystem(e.target.checked)}
                className="h-3.5 w-3.5 accent-[rgb(var(--primary))]"
              />
              Notificación del sistema
            </label>
          ) : null}
        </div>
      </div>

      <DataGrid
        columns={columns}
        rows={shownRows}
        total={focus ? shownRows.length : total}
        flashIds={flashIds}
        savedViews={data.savedViews}
        onSaveView={onSaveView}
        onDeleteView={onDeleteView}
        onQuery={!focus && total > rows.length ? onQuery : undefined}
        onEdit={onEdit}
        onCreate={onCreate}
        onDelete={onDelete}
        onBulkEdit={onBulkEdit}
        onAddColumn={data.canChangeSchema && tracker.fields.length < 20 ? onAddColumn : undefined}
        addColumnTypes={['text', 'number', 'money', 'date', 'select']}
        exportName={tracker.name}
        noun={{ one: 'fila', many: 'filas', gender: 'f' }}
        askCortexContext={describe}
        emptyState={{
          title: 'Esta tabla está vacía',
          body: 'Agrega la primera fila aquí, impórtala de un Excel desde «Tablas», o pídele a Cortex que la llene.',
          action: {
            label: 'Pídeselo a Cortex',
            href: chatHref(`Ayúdame a llenar la tabla «${tracker.name}».`),
          },
        }}
        renderRowExtra={(row) => (
          <RowHistory trackerId={tracker.id} row={row} load={actions.history} />
        )}
      />

      {liveToast ? (
        <div
          aria-live="polite"
          className="pointer-events-none fixed inset-x-0 bottom-20 z-[80] flex justify-center px-4"
        >
          <output className="pointer-events-auto flex max-w-md items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 text-xs font-semibold text-ink shadow-pop">
            <span className="min-w-0 flex-1">{liveToast.text}</span>
            <button
              type="button"
              onClick={() => {
                setFocus({ ids: new Set(liveToast.ids) });
                setLiveToast(null);
              }}
              className="rounded-pill px-2.5 py-1 font-bold text-primary hover:bg-primary-soft"
            >
              Ver
            </button>
            <button
              type="button"
              onClick={() => setLiveToast(null)}
              className="-m-1 rounded-pill p-1 opacity-70 hover:opacity-100"
              aria-label="Cerrar aviso"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          </output>
        </div>
      ) : null}
    </>
  );
}
