'use client';

import { DataGrid } from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow, GridView } from '@/components/datagrid/types';
import { PageHeader } from '@/components/ui/page-header';
import { formatDateTime } from '@/lib/datagrid/format';
import { DOT_TONE, type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  FolderSync,
  History,
  LayoutPanelTop,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Ruler,
  Table2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ActionResult,
  HistoryEntry,
  SyncBadge,
  TrackerActions,
  TrackerScreenData,
} from '../types';

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
  links,
}: {
  data: TrackerScreenData;
  actions: TrackerActions;
  links: TrackerLinks;
}) {
  const { viewHref, teamHref, backHref } = links;
  const chatHref = (prompt: string) => chatWith(links.chatBase, prompt);
  const router = useRouter();
  const { tracker } = data;
  const scope = `tracker:${tracker.id}`;
  const [columns, setColumns] = useState<GridColumn[]>(data.columns);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => setColumns(data.columns), [data.columns]);

  const onEdit = useCallback(
    async (rowId: string, key: string, value: unknown) => {
      await unwrap(actions.edit(tracker.id, rowId, key, value));
    },
    [actions, tracker.id],
  );
  const onCreate = useCallback(
    async (values: Record<string, unknown>) =>
      (await unwrap(actions.create(tracker.id, values))).row,
    [actions, tracker.id],
  );
  const onDelete = useCallback(
    async (ids: string[]) => {
      await unwrap(actions.remove(tracker.id, ids));
    },
    [actions, tracker.id],
  );
  const onBulkEdit = useCallback(
    async (ids: string[], key: string, value: unknown) => {
      await unwrap(actions.bulkEdit(tracker.id, ids, key, value));
    },
    [actions, tracker.id],
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

      <DataGrid
        columns={columns}
        rows={data.rows}
        total={data.total}
        savedViews={data.savedViews}
        onSaveView={onSaveView}
        onDeleteView={onDeleteView}
        onQuery={data.total > data.rows.length ? onQuery : undefined}
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
    </>
  );
}
