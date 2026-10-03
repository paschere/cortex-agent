'use client';

import type { SpaceChoice } from '@/app/(chat)/chat/actions';
import { PageHeader } from '@/components/ui/page-header';
import type { FeedDetail, FeedEntry } from '@/lib/feed/shared';
import { workspaceHref } from '@/lib/workspace-context';
import { clsx } from 'clsx';
import {
  ArrowRight,
  Brain,
  Check,
  Inbox,
  LayoutGrid,
  List,
  Loader2,
  Lock,
  Search,
  Sparkles,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type ApiWizardClient, httpApiWizardClient } from './ConnectApiWizard';
import { FeedDrawer } from './FeedDrawer';
import { FeedIntake, type IntakeMode } from './FeedIntake';
import { FeedSourceRegistry } from './FeedSourceRegistry';
import { SourceIntelligence } from './SourceIntelligence';
import { TypeIcon } from './TypeIcon';
import { type FeedClient, httpFeedClient } from './feed-client';
import {
  DATE_LABEL,
  type DateRange,
  type FeedOrigin,
  type FeedStatus,
  type FeedType,
  type InboxFilters,
  NO_FILTERS,
  ORIGIN_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  TABLE_PROMPT,
  TYPE_LABEL,
  countByStatus,
  feedOrigin,
  feedStatus,
  feedType,
  filterEntries,
  formatBytes,
  shortWhen,
  withPrompt,
} from './inbox-model';

/**
 * LA BANDEJA DE ARCHIVOS, COMO UN BUZÓN.
 *
 * Todo lo que llegó —archivos subidos, enlaces, textos, capturas de una API,
 * fotos de una hoja— en una lista que se filtra (tipo, por dónde llegó, en qué
 * quedó, cuándo), se busca, se selecciona de a varios (clasificar, guardar en
 * el cerebro, convertir en tabla, borrar) y se abre en un cajón con la vista
 * previa. Arriba, una zona grande para soltar archivos o pegar un enlace.
 *
 * Bandeja ≠ cerebro: la bandeja es tuya y temporal (siete días); el cerebro es
 * de la empresa y permanente. Se dice en pantalla porque es la duda que más
 * llega.
 *
 * Todo lo que se pide al servidor pasa por `FeedClient` (las rutas de siempre
 * en /api/feed), así el fixture de /v la dibuja con datos inventados.
 */

type View = 'entries' | 'sources' | 'cross';
const NO_IDS: string[] = [];
type Layout = 'list' | 'grid';

const select =
  'min-h-9 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
const bulkBtn =
  'inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50';

