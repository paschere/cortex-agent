'use client';

import {
  type ConnectedSource,
  type SourcesHealth,
  type SyncHandle,
  summarizeSources,
} from '@/lib/sources/overview';
import { workspaceHref } from '@/lib/workspace-context';
import { clsx } from 'clsx';
import {
  ArrowRight,
  CircleCheck,
  Clock,
  Loader2,
  Plus,
  RefreshCw,
  TriangleAlert,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { IconTile, KIND_ICON, KIND_TONE, STATUS_DOT, STATUS_PILL } from './visuals';

/**
 * «CONECTADO»: todo lo que la empresa ya trae a Cortex, como tarjetas con las
 * mismas cinco respuestas —qué trae, cuándo fue la última vez, cuánto, qué le
 * pasa y de quién es—, más el resumen de salud arriba («6 conectadas · 1 con
 * error») que también filtra.
 *
 * Las acciones llegan como props (server actions en la página, de mentira en
 * el fixture de /v), así que este componente no sabe de bases de datos.
 */

type Result = { ok: true; note?: string } | { ok: false; error: string };

export interface SourceSyncActions {
  syncSource: (input: { kind: 'drive_folder' | 'table_sync'; id: string }) => Promise<Result>;
  syncAccounting: (input: { provider: string }) => Promise<Result>;
  /** Una fuente de la bandeja; por defecto, POST /api/feed/sources. */
  refreshFeedSource?: (id: string) => Promise<Result>;
}

function httpRefresh(workspaceId: string | null) {
  return async (id: string): Promise<Result> => {
    const url = workspaceId ? workspaceHref(workspaceId, '/api/feed/sources') : '/api/feed/sources';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'refresh', id }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error ?? 'No se pudo actualizar la fuente.' };
    return { ok: true, note: 'Actualizada.' };
  };
}

function scoped(workspaceId: string | null, href: string): string {
  if (!workspaceId || !href.startsWith('/')) return href;
  return workspaceHref(workspaceId, href);
}

type Filter = 'all' | 'problems';

export function ConnectedSources({
  sources,
  unread,
  actions,
  workspaceId,
  connectAnchor = '#conecta',
}: {
  sources: ConnectedSource[];
  /** Lecturas que fallaron: se dicen, nunca se pintan como «nada». */
  unread: string[];
  actions: SourceSyncActions;
  workspaceId: string | null;
  connectAnchor?: string;
}) {
  const health = useMemo(() => summarizeSources(sources), [sources]);
  const [filter, setFilter] = useState<Filter>('all');
  const problems = health.errors + health.attention;
  const visible =
    filter === 'problems'
      ? sources.filter((s) => s.tone === 'error' || s.tone === 'attention')
      : sources;

  return (
    <section aria-labelledby="conectado-title" className="flex flex-col gap-4">
      <HealthSummary
        health={health}
        filter={filter}
        onFilter={(f) => setFilter(f)}
        connectAnchor={connectAnchor}
      />

      {unread.length > 0 && (
        <output className="flex items-start gap-2 rounded-card border border-amber/30 bg-amber-soft px-4 py-3 text-xs leading-relaxed text-amber">
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            No se pudo leer {unread.join(', ')}. Lo que esté conectado ahí sigue conectado; vuelve a
            cargar la página en un momento.
          </span>
        </output>
      )}

      {sources.length === 0 ? (
        <EmptyConnected connectAnchor={connectAnchor} />
      ) : (
        <ul
          className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"
          aria-label={filter === 'problems' ? 'Conexiones con problemas' : 'Conexiones'}
        >
          {visible.map((source) => (
            <li key={source.key} className="flex">
              <SourceStatusCard source={source} actions={actions} workspaceId={workspaceId} />
            </li>
          ))}
          {filter === 'problems' && problems === 0 && (
            <li className="text-sm text-ink-muted">Nada pide atención. Todo está al día.</li>
          )}
        </ul>
      )}
    </section>
  );
}

