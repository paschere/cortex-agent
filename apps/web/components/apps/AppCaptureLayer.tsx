'use client';

import { LiveViewCanvas } from '@/components/views/LiveViewCanvas';
import { CaptureContext } from '@/components/views/inputs/capture-context';
import { type OutboxSnapshot, outboxFor } from '@/lib/apps/app-outbox';
import { agoLabel } from '@/lib/apps/offline-cache';
import { type Conflict, type OutboxItem, STATE_LABEL } from '@/lib/apps/op-queue';
import { type SavedScreen, recallScreen } from '@/lib/apps/screen-store';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  CloudOff,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

/**
 * LA CAPA DE CAPTURA DE UNA APP: todo lo que pasa cuando falta la señal.
 *
 *  - la barra «Sin señal · 3 pendientes por enviar» con la lista de pendientes
 *    (cada uno con su estado) y la revisión de lo que cambió mientras tanto;
 *  - el buzón de salida (lib/apps/app-outbox.ts): arranca con la app y envía en
 *    orden al volver la señal;
 *  - pantallas ya vistas: sin señal, tocar otra pantalla muestra su última
 *    copia «guardada hace X» en vez de una página de error;
 *  - quién captura, para la marca de agua de las fotos con evidencia.
 *
 * En «Ver como…» y en la vista previa no hay nada de esto: no se escribe.
 */

export interface AppCaptureLayerProps {
  /** Lo que usan las acciones del servidor para ubicar la app (slug de un miembro, id de un externo). */
  appKey: string;
  appName: string;
  external: boolean;
  /** Quién captura; null = sin captura (vista previa, «ver como»). */
  who: { key: string; name: string } | null;
  /** Dónde cuelgan las pantallas (`/apps/<slug>` o `/a/<id>`). */
  base: string;
  current: string;
  /** Cuándo se calculó lo que se está viendo. */
  computedAt: string;
  canExport: boolean;
  children: React.ReactNode;
}