export function Feed({
  initialEntries,
  workspaceId,
  initialMode = 'file',
  initialView = 'entries',
  initialOpenId,
  tableSourceIds = NO_IDS,
  client: injected,
  apiClient: injectedApi,
  now: fixedNow,
}: {
  initialEntries: FeedEntry[];
  workspaceId: string;
  initialMode?: IntakeMode;
  initialView?: View;
  /** Abre esta entrada al cargar (el fixture de /v). */
  initialOpenId?: string;
  /** Fuentes que llenan una tabla: sus entradas dicen «En tabla». */
  tableSourceIds?: string[];
  /** Sólo el fixture de /v los pasa. */
  client?: FeedClient;
  apiClient?: ApiWizardClient;
  now?: string;
}) {
  const href = useCallback((path: string) => workspaceHref(workspaceId, path), [workspaceId]);
  const client = useMemo(() => injected ?? httpFeedClient(workspaceId), [injected, workspaceId]);
  const apiClient = useMemo(
    () =>
      injectedApi ??
      httpApiWizardClient({
        apiSources: workspaceHref(workspaceId, '/api/feed/api-sources'),
        sources: workspaceHref(workspaceId, '/api/feed/sources'),
        entry: (id) => workspaceHref(workspaceId, `/api/feed/${id}`),
      }),
    [injectedApi, workspaceId],
  );
  const router = useRouter();
  const now = useMemo(() => (fixedNow ? new Date(fixedNow) : new Date()), [fixedNow]);
  const ctx = useMemo(() => ({ tableSourceIds: new Set(tableSourceIds) }), [tableSourceIds]);

  const [entries, setEntries] = useState(initialEntries);
  const [mode, setMode] = useState<IntakeMode>(initialMode);
  const [view, setView] = useState<View>(initialView);
  const [layout, setLayout] = useState<Layout>('list');
  const [filters, setFilters] = useState<InboxFilters>(NO_FILTERS);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(initialOpenId ?? null);
  const [detail, setDetail] = useState<FeedDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [areas, setAreas] = useState<Record<string, string[]>>({});
  const [bulk, setBulk] = useState<
    null | { kind: 'promote'; spaces: SpaceChoice[] } | { kind: 'delete' }
  >(null);
  const [bulkSpace, setBulkSpace] = useState('');
  const [sourceCount, setSourceCount] = useState<number | null>(null);
  const [versionTarget, setVersionTarget] = useState<{
    id: string;
    kind: 'file' | 'text';
    name: string;
  } | null>(null);
  const intakeRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => filterEntries(entries, filters, ctx, now),
    [entries, filters, ctx, now],
  );
  const counts = useMemo(() => countByStatus(entries, ctx), [entries, ctx]);
  const openEntry = entries.find((e) => e.id === openId) ?? null;
  const checkedEntries = entries.filter((e) => checked.has(e.id));
  const filtering =
    filters.query !== '' ||
    filters.type !== 'all' ||
    filters.origin !== 'all' ||
    filters.status !== 'all' ||
    filters.date !== 'all';

  const refresh = useCallback(async () => {
    setEntries(await client.list());
  }, [client]);

  useEffect(() => {
    setDetail(null);
    if (!openId) return;
    const controller = new AbortController();
    client
      .detail(openId, controller.signal)
      .then((d) => setDetail(d))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'No se pudo leer la entrada.');
        setOpenId(null);
      });
    return () => controller.abort();
  }, [openId, client]);

  // Pegar en cualquier parte de la página (fuera de un campo) trae lo pegado.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      const files = [...(e.clipboardData?.files ?? [])];
      if (files.length) {
        e.preventDefault();
        void upload(files);
        return;
      }
      const text = e.clipboardData?.getData('text') ?? '';
      if (/^https?:\/\/\S+$/i.test(text.trim())) {
        e.preventDefault();
        void submit({ kind: 'url', url: text.trim() });
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  });

  function prepend(entry: FeedEntry) {
    setEntries((prev) => [entry, ...prev.filter((e) => e.id !== entry.id)]);
  }

  async function add(form: FormData) {
    if (versionTarget) form.set('targetSourceId', versionTarget.id);
    const data = await client.add(form);
    prepend(data.entry);
    setOpenId(data.entry.id);
    setNotice(
      versionTarget
        ? `Nueva versión guardada en ${versionTarget.name}.`
        : data.deduplicated
          ? 'Eso ya estaba en tu bandeja: se reutilizó la entrada, sin duplicarla ni alargar su vencimiento.'
          : 'Listo, ya está en tu bandeja. Cortex propone para qué sirve; sigue temporal hasta que decidas guardarla.',
    );
    setVersionTarget(null);
  }

  async function upload(files: File[]) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      for (const file of files) {
        const form = new FormData();
        form.set('kind', 'file');
        form.set('file', file);
        await add(form);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo subir el archivo.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(input: {
    kind: 'url' | 'text';
    url?: string;
    title?: string;
    text?: string;
  }) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set('kind', input.kind);
      form.set('url', input.url ?? '');
      form.set('title', input.title ?? '');
      form.set('text', input.text ?? '');
      await add(form);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo añadir la entrada.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function run<T>(work: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      return await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo completar la acción.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const consult = (id: string, prompt?: string) =>
    run(async () => {
      const to = await client.consult(id);
      router.push(prompt ? withPrompt(to, prompt) : to);
    });

  const promote = (ids: string[], space: string) =>
    run(async () => {
      let saved = 0;
      let lastNote = '';
      for (const id of ids) {
        const entry = entries.find((e) => e.id === id);
        if (entry?.promoted_document_id) continue;
        const result = await client.promote(id, space || undefined);
        lastNote = result.note;
        saved += 1;
        setEntries((prev) =>
          prev.map((e) => (e.id === id ? { ...e, promoted_document_id: result.documentId } : e)),
        );
        setDetail((d) =>
          d && d.id === id ? { ...d, promoted_document_id: result.documentId } : d,
        );
      }
      setBulk(null);
      setChecked(new Set());
      setNotice(
        ids.length === 1
          ? lastNote || 'Guardado en el cerebro.'
          : `${saved} ${saved === 1 ? 'entrada guardada' : 'entradas guardadas'} en el cerebro${saved < ids.length ? '; las demás ya estaban' : ''}.`,
      );
    });

  const remove = (ids: string[]) =>
    run(async () => {
      for (const id of ids) await client.remove(id);
      setEntries((prev) => prev.filter((e) => !ids.includes(e.id)));
      if (openId && ids.includes(openId)) setOpenId(null);
      setChecked(new Set());
      setBulk(null);
      setNotice(
        ids.length === 1
          ? 'Entrada borrada de la bandeja.'
          : `${ids.length} entradas borradas de la bandeja.`,
      );
    });

  const classify = (ids: string[]) =>
    run(async () => {
      const found: Record<string, string[]> = {};
      for (let i = 0; i < ids.length; i += 3) {
        const batch = await Promise.all(ids.slice(i, i + 3).map((id) => client.detail(id)));
        for (const d of batch)
          found[d.id] = [...new Set((d.recommendation?.tables ?? []).flatMap((t) => t.areas))];
      }
      setAreas((prev) => ({ ...prev, ...found }));
      setNotice(
        `Listo: Cortex propuso para qué sirve ${ids.length === 1 ? 'la entrada' : `cada una de las ${ids.length}`}. Ábrela para ver el detalle por pestaña.`,
      );
    });

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allChecked = visible.length > 0 && visible.every((e) => checked.has(e.id));

  return (
    <div className="flex w-full flex-col gap-6">
      <PageHeader
        title="Bandeja de archivos"
        icon={<Inbox className="h-5 w-5" />}
        subtitle="Todo lo que le traes a Cortex para consultarlo: archivos, enlaces, textos y capturas. Sólo tú lo ves."
        actions={
          <>
            <Link
              href={href('/integrations')}
              className="inline-flex min-h-10 items-center rounded-pill border border-border-strong bg-surface px-4 text-sm font-bold text-ink hover:bg-surface-2"
            >
              Datos y conexiones
            </Link>
            <Link
              href={href('/activations')}
              className="inline-flex min-h-10 items-center rounded-pill border border-border-strong bg-surface px-4 text-sm font-bold text-ink hover:bg-surface-2"
            >
              Activaciones
            </Link>
          </>
        }
      />

      <InboxVsBrain href={href} />

      <div ref={intakeRef} className="scroll-mt-6">
        <FeedIntake
          mode={mode}
          onMode={(m) => {
            setMode(m);
            if (m !== versionTarget?.kind) setVersionTarget(null);
          }}
          busy={busy}
          versionTarget={versionTarget}
          onCancelVersion={() => setVersionTarget(null)}
          onFiles={(files) => void upload(files)}
          onRejected={() =>
            setError('Usa PDF, DOCX, XLSX, CSV, TXT o Markdown, de hasta 10 MB por archivo.')
          }
          onSubmit={submit}
          apiClient={apiClient}
          onApiAdded={(entry) => {
            prepend(entry);
            setOpenId(entry.id);
          }}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-card bg-rose-soft px-4 py-3 text-sm text-ink"
        >
          {error}
          <button type="button" aria-label="Cerrar el aviso" onClick={() => setError(null)}>
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {notice && (
        <output className="flex items-start justify-between gap-3 rounded-card bg-emerald-soft px-4 py-3 text-sm text-ink">
          <span className="flex items-start gap-2">
            <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald" aria-hidden />
            {notice}
          </span>
          <button type="button" aria-label="Cerrar el aviso" onClick={() => setNotice(null)}>
            <X className="h-4 w-4" />
          </button>
        </output>
      )}

      <section aria-label="Lo que llegó" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border">
          <div className="-mb-px flex gap-1 overflow-x-auto">
            {(
              [
                ['entries', 'Entradas', latestCount(entries)],
                ['sources', 'Fuentes que se actualizan', sourceCount],
                ['cross', 'Cruzar fuentes', null],
              ] as const
            ).map(([id, label, n]) => (
              <button
                key={id}
                type="button"
                aria-pressed={view === id}
                onClick={() => setView(id)}
                className={clsx(
                  'shrink-0 border-b-2 px-3 pb-2.5 pt-1 text-sm font-bold transition-colors',
                  view === id
                    ? 'border-primary text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {label}
                {n !== null && (
                  <span className="tabular ml-1.5 text-xs font-semibold text-ink-faint">{n}</span>
                )}
              </button>
            ))}
          </div>
          {view === 'entries' && entries.length > 0 && (
            <StatusStrip
              counts={counts}
              active={filters.status}
              onPick={(s) => setFilters((f) => ({ ...f, status: f.status === s ? 'all' : s }))}
            />
          )}
        </div>

        {view === 'sources' && (
          <FeedSourceRegistry
            client={client}
            workspaceId={workspaceId}
            refreshKey={entries.map((e) => e.id).join(',')}
            onCount={setSourceCount}
            onCaptured={(entry) => entry && prepend(entry)}
            onAddVersion={(source) => {
              setVersionTarget(source);
              setMode(source.kind);
              intakeRef.current?.scrollIntoView({ behavior: 'smooth' });
            }}
          />
        )}

        {view === 'cross' && (
          <div className="rounded-card border border-border bg-surface p-3 shadow-card sm:p-4">
            <SourceIntelligence
              workspaceId={workspaceId}
              refreshKey={entries.map((e) => e.id).join(',')}
              onCaptured={() => void refresh().catch(() => undefined)}
            />
          </div>
        )}

        {view === 'entries' &&
          (entries.length === 0 ? (
            <EmptyInbox onPick={() => intakeRef.current?.scrollIntoView({ behavior: 'smooth' })} />
          ) : (
            <>
              <Toolbar
                filters={filters}
                setFilters={setFilters}
                layout={layout}
                setLayout={setLayout}
                filtering={filtering}
              />

              {checked.size > 0 && (
                <div className="sticky top-2 z-30 flex flex-col gap-2 rounded-card bg-ink px-4 py-3 text-surface shadow-pop">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="mr-2 text-sm font-bold">
                      <span className="tabular">{checked.size}</span>{' '}
                      {checked.size === 1 ? 'seleccionada' : 'seleccionadas'}
                    </span>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void classify([...checked])}
                      className={clsx(bulkBtn, 'bg-surface/10 hover:bg-surface/20')}
                    >
                      <Sparkles className="h-3.5 w-3.5" aria-hidden /> Clasificar
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          setBulkSpace('');
                          setBulk({ kind: 'promote', spaces: await client.spaces() });
                        })
                      }
                      className={clsx(bulkBtn, 'bg-surface/10 hover:bg-surface/20')}
                    >
                      <Brain className="h-3.5 w-3.5" aria-hidden /> Mover al cerebro
                    </button>
                    <button
                      type="button"
                      disabled={busy || checked.size !== 1}
                      title={
                        checked.size !== 1
                          ? 'Elige una sola entrada para convertirla en tabla'
                          : undefined
                      }
                      onClick={() => void consult([...checked][0] as string, TABLE_PROMPT)}
                      className={clsx(bulkBtn, 'bg-surface/10 hover:bg-surface/20')}
                    >
                      <Table2 className="h-3.5 w-3.5" aria-hidden /> Convertir en tabla
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setBulk({ kind: 'delete' })}
                      className={clsx(bulkBtn, 'bg-rose/80 hover:bg-rose')}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden /> Borrar
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setChecked(new Set());
                        setBulk(null);
                      }}
                      className={clsx(bulkBtn, 'ml-auto hover:bg-surface/10')}
                    >
                      <X className="h-3.5 w-3.5" aria-hidden /> Quitar selección
                    </button>
                    {busy && (
                      <Loader2
                        className="h-4 w-4 animate-spin motion-reduce:animate-none"
                        aria-hidden
                      />
                    )}
                  </div>
                  {bulk?.kind === 'promote' && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-surface/15 pt-2 text-sm">
                      <label htmlFor="bulk-space">Guardar una copia en</label>
                      <select
                        id="bulk-space"
                        value={bulkSpace}
                        onChange={(e) => setBulkSpace(e.target.value)}
                        className="min-h-8 rounded-pill bg-surface px-3 text-xs font-semibold text-ink"
                      >
                        <option value="">Mis notas privadas</option>
                        {bulk.spaces.map((s) => (
                          <option key={s.id} value={s.name} disabled={!s.writable}>
                            {s.name}
                            {!s.writable ? ' (sin permiso de escritura)' : ''}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void promote([...checked], bulkSpace)}
                        className={clsx(bulkBtn, 'bg-primary hover:bg-primary-strong')}
                      >
                        Guardar <span className="tabular">{checked.size}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setBulk(null)}
                        className={clsx(bulkBtn, 'hover:bg-surface/10')}
                      >
                        Cancelar
                      </button>
                    </div>
                  )}
                  {bulk?.kind === 'delete' && (
                    <div className="flex flex-wrap items-center gap-2 border-t border-surface/15 pt-2 text-sm">
                      <span>
                        ¿Borrar <span className="tabular">{checked.size}</span>{' '}
                        {checked.size === 1 ? 'entrada' : 'entradas'} de la bandeja? Las copias del
                        cerebro y las respuestas del chat se quedan.
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove([...checked])}
                        className={clsx(bulkBtn, 'bg-rose hover:opacity-90')}
                      >
                        Sí, borrar
                      </button>
                      <button
                        type="button"
                        onClick={() => setBulk(null)}
                        className={clsx(bulkBtn, 'hover:bg-surface/10')}
                      >
                        Cancelar
                      </button>
                    </div>
                  )}
                </div>
              )}

              {visible.length === 0 ? (
                <div className="rounded-card border border-dashed border-border-strong p-8 text-center text-sm text-ink-muted">
                  Nada coincide con esos filtros.{' '}
                  <button
                    type="button"
                    onClick={() => setFilters(NO_FILTERS)}
                    className="font-bold text-primary hover:underline"
                  >
                    Quitar filtros
                  </button>
                </div>
              ) : layout === 'list' ? (
                <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
                  <div className="hidden items-center gap-3 border-b border-border bg-surface-2/60 px-4 py-2 text-micro font-semibold text-ink-faint md:flex">
                    <input
                      type="checkbox"
                      aria-label="Seleccionar todas las entradas visibles"
                      checked={allChecked}
                      onChange={() =>
                        setChecked(allChecked ? new Set() : new Set(visible.map((e) => e.id)))
                      }
                      className="h-4 w-4 accent-primary"
                    />
                    <span className="flex-1 pl-11">Nombre</span>
                    <span className="w-28">Llegó</span>
                    <span className="w-20 text-right">Tamaño</span>
                    <span className="w-28">Estado</span>
                  </div>
                  <ul className="divide-y divide-border">
                    {visible.map((entry) => (
                      <EntryRow
                        key={entry.id}
                        entry={entry}
                        status={feedStatus(entry, ctx)}
                        areas={areas[entry.id]}
                        now={now}
                        checked={checked.has(entry.id)}
                        open={openId === entry.id}
                        captures={
                          entry.source_url
                            ? entries.filter((e) => e.source_url === entry.source_url).length
                            : 0
                        }
                        onToggle={() => toggle(entry.id)}
                        onOpen={() => setOpenId(entry.id)}
                      />
                    ))}
                  </ul>
                </div>
              ) : (
                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {visible.map((entry) => (
                    <EntryCard
                      key={entry.id}
                      entry={entry}
                      status={feedStatus(entry, ctx)}
                      areas={areas[entry.id]}
                      now={now}
                      checked={checked.has(entry.id)}
                      onToggle={() => toggle(entry.id)}
                      onOpen={() => setOpenId(entry.id)}
                    />
                  ))}
                </ul>
              )}
            </>
          ))}
      </section>

      {openEntry && (
        <FeedDrawer
          entry={openEntry}
          detail={detail?.id === openEntry.id ? detail : null}
          status={feedStatus(openEntry, ctx)}
          busy={busy}
          activationHref={href(`/activations?source=${encodeURIComponent(openEntry.id)}`)}
          onClose={() => setOpenId(null)}
          onConsult={() => void consult(openEntry.id)}
          onTable={() => void consult(openEntry.id, TABLE_PROMPT)}
          onRefresh={
            openEntry.source_url
              ? () => void submit({ kind: 'url', url: openEntry.source_url ?? '' })
              : null
          }
          onLoadSpaces={() => client.spaces()}
          onPromote={(space) => void promote([openEntry.id], space)}
          onDelete={() => void remove([openEntry.id])}
        />
      )}
    </div>
  );
}