function HealthSummary({
  health,
  filter,
  onFilter,
  connectAnchor,
}: {
  health: SourcesHealth;
  filter: Filter;
  onFilter: (f: Filter) => void;
  connectAnchor: string;
}) {
  const problems = health.errors + health.attention;
  const pills: Array<{ n: number; label: string; tone: keyof typeof STATUS_DOT }> = [
    { n: health.ok, label: 'al día', tone: 'ok' },
    { n: health.working, label: 'arrancando', tone: 'working' },
    { n: health.errors, label: 'con error', tone: 'error' },
    { n: health.attention, label: 'por revisar', tone: 'attention' },
    { n: health.paused, label: 'en pausa', tone: 'paused' },
  ];
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 id="conectado-title" className="text-lg font-extrabold tracking-tight text-ink">
          Conectado
        </h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-muted">
          {health.total === 0 ? (
            <span>Nada conectado todavía.</span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1.5 font-semibold text-ink">
                {problems === 0 ? (
                  <CircleCheck className="h-4 w-4 text-emerald" aria-hidden />
                ) : (
                  <TriangleAlert
                    className={clsx('h-4 w-4', health.errors ? 'text-rose' : 'text-amber')}
                    aria-hidden
                  />
                )}
                <span className="tabular">{health.label}</span>
              </span>
              <span className="flex flex-wrap gap-1.5" aria-hidden>
                {pills
                  .filter((p) => p.n > 0)
                  .map((p) => (
                    <span
                      key={p.tone}
                      className="inline-flex items-center gap-1.5 rounded-pill bg-surface px-2.5 py-0.5 text-micro font-semibold text-ink-muted shadow-card"
                    >
                      <span className={clsx('h-1.5 w-1.5 rounded-full', STATUS_DOT[p.tone])} />
                      <span className="tabular">{p.n}</span> {p.label}
                    </span>
                  ))}
              </span>
            </>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {problems > 0 && (
          <fieldset
            className="inline-flex rounded-pill border border-border bg-surface p-0.5"
            aria-label="Filtrar conexiones"
          >
            {(
              [
                ['all', 'Todas'],
                ['problems', `Con problemas · ${problems}`],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={filter === value}
                onClick={() => onFilter(value)}
                className={clsx(
                  'rounded-pill px-3 py-1 text-xs font-semibold transition-colors',
                  filter === value ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink',
                )}
              >
                <span className="tabular">{label}</span>
              </button>
            ))}
          </fieldset>
        )}
        <a
          href={connectAnchor}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 text-xs font-bold text-ink transition-colors hover:bg-surface-2"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden /> Conectar algo nuevo
        </a>
      </div>
    </div>
  );
}

function EmptyConnected({ connectAnchor }: { connectAnchor: string }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-card border border-dashed border-border-strong bg-surface/60 p-6 sm:flex-row sm:items-center sm:justify-between">
      <div className="max-w-xl">
        <p className="text-base font-extrabold text-ink">Todavía no hay nada conectado</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">
          Cortex trabaja con lo que le conectes. Empieza por lo que más usas: tu correo, tu programa
          contable o la carpeta donde llegan las facturas.
        </p>
      </div>
      <a
        href={connectAnchor}
        className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-pill bg-primary px-5 text-sm font-bold text-white transition-colors hover:bg-primary-strong"
      >
        Elegir qué conectar <ArrowRight className="h-4 w-4" aria-hidden />
      </a>
    </div>
  );
}

