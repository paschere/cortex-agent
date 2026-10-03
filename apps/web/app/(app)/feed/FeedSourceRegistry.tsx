'use client';

import { IconTile } from '@/components/sources/visuals';
import type { FeedEntry } from '@/lib/feed/shared';
import type { FeedSourceSummary } from '@/lib/feed/source-management';
import { clsx } from 'clsx';
import { Braces, Combine, FileSpreadsheet, FileText, Globe, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { SourceReliability } from './SourceReliability';
import type { FeedClient } from './feed-client';

/**
 * LAS FUENTES QUE SE ACTUALIZAN: una hoja, una página, una API o un cruce que
 * se vuelven a capturar, y los archivos y textos que reciben versiones. Antes
 * era un desplegable al pie de la bandeja; ahora es su propia pestaña, con la
 * misma salud de siempre (`sourceHealth`) dicha en una píldora.
 */

const KIND: Record<
  FeedSourceSummary['kind'],
  { label: string; icon: typeof Globe; tone: 'primary' | 'emerald' | 'neutral' }
> = {
  google_sheet: { label: 'Google Sheets', icon: FileSpreadsheet, tone: 'emerald' },
  combined: { label: 'Cruce de fuentes', icon: Combine, tone: 'primary' },
  api: { label: 'API', icon: Braces, tone: 'primary' },
  file: { label: 'Archivo', icon: FileText, tone: 'neutral' },
  text: { label: 'Texto', icon: FileText, tone: 'neutral' },
  url: { label: 'Página web', icon: Globe, tone: 'neutral' },
};

const HEALTH_PILL: Record<string, string> = {
  healthy: 'bg-emerald-soft text-emerald',
  stale: 'bg-amber-soft text-amber',
  incomplete: 'bg-amber-soft text-amber',
  review: 'bg-amber-soft text-amber',
  expired: 'bg-amber-soft text-amber',
  missing: 'bg-rose-soft text-rose',
  error: 'bg-rose-soft text-rose',
  disconnected: 'bg-surface-2 text-ink-muted',
};

const link = 'text-xs font-bold text-primary hover:underline disabled:opacity-50';

export function FeedSourceRegistry({
  client,
  refreshKey,
  workspaceId,
  onCaptured,
  onAddVersion,
  onCount,
}: {
  client: FeedClient;
  workspaceId: string;
  refreshKey: string;
  onCaptured: (entry?: FeedEntry) => void;
  onAddVersion: (source: { id: string; kind: 'file' | 'text'; name: string }) => void;
  onCount?: (n: number) => void;
}) {
  const [sources, setSources] = useState<FeedSourceSummary[] | null>(null);
  const [impactTruncated, setImpactTruncated] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const body = await client.sources();
    setSources(body.sources);
    setImpactTruncated(body.impactTruncated);
    onCount?.(body.sources.length);
  }, [client, onCount]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: una captura nueva cambia la salud de las fuentes.
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'No se pudieron cargar.'));
  }, [load, refreshKey]);

  async function act(body: unknown, id: string) {
    setWorking(id);
    setError(null);
    try {
      const data = await client.sourceAction(body);
      if (data.capture?.entry) onCaptured(data.capture.entry);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo actualizar la fuente.');
    } finally {
      setWorking(null);
    }
  }

  if (sources === null && !error)
    return <p className="py-8 text-center text-sm text-ink-muted">Cargando las fuentes…</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-ink-muted">
        Lo que se vuelve a capturar: hojas, páginas, APIs y cruces. Los archivos y textos reciben
        versiones nuevas. Las conexiones de toda la empresa (Drive, programa contable, banco) están
        en Datos y conexiones.
      </p>
      {impactTruncated && (
        <p className="text-xs text-ink-muted">
          Los conteos de activaciones muestran una vista parcial.
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-sm bg-rose-soft px-3 py-2 text-sm text-ink">
          {error}
        </p>
      )}
      {sources && sources.length === 0 ? (
        <div className="rounded-card border border-dashed border-border-strong p-6 text-center text-sm text-ink-muted">
          Todavía no tienes fuentes que se actualicen. Pega el enlace de una hoja o conecta una API
          y aparecerán aquí.
        </div>
      ) : (
        <ul className="grid gap-3 lg:grid-cols-2">
          {(sources ?? []).map((source) => {
            const k = KIND[source.kind] ?? KIND.url;
            const pill = source.health
              ? (HEALTH_PILL[source.health.state] ?? 'bg-surface-2 text-ink-muted')
              : source.status === 'error'
                ? 'bg-rose-soft text-rose'
                : 'bg-surface-2 text-ink-muted';
            return (
              <li
                key={source.id}
                className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card"
              >
                <div className="flex items-start gap-3">
                  <IconTile icon={k.icon} tone={k.tone} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-extrabold text-ink" title={source.name}>
                      {source.name}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {k.label}
                      {source.lastCheckedAt && (
                        <>
                          {' · revisada '}
                          <span className="tabular">
                            {new Date(source.lastCheckedAt).toLocaleString('es-CO', {
                              day: 'numeric',
                              month: 'short',
                              hour: '2-digit',
                              minute: '2-digit',
                              timeZone: 'America/Bogota',
                            })}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  <span
                    className={clsx(
                      'shrink-0 rounded-pill px-2.5 py-0.5 text-micro font-bold',
                      pill,
                    )}
                  >
                    {source.health?.label ?? (source.enabled ? 'Conectada' : 'Desconectada')}
                  </span>
                </div>
                {source.health && (
                  <p className="text-xs text-ink-muted">
                    {source.health.detail} ·{' '}
                    <span className="tabular">{source.health.affectedActivations}</span>{' '}
                    {source.health.affectedActivations === 1
                      ? 'activación vinculada'
                      : 'activaciones vinculadas'}
                  </p>
                )}
                {source.error && (
                  <p className="rounded-sm bg-rose-soft px-3 py-2 text-xs text-ink">
                    {source.error}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
                  {['url', 'google_sheet', 'api', 'combined'].includes(source.kind) &&
                    source.enabled && (
                      <button
                        type="button"
                        disabled={working === source.id}
                        onClick={() => void act({ action: 'refresh', id: source.id }, source.id)}
                        className={clsx(link, 'inline-flex items-center gap-1')}
                      >
                        <RefreshCw
                          className={clsx(
                            'h-3.5 w-3.5',
                            working === source.id && 'animate-spin motion-reduce:animate-none',
                          )}
                          aria-hidden
                        />
                        Actualizar captura
                      </button>
                    )}
                  {source.enabled && (source.kind === 'file' || source.kind === 'text') && (
                    <button
                      type="button"
                      disabled={working === source.id}
                      onClick={() =>
                        onAddVersion({
                          id: source.id,
                          kind: source.kind as 'file' | 'text',
                          name: source.name,
                        })
                      }
                      className={link}
                    >
                      Añadir versión
                    </button>
                  )}
                  {source.enabled ? (
                    <button
                      type="button"
                      disabled={working === source.id}
                      onClick={() => void act({ action: 'disable', id: source.id }, source.id)}
                      className="text-xs font-bold text-rose hover:underline disabled:opacity-50"
                    >
                      Desconectar
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={working === source.id}
                      onClick={() => void act({ action: 'reconnect', id: source.id }, source.id)}
                      className={link}
                    >
                      Reconectar
                    </button>
                  )}
                  <SourceReliability source={source} workspaceId={workspaceId} onChanged={load} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