function latestCount(entries: FeedEntry[]): number {
  return filterEntries(entries, NO_FILTERS, { tableSourceIds: new Set() }, new Date()).length;
}

function InboxVsBrain({ href }: { href: (p: string) => string }) {
  return (
    <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr] md:items-stretch">
      <div className="flex gap-3 rounded-card border border-border bg-surface p-4 shadow-card">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted">
          <Lock className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <p className="text-sm font-extrabold text-ink">
            Bandeja <span className="font-semibold text-ink-muted">· temporal y privada</span>
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            Sólo tú la ves. Cada entrada dura <span className="tabular">7</span> días: sirve para
            preguntarle a Cortex ya, sin que se vuelva memoria de la empresa.
          </p>
        </div>
      </div>
      <div className="hidden items-center text-ink-faint md:flex" aria-hidden>
        <ArrowRight className="h-5 w-5" />
      </div>
      <div className="flex gap-3 rounded-card border border-primary/20 bg-primary-soft/50 p-4">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-surface text-primary">
          <Brain className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <p className="text-sm font-extrabold text-ink">
            Cerebro <span className="font-semibold text-ink-muted">· de la empresa</span>
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            Lo que guardas ahí se queda y Cortex lo usa en adelante, con los permisos de cada
            espacio. Elige «Guardar en el cerebro» en una entrada, o{' '}
            <Link href={href('/kb')} className="font-bold text-primary hover:underline">
              abre el cerebro
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}