export function SourceStatusCard({
  source,
  actions,
  workspaceId,
}: {
  source: ConnectedSource;
  actions: SourceSyncActions;
  workspaceId: string | null;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<Result | null>(null);

  function runSync(handle: SyncHandle) {
    setResult(null);
    start(async () => {
      let r: Result;
      try {
        if (handle.kind === 'accounting')
          r = await actions.syncAccounting({ provider: handle.provider });
        else if (handle.kind === 'feed_source')
          r = await (actions.refreshFeedSource ?? httpRefresh(workspaceId))(handle.id);
        else r = await actions.syncSource({ kind: handle.kind, id: handle.id });
      } catch {
        r = { ok: false, error: 'No se pudo pedir la sincronización.' };
      }
      setResult(r);
      if (r.ok) router.refresh();
    });
  }

  const problem = source.problem;
  const fix = problem?.fix;
  const fixIsSync = !!fix && 'sync' in fix;
  const syncLabel = source.kind === 'feed_source' ? 'Actualizar ahora' : 'Sincronizar ahora';

  return (
    <article
      className={clsx(
        'flex w-full flex-col gap-3 rounded-card border bg-surface p-4 shadow-card',
        source.tone === 'error' ? 'border-rose/30' : 'border-border',
      )}
      aria-label={`${source.name}: ${source.status}`}
    >
      <header className="flex items-start gap-3">
        <IconTile icon={KIND_ICON[source.kind]} tone={KIND_TONE[source.kind]} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-extrabold text-ink" title={source.name}>
            {source.name}
          </h3>
          {source.detail && (
            <p className="truncate text-xs text-ink-muted" title={source.detail}>
              {source.detail}
            </p>
          )}
        </div>
        <span
          className={clsx(
            'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2.5 py-0.5 text-micro font-bold',
            STATUS_PILL[source.tone],
          )}
        >
          {source.tone === 'working' ? (
            <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <span className={clsx('h-1.5 w-1.5 rounded-full', STATUS_DOT[source.tone])} />
          )}
          {source.status}
        </span>
      </header>

      <p className="text-xs leading-relaxed text-ink-muted">{source.brings}</p>

      {problem && (
        <div
          className={clsx(
            'rounded-sm px-3 py-2.5 text-xs leading-relaxed',
            source.tone === 'error' ? 'bg-rose-soft text-ink' : 'bg-amber-soft text-ink',
          )}
        >
          <p className="flex items-start gap-1.5">
            <TriangleAlert
              className={clsx(
                'mt-0.5 h-3.5 w-3.5 shrink-0',
                source.tone === 'error' ? 'text-rose' : 'text-amber',
              )}
              aria-hidden
            />
            <span>{problem.text}</span>
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 pl-5">
            {fix &&
              (fixIsSync ? (
                source.sync && (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => source.sync && runSync(source.sync)}
                    className="inline-flex items-center gap-1.5 rounded-pill bg-ink px-3 py-1 text-xs font-bold text-surface transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={clsx(
                        'h-3 w-3',
                        pending && 'animate-spin motion-reduce:animate-none',
                      )}
                      aria-hidden
                    />
                    {pending ? 'Pidiendo…' : fix.label}
                  </button>
                )
              ) : (
                <FixLink href={scoped(workspaceId, (fix as { href: string }).href)}>
                  {fix.label}
                </FixLink>
              ))}
            {problem.raw && (
              <details className="text-micro text-ink-muted">
                <summary className="cursor-pointer font-semibold hover:text-ink">
                  Lo que dijo el sistema
                </summary>
                <p className="mt-1 break-words font-mono">{problem.raw}</p>
              </details>
            )}
          </div>
        </div>
      )}

      <dl className="mt-auto grid gap-1.5 text-micro text-ink-faint">
        {(source.lastSyncLabel || source.items) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {source.lastSyncLabel && (
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" aria-hidden />
                <dt className="sr-only">Última sincronización</dt>
                <dd className="tabular">{source.lastSyncLabel}</dd>
              </span>
            )}
            {source.items && (
              <span className="inline-flex items-center gap-1">
                <dt className="sr-only">Lo que trajo</dt>
                <dd className="tabular text-ink-muted">{source.items}</dd>
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-1">
          <Users className="h-3 w-3" aria-hidden />
          <dt className="sr-only">De quién es</dt>
          <dd>{source.owner}</dd>
        </div>
      </dl>

      {(source.sync || source.manage || result) && (
        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          {result ? (
            <output
              className={clsx('text-micro font-semibold', result.ok ? 'text-emerald' : 'text-rose')}
            >
              {result.ok ? (result.note ?? 'Listo.') : result.error}
            </output>
          ) : (
            <span />
          )}
          <span className="flex flex-wrap items-center gap-2">
            {source.sync && !fixIsSync && (
              <button
                type="button"
                disabled={pending}
                onClick={() => source.sync && runSync(source.sync)}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 text-xs font-bold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
              >
                <RefreshCw
                  className={clsx(
                    'h-3.5 w-3.5',
                    pending && 'animate-spin motion-reduce:animate-none',
                  )}
                  aria-hidden
                />
                {pending ? 'Pidiendo…' : syncLabel}
              </button>
            )}
            {source.manage && (
              <FixLink href={scoped(workspaceId, source.manage.href)} quiet>
                {source.manage.label}
              </FixLink>
            )}
          </span>
        </footer>
      )}
    </article>
  );
}

function FixLink({
  href,
  children,
  quiet,
}: {
  href: string;
  children: React.ReactNode;
  quiet?: boolean;
}) {
  const cls = quiet
    ? 'inline-flex min-h-8 items-center gap-1 px-1 text-xs font-bold text-primary hover:underline'
    : 'inline-flex items-center gap-1 rounded-pill bg-ink px-3 py-1 text-xs font-bold text-surface transition-opacity hover:opacity-90';
  // El permiso de un proveedor y las anclas no son rutas de la app: enlace normal.
  if (href.startsWith('/api/') || href.startsWith('#'))
    return (
      <a href={href} className={cls}>
        {children}
        {quiet && <ArrowRight className="h-3 w-3" aria-hidden />}
      </a>
    );
  return (
    <Link href={href} className={cls}>
      {children}
      {quiet && <ArrowRight className="h-3 w-3" aria-hidden />}
    </Link>
  );
}