export function AppCaptureLayer({
  appKey,
  appName,
  external,
  who,
  base,
  current,
  computedAt,
  children,
}: AppCaptureLayerProps) {
  const router = useRouter();
  const userKey = who?.key ?? null;
  const outbox = useMemo(
    () => (userKey ? outboxFor(appKey, userKey, external) : null),
    [appKey, userKey, external],
  );
  const snap = useSyncExternalStore(
    outbox?.subscribe ?? NO_SUBSCRIBE,
    outbox?.getSnapshot ?? NO_SNAPSHOT,
    outbox?.getSnapshot ?? NO_SNAPSHOT,
  );
  const [now, setNow] = useState(() => Date.now());
  const [saved, setSaved] = useState<SavedScreen | null>(null);
  const [notSaved, setNotSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!outbox) return;
    void outbox.start();
    return () => outbox.stop();
  }, [outbox]);

  // «hace 12 min» se mantiene al día mientras la barra está a la vista.
  useEffect(() => {
    if (snap.online && !snap.items.length) return;
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, [snap.online, snap.items.length]);

  // Sin señal, tocar otra pantalla muestra su última copia en vez de una página de error.
  useEffect(() => {
    if (!userKey) return;
    const onClick = (e: MouseEvent) => {
      if (navigator.onLine !== false || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]');
      const href = a?.getAttribute('href') ?? '';
      if (!a || !href.startsWith(`${base}/`)) return;
      const slug = decodeURIComponent(href.slice(base.length + 1).split(/[?#]/)[0] ?? '');
      if (!slug) return;
      e.preventDefault();
      e.stopPropagation();
      setNotSaved(null);
      if (slug === current) return setSaved(null);
      void recallScreen({ appKey, userKey }, slug).then((hit) => {
        if (hit) setSaved(hit);
        else
          setNotSaved('Esa pantalla no está guardada en el teléfono. Se verá al volver la señal.');
      });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [appKey, userKey, base, current]);

  // Volvió la señal: se sale de la copia y se abre la pantalla de verdad.
  useEffect(() => {
    if (!saved) return;
    const onOnline = () => {
      const slug = saved.screen;
      setSaved(null);
      router.push(`${base}/${slug}`);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [saved, base, router]);

  const dataFrom = saved ? saved.savedAt : Date.parse(computedAt);
  const offlineNote = !snap.online
    ? `${saved ? 'Mostrando' : 'Estás viendo'} lo guardado ${agoLabel(new Date(dataFrom), new Date(now))}.`
    : null;

  const content = saved ? (
    <LiveViewCanvas
      key={saved.screen}
      initial={saved.computed}
      target={{ kind: 'custom_app', appId: appKey, screen: saved.screen, external }}
      dataUrl={null}
      heading={{ title: saved.title }}
      showBrand={false}
      canExport={false}
    />
  ) : (
    children
  );

  if (!outbox) return <>{content}</>;

  return (
    <CaptureContext.Provider value={{ userName: who?.name ?? null, appName }}>
      <OutboxBar
        snap={snap}
        note={offlineNote}
        notSaved={notSaved}
        onRetry={(id) => void outbox.retry(id)}
        onDiscard={(id) => void outbox.discard(id)}
        onResolve={(id, choice) => void outbox.resolve(id, choice)}
      />
      {content}
    </CaptureContext.Provider>
  );
}

/**
 * La barra de pendientes, sin nada del navegador: recibe el estado y avisa lo que
 * la persona decide. Así se puede ver en el escaparate (/v/apps-showcase) con
 * datos de mentira.
 */
export function OutboxBar({
  snap,
  note = null,
  notSaved = null,
  defaultOpen = false,
  onRetry,
  onDiscard,
  onResolve,
}: {
  snap: Pick<OutboxSnapshot, 'online' | 'syncing' | 'items' | 'summary'>;
  /** «Estás viendo lo guardado hace 12 minutos.» */
  note?: string | null;
  notSaved?: string | null;
  defaultOpen?: boolean;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  onResolve: (id: string, choice: 'mine' | 'theirs') => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const { summary, items } = snap;
  if (snap.online && summary.text === null && !notSaved) return null;
  return (
    <div
      className={clsx(
        'view-no-print sticky top-2 z-30 mb-4 overflow-hidden rounded-card border text-sm shadow-card',
        summary.tone === 'review'
          ? 'border-rose/40 bg-rose-soft'
          : snap.online
            ? 'border-primary/30 bg-primary-soft'
            : 'border-amber/40 bg-amber-soft',
      )}
    >
      <div className="flex min-h-11 items-center gap-2 px-4 py-2 font-medium text-ink">
        {!snap.online ? (
          <CloudOff className="h-4 w-4 shrink-0" aria-hidden />
        ) : summary.tone === 'review' ? (
          <AlertTriangle className="h-4 w-4 shrink-0 text-rose" aria-hidden />
        ) : snap.syncing ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Clock className="h-4 w-4 shrink-0" aria-hidden />
        )}
        <output className="min-w-0 flex-1" aria-live="polite">
          <span className="font-semibold">{summary.text ?? 'Sin señal'}</span>
          {note && <span className="text-ink-muted"> · {note}</span>}
          {notSaved && <span className="block text-xs text-ink-muted">{notSaved}</span>}
        </output>
        {items.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="app-press inline-flex min-h-9 shrink-0 items-center gap-1 rounded-pill px-3 text-xs font-semibold text-ink hover:bg-surface/60"
          >
            {open ? 'Ocultar' : 'Ver'}
            <ChevronDown
              className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
              aria-hidden
            />
          </button>
        )}
      </div>
      {open && items.length > 0 && (
        <ul className="divide-y divide-border/60 border-t border-border/60 bg-surface/70">
          {items.map((item) => (
            <PendingRow
              key={item.id}
              item={item}
              online={snap.online}
              onRetry={() => onRetry(item.id)}
              onDiscard={() => onDiscard(item.id)}
              onResolve={(choice) => onResolve(item.id, choice)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

const NO_SUBSCRIBE = () => () => undefined;
const EMPTY = {
  online: true,
  syncing: false,
  items: [] as OutboxItem[],
  summary: { pending: 0, review: 0, text: null, tone: null },
};
const NO_SNAPSHOT = () => EMPTY;

const CHIP: Record<OutboxItem['state'], string> = {
  pending: 'bg-surface-2 text-ink-muted',
  retrying: 'bg-amber-soft text-ink',
  rejected: 'bg-rose-soft text-rose',
  conflict: 'bg-rose-soft text-rose',
};

function PendingRow({
  item,
  online,
  onRetry,
  onDiscard,
  onResolve,
}: {
  item: OutboxItem;
  online: boolean;
  onRetry: () => void;
  onDiscard: () => void;
  onResolve: (choice: 'mine' | 'theirs') => void;
}) {
  const review = item.state === 'rejected' || item.state === 'conflict';
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{item.label}</span>
        <span
          className={clsx('rounded-pill px-2.5 py-0.5 text-micro font-semibold', CHIP[item.state])}
        >
          {STATE_LABEL[item.state]}
          {item.state === 'retrying' && item.attempts > 1 ? ` (${item.attempts})` : ''}
        </span>
      </div>
      {item.state === 'rejected' && item.error && <p className="text-xs text-rose">{item.error}</p>}
      {item.state === 'conflict' && item.conflict && <ConflictTable conflicts={item.conflict} />}
      <div className="flex flex-wrap gap-2">
        {item.state === 'conflict' ? (
          <>
            <button
              type="button"
              onClick={() => onResolve('mine')}
              disabled={!online}
              className="app-press inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-3 text-xs font-semibold text-white disabled:opacity-50"
            >
              Aplicar lo mío
            </button>
            <button
              type="button"
              onClick={() => onResolve('theirs')}
              className="app-press inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border px-3 text-xs font-semibold text-ink"
            >
              Descartar lo mío
            </button>
          </>
        ) : (
          <>
            {(review || item.state === 'retrying') && (
              <button
                type="button"
                onClick={onRetry}
                disabled={!online}
                className="app-press inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border px-3 text-xs font-semibold text-ink disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Reintentar
              </button>
            )}
            <button
              type="button"
              onClick={onDiscard}
              className="app-press inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border px-3 text-xs font-semibold text-rose"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Descartar
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function ConflictTable({ conflicts }: { conflicts: Conflict[] }) {
  return (
    <div className="space-y-1.5 rounded-sm border border-border bg-surface px-3 py-2 text-xs">
      <p className="font-semibold text-ink">
        Este registro cambió mientras no tenías señal. Elige qué se queda.
      </p>
      {conflicts.map((c) => (
        <dl key={c.field} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
          <dt className="text-ink-faint">Campo</dt>
          <dd className="font-semibold text-ink">{c.label ?? c.field}</dd>
          <dt className="text-ink-faint">Tú viste</dt>
          <dd className="text-ink-muted">{c.was || '—'}</dd>
          <dt className="text-ink-faint">Querías poner</dt>
          <dd className="font-semibold text-ink">{c.mine || '—'}</dd>
          <dt className="text-ink-faint">Ahora dice</dt>
          <dd className="font-semibold text-rose">{c.theirs || '—'}</dd>
        </dl>
      ))}
    </div>
  );
}