function StatusStrip({
  counts,
  active,
  onPick,
}: {
  counts: Record<FeedStatus, number>;
  active: FeedStatus | 'all';
  onPick: (s: FeedStatus) => void;
}) {
  return (
    <div className="mb-2 flex flex-wrap gap-1.5" aria-label="Filtrar por estado">
      {(Object.keys(STATUS_LABEL) as FeedStatus[]).map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={active === s}
          onClick={() => onPick(s)}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-micro font-bold transition-shadow',
            STATUS_TONE[s],
            active === s ? 'ring-2 ring-current' : 'opacity-90 hover:opacity-100',
          )}
        >
          <span className="tabular">{counts[s]}</span> {STATUS_LABEL[s].toLowerCase()}
        </button>
      ))}
    </div>
  );
}

function Toolbar({
  filters,
  setFilters,
  layout,
  setLayout,
  filtering,
}: {
  filters: InboxFilters;
  setFilters: React.Dispatch<React.SetStateAction<InboxFilters>>;
  layout: Layout;
  setLayout: (l: Layout) => void;
  filtering: boolean;
}) {
  const set = <K extends keyof InboxFilters>(key: K, value: InboxFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));
  return (
    <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <input
          aria-label="Buscar en la bandeja"
          value={filters.query}
          onChange={(e) => set('query', e.target.value)}
          placeholder="Buscar por nombre o enlace"
          className="min-h-10 w-full rounded-pill border border-border bg-surface pl-9 pr-4 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Tipo"
          value={filters.type}
          onChange={(e) => set('type', e.target.value as FeedType | 'all')}
          className={select}
        >
          <option value="all">Todos los tipos</option>
          {(Object.keys(TYPE_LABEL) as FeedType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select
          aria-label="Fuente"
          value={filters.origin}
          onChange={(e) => set('origin', e.target.value as FeedOrigin | 'all')}
          className={select}
        >
          <option value="all">Todas las fuentes</option>
          {(Object.keys(ORIGIN_LABEL) as FeedOrigin[]).map((o) => (
            <option key={o} value={o}>
              {ORIGIN_LABEL[o]}
            </option>
          ))}
        </select>
        <select
          aria-label="Estado"
          value={filters.status}
          onChange={(e) => set('status', e.target.value as FeedStatus | 'all')}
          className={select}
        >
          <option value="all">Cualquier estado</option>
          {(Object.keys(STATUS_LABEL) as FeedStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <select
          aria-label="Fecha"
          value={filters.date}
          onChange={(e) => set('date', e.target.value as DateRange | 'all')}
          className={select}
        >
          <option value="all">Cualquier fecha</option>
          {(Object.keys(DATE_LABEL) as DateRange[]).map((d) => (
            <option key={d} value={d}>
              {DATE_LABEL[d]}
            </option>
          ))}
        </select>
        <label className="inline-flex min-h-9 items-center gap-2 rounded-pill px-2 text-xs font-semibold text-ink-muted">
          <input
            type="checkbox"
            checked={filters.history}
            onChange={(e) => set('history', e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Capturas anteriores
        </label>
        {filtering && (
          <button
            type="button"
            onClick={() => setFilters(NO_FILTERS)}
            className="text-xs font-bold text-primary hover:underline"
          >
            Quitar filtros
          </button>
        )}
        <div
          className="inline-flex rounded-pill border border-border bg-surface p-0.5"
          aria-label="Cómo ver la bandeja"
        >
          {(
            [
              ['list', List, 'Lista'],
              ['grid', LayoutGrid, 'Cuadrícula'],
            ] as const
          ).map(([id, Icon, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={layout === id}
              aria-label={label}
              title={label}
              onClick={() => setLayout(id)}
              className={clsx(
                'grid h-8 w-8 place-items-center rounded-pill transition-colors',
                layout === id ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink',
              )}
            >
              <Icon className="h-4 w-4" aria-hidden />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

const AREA: Record<string, string> = {
  financial: 'Finanzas',
  administrative: 'Administración',
  commercial: 'Comercial',
  operations: 'Operaciones',
};

function AreaChips({ areas }: { areas?: string[] }) {
  if (!areas) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {(areas.length ? areas : ['']).map((a) => (
        <span
          key={a || 'none'}
          className="rounded-pill bg-primary-soft px-2 py-0.5 text-micro font-bold text-primary"
        >
          {AREA[a] ?? 'Uso por confirmar'}
        </span>
      ))}
    </span>
  );
}

function EntryRow({
  entry,
  status,
  areas,
  now,
  checked,
  open,
  captures,
  onToggle,
  onOpen,
}: {
  entry: FeedEntry;
  status: FeedStatus;
  areas?: string[];
  now: Date;
  checked: boolean;
  open: boolean;
  captures: number;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const type = feedType(entry);
  return (
    <li
      className={clsx(
        'flex items-center gap-3 px-4 py-3 transition-colors',
        checked || open ? 'bg-primary-soft/50' : 'hover:bg-surface-2/50',
      )}
    >
      <input
        type="checkbox"
        aria-label={`Seleccionar ${entry.filename}`}
        checked={checked}
        onChange={onToggle}
        className="h-4 w-4 shrink-0 accent-primary"
      />
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <TypeIcon type={type} size="sm" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-bold text-ink">{entry.filename}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-faint">
            <span>
              {TYPE_LABEL[type]} · {ORIGIN_LABEL[feedOrigin(entry)]}
            </span>
            {captures > 1 && <span className="tabular">{captures} capturas</span>}
            <span className="tabular md:hidden">{shortWhen(entry.created_at, now)}</span>
            <AreaChips areas={areas} />
          </span>
        </span>
      </button>
      <span className="tabular hidden w-28 text-xs text-ink-muted md:block">
        {shortWhen(entry.created_at, now)}
      </span>
      <span className="tabular hidden w-20 text-right text-xs text-ink-muted md:block">
        {formatBytes(entry.byte_size)}
      </span>
      <span className="w-auto shrink-0 md:w-28">
        <span
          className={clsx(
            'inline-flex rounded-pill px-2.5 py-0.5 text-micro font-bold',
            STATUS_TONE[status],
          )}
        >
          {STATUS_LABEL[status]}
        </span>
      </span>
    </li>
  );
}

function EntryCard({
  entry,
  status,
  areas,
  now,
  checked,
  onToggle,
  onOpen,
}: {
  entry: FeedEntry;
  status: FeedStatus;
  areas?: string[];
  now: Date;
  checked: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const type = feedType(entry);
  return (
    <li
      className={clsx(
        'relative flex flex-col gap-3 rounded-card border bg-surface p-4 shadow-card transition-colors',
        checked ? 'border-primary' : 'border-border hover:border-border-strong',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <TypeIcon type={type} />
        <input
          type="checkbox"
          aria-label={`Seleccionar ${entry.filename}`}
          checked={checked}
          onChange={onToggle}
          className="relative z-10 h-4 w-4 accent-primary"
        />
      </div>
      <button
        type="button"
        onClick={onOpen}
        className="text-left after:absolute after:inset-0 focus-visible:outline-none"
      >
        <span className="line-clamp-2 text-sm font-bold text-ink">{entry.filename}</span>
        <span className="mt-1 block text-micro text-ink-faint">
          {TYPE_LABEL[type]} · {ORIGIN_LABEL[feedOrigin(entry)]}
        </span>
      </button>
      <AreaChips areas={areas} />
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-3 text-micro text-ink-faint">
        <span className="tabular">
          {shortWhen(entry.created_at, now)} · {formatBytes(entry.byte_size)}
        </span>
        <span className={clsx('rounded-pill px-2.5 py-0.5 font-bold', STATUS_TONE[status])}>
          {STATUS_LABEL[status]}
        </span>
      </div>
    </li>
  );
}

function EmptyInbox({ onPick }: { onPick: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border-strong bg-surface/60 px-6 py-12 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-card bg-surface text-ink-faint shadow-card">
        <Inbox className="h-6 w-6" aria-hidden />
      </span>
      <p className="text-base font-extrabold text-ink">Tu bandeja está vacía</p>
      <p className="max-w-md text-sm leading-relaxed text-ink-muted">
        Suelta aquí un Excel de ventas, el PDF de un contrato o pega el enlace de una hoja. Cortex
        lo lee, te dice para qué sirve y tú decides si guardarlo.
      </p>
      <button
        type="button"
        onClick={onPick}
        className="inline-flex min-h-10 items-center gap-1.5 rounded-pill bg-primary px-5 text-sm font-bold text-white hover:bg-primary-strong"
      >
        Traer algo <ArrowRight className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
