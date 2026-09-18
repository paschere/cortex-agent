'use client';

import { workspaceHref } from '@/lib/workspace-context';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Combine,
  Loader2,
  RefreshCw,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';

type TableSummary = { index: number; name: string; rowCount: number; headers: string[] };
type SourceSummary = {
  id: string;
  kind: string;
  name: string;
  latestAttachmentId: string | null;
  status: string;
  enabled: boolean;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  error: string | null;
  tables: TableSummary[];
};
type ColumnRef = { sourceId: string; sheetIndex: number; column: number; header: string };
type CombinedConfig = {
  version: 1;
  sourceIds: string[];
  approvedHeaders: Array<{ sourceId: string; sheetIndex: number; headers: string[] }>;
  mappings: Array<{ left: ColumnRef; right: ColumnRef }>;
  maxRows: number;
};
type Preview = {
  status: 'ready' | 'blocked';
  headers: string[];
  rows: Array<{
    rowIndex: number;
    status: 'matched' | 'unmatched' | 'ambiguous';
    key: string | null;
    provenance: Array<{ sourceName: string; rowIndex: number; quote: string }>;
    reasons: string[];
  }>;
  summary: { matched: number; unmatched: number; ambiguous: number; truncated: boolean };
  errors: string[];
};
type Suggestion = {
  id: string;
  title: string;
  type: 'activation' | 'combined';
  purpose: string;
  sourceIds: string[];
  sourceNames: string[];
  config?: CombinedConfig;
  reason: string;
  editable: true;
  activated: false;
};

const inputClass =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const buttonClass =
  'inline-flex items-center justify-center gap-2 rounded-sm px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50';

function tableFor(source: SourceSummary | undefined, index: number) {
  return source?.tables.find((table) => table.index === index) ?? source?.tables[0] ?? null;
}

function columnOptions(headers: string[], prefix: string) {
  const occurrences = new Map<string, number>();
  let column = 0;
  return headers.map((header) => {
    const occurrence = occurrences.get(header) ?? 0;
    occurrences.set(header, occurrence + 1);
    const option = { column, header, key: `${prefix}-${header}-${occurrence}` };
    column += 1;
    return option;
  });
}

function buildConfig(
  left: SourceSummary | undefined,
  right: SourceSummary | undefined,
  leftTable: TableSummary | null,
  rightTable: TableSummary | null,
  leftColumn: number,
  rightColumn: number,
  third: SourceSummary | undefined,
  thirdTable: TableSummary | null,
  thirdColumn: number,
): CombinedConfig | null {
  if (!left || !right || !leftTable || !rightTable) return null;
  const leftHeader = leftTable.headers[leftColumn];
  const rightHeader = rightTable.headers[rightColumn];
  if (!leftHeader || !rightHeader) return null;
  const approvedHeaders = [
    { sourceId: left.id, sheetIndex: leftTable.index, headers: leftTable.headers },
    { sourceId: right.id, sheetIndex: rightTable.index, headers: rightTable.headers },
  ];
  const mappings = [
    {
      left: {
        sourceId: left.id,
        sheetIndex: leftTable.index,
        column: leftColumn,
        header: leftHeader,
      },
      right: {
        sourceId: right.id,
        sheetIndex: rightTable.index,
        column: rightColumn,
        header: rightHeader,
      },
    },
  ];
  const sourceIds = [left.id, right.id];
  if (third) {
    if (!thirdTable) return null;
    const thirdHeader = thirdTable.headers[thirdColumn];
    if (!thirdHeader) return null;
    approvedHeaders.push({
      sourceId: third.id,
      sheetIndex: thirdTable.index,
      headers: thirdTable.headers,
    });
    mappings.push({
      left: {
        sourceId: left.id,
        sheetIndex: leftTable.index,
        column: leftColumn,
        header: leftHeader,
      },
      right: {
        sourceId: third.id,
        sheetIndex: thirdTable.index,
        column: thirdColumn,
        header: thirdHeader,
      },
    });
    sourceIds.push(third.id);
  }
  return {
    version: 1,
    sourceIds,
    approvedHeaders,
    mappings,
    maxRows: 1000,
  };
}

export function SourceIntelligence({
  workspaceId,
  refreshKey = '',
  onCaptured,
}: {
  workspaceId: string;
  refreshKey?: string;
  onCaptured?: () => void;
}) {
  const href = useCallback((path: string) => workspaceHref(workspaceId, path), [workspaceId]);
  const [sources, setSources] = useState<SourceSummary[]>([]);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [leftId, setLeftId] = useState('');
  const [rightId, setRightId] = useState('');
  const [thirdId, setThirdId] = useState('');
  const [leftSheetIndex, setLeftSheetIndex] = useState(0);
  const [rightSheetIndex, setRightSheetIndex] = useState(0);
  const [thirdSheetIndex, setThirdSheetIndex] = useState(0);
  const [leftColumn, setLeftColumn] = useState(0);
  const [rightColumn, setRightColumn] = useState(0);
  const [thirdColumn, setThirdColumn] = useState(0);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [name, setName] = useState('Cruce de fuentes');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const usableSources = useMemo(
    () =>
      sources.filter(
        (source) => source.kind !== 'combined' && source.enabled && source.tables.length,
      ),
    [sources],
  );
  const left = usableSources.find((source) => source.id === leftId);
  const right = usableSources.find((source) => source.id === rightId);
  const third = usableSources.find((source) => source.id === thirdId);
  const leftTable = tableFor(left, leftSheetIndex);
  const rightTable = tableFor(right, rightSheetIndex);
  const thirdTable = tableFor(third, thirdSheetIndex);
  const config = buildConfig(
    left,
    right,
    leftTable,
    rightTable,
    leftColumn,
    rightColumn,
    third,
    thirdTable,
    thirdColumn,
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sourceResponse, suggestionResponse] = await Promise.all([
        fetch(href('/api/feed/combined-sources')),
        fetch(href('/api/feed/suggestions')),
      ]);
      const sourceBody = await sourceResponse.json();
      const suggestionBody = await suggestionResponse.json();
      if (!sourceResponse.ok)
        throw new Error(sourceBody.error ?? 'No se pudieron cargar las fuentes.');
      if (!suggestionResponse.ok)
        throw new Error(suggestionBody.error ?? 'No se pudieron cargar sugerencias.');
      const nextSources = (sourceBody.sources ?? []) as SourceSummary[];
      setSources(nextSources);
      setSuggestions((suggestionBody.proposals ?? []) as Suggestion[]);
      const available = nextSources.filter(
        (source) => source.kind !== 'combined' && source.enabled && source.tables.length,
      );
      setLeftId((current) =>
        available.some((source) => source.id === current) ? current : (available[0]?.id ?? ''),
      );
      setRightId((current) => {
        const first = available[0]?.id;
        return available.some((source) => source.id === current) && current !== first
          ? current
          : (available.find((source) => source.id !== first)?.id ?? '');
      });
      setThirdId((current) =>
        available.some((source) => source.id === current) &&
        current !== available[0]?.id &&
        current !== available[1]?.id
          ? current
          : '',
      );
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'No se pudo cargar inteligencia de fuentes.',
      );
    } finally {
      setLoading(false);
    }
  }, [href]);

  useEffect(() => {
    void refreshKey;
    void load();
  }, [load, refreshKey]);

  async function previewSources() {
    if (!config) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(href('/api/feed/combined-sources'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'preview', config }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'No se pudo simular la combinación.');
      setPreview(body.preview as Preview);
    } catch (previewError) {
      setError(
        previewError instanceof Error ? previewError.message : 'No se pudo simular la combinación.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function saveSources() {
    if (!config || !preview || preview.status !== 'ready') return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(href('/api/feed/combined-sources'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save', name, config }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? 'No se pudo guardar la combinación.');
      setNotice(
        body.deduplicated
          ? 'La captura actual ya existía; se reutilizó su procedencia.'
          : 'Combinación guardada como fuente privada de Feed.',
      );
      onCaptured?.();
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : 'No se pudo guardar la combinación.',
      );
    } finally {
      setBusy(false);
    }
  }

  function useSuggestion(suggestion: Suggestion) {
    if (suggestion.type !== 'combined' || !suggestion.config) return;
    const [nextLeft, nextRight, nextThird] = suggestion.config.sourceIds;
    const mapping = suggestion.config.mappings[0];
    const thirdMapping = suggestion.config.mappings[1];
    setLeftId(nextLeft ?? '');
    setRightId(nextRight ?? '');
    setThirdId(nextThird ?? '');
    setLeftSheetIndex(mapping?.left.sheetIndex ?? 0);
    setRightSheetIndex(mapping?.right.sheetIndex ?? 0);
    setThirdSheetIndex(thirdMapping?.right.sheetIndex ?? 0);
    setLeftColumn(mapping?.left.column ?? 0);
    setRightColumn(mapping?.right.column ?? 0);
    setThirdColumn(thirdMapping?.right.column ?? 0);
    setPreview(null);
    setNotice('Propuesta cargada para editar. Simúlala y guárdala cuando revises la clave.');
  }

  return (
    <section
      className="mt-6 overflow-hidden rounded-card border border-border bg-surface shadow-card"
      aria-labelledby="source-intelligence-title"
    >
      <div className="border-b border-border bg-surface-2/60 px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-primary">
              <Combine className="h-4 w-4" aria-hidden /> Inteligencia privada de Feed
            </p>
            <h2
              id="source-intelligence-title"
              className="mt-1 text-lg font-bold tracking-tight text-ink"
            >
              Cruzar fuentes con una clave revisada
            </h2>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed text-ink-muted">
              Selecciona hasta tres fuentes persistentes y confirma una columna exacta. Las
              coincidencias permanecen privadas, con fila y cita de cada origen.
            </p>
          </div>
          <button
            type="button"
            className={`${buttonClass} border border-border-strong bg-surface text-ink`}
            onClick={() => void load()}
            disabled={loading || busy}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden />{' '}
            Actualizar
          </button>
        </div>
      </div>

      <div className="grid gap-5 p-5 sm:p-6 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.7fr)]">
        <div className="min-w-0">
          {error ? (
            <div
              className="mb-4 flex items-start gap-2 rounded-sm border border-rose/30 bg-rose-soft px-3 py-3 text-sm text-ink"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose" aria-hidden /> {error}
            </div>
          ) : null}
          {notice ? (
            <p className="mb-4 rounded-sm border border-emerald/30 bg-emerald-soft px-3 py-3 text-sm text-ink">
              {notice}
            </p>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <fieldset className="min-w-0 rounded-sm border border-border p-4">
              <legend className="px-1 text-sm font-bold text-ink">Fuente principal</legend>
              <label
                className="mt-2 block text-xs font-semibold text-ink-muted"
                htmlFor="combined-left-source"
              >
                Fuente
              </label>
              <select
                id="combined-left-source"
                className={`${inputClass} mt-1`}
                value={leftId}
                onChange={(event) => {
                  setLeftId(event.target.value);
                  setLeftSheetIndex(0);
                  setLeftColumn(0);
                }}
                disabled={loading || busy}
              >
                <option value="">Selecciona una fuente</option>
                {usableSources
                  .filter((source) => source.id !== rightId && source.id !== thirdId)
                  .map((source) => (
                    <option value={source.id} key={source.id}>
                      {source.name} · {source.kind}
                    </option>
                  ))}
              </select>
              <label
                className="mt-3 block text-xs font-semibold text-ink-muted"
                htmlFor="combined-left-sheet"
              >
                Hoja
              </label>
              <select
                id="combined-left-sheet"
                className={`${inputClass} mt-1`}
                value={leftSheetIndex}
                onChange={(event) => {
                  setLeftSheetIndex(Number(event.target.value));
                  setLeftColumn(0);
                }}
                disabled={!left}
              >
                {(left?.tables ?? []).map((table) => (
                  <option value={table.index} key={table.index}>
                    {table.name} · {table.rowCount} filas
                  </option>
                ))}
              </select>
              <label
                className="mt-3 block text-xs font-semibold text-ink-muted"
                htmlFor="combined-left-column"
              >
                Clave exacta
              </label>
              <select
                id="combined-left-column"
                className={`${inputClass} mt-1`}
                value={leftColumn}
                onChange={(event) => setLeftColumn(Number(event.target.value))}
                disabled={!leftTable}
              >
                {(leftTable?.headers ?? []).map((header, index) => (
                  <option value={index} key={`left-${header}`}>
                    {header}
                  </option>
                ))}
              </select>
            </fieldset>

            <fieldset className="min-w-0 rounded-sm border border-border p-4">
              <legend className="px-1 text-sm font-bold text-ink">Fuente secundaria</legend>
              <label
                className="mt-2 block text-xs font-semibold text-ink-muted"
                htmlFor="combined-right-source"
              >
                Fuente
              </label>
              <select
                id="combined-right-source"
                className={`${inputClass} mt-1`}
                value={rightId}
                onChange={(event) => {
                  setRightId(event.target.value);
                  setRightSheetIndex(0);
                  setRightColumn(0);
                }}
                disabled={loading || busy}
              >
                <option value="">Selecciona una fuente</option>
                {usableSources
                  .filter((source) => source.id !== leftId && source.id !== thirdId)
                  .map((source) => (
                    <option value={source.id} key={source.id}>
                      {source.name} · {source.kind}
                    </option>
                  ))}
              </select>
              <label
                className="mt-3 block text-xs font-semibold text-ink-muted"
                htmlFor="combined-right-sheet"
              >
                Hoja
              </label>
              <select
                id="combined-right-sheet"
                className={`${inputClass} mt-1`}
                value={rightSheetIndex}
                onChange={(event) => {
                  setRightSheetIndex(Number(event.target.value));
                  setRightColumn(0);
                }}
                disabled={!right}
              >
                {(right?.tables ?? []).map((table) => (
                  <option value={table.index} key={table.index}>
                    {table.name} · {table.rowCount} filas
                  </option>
                ))}
              </select>
              <label
                className="mt-3 block text-xs font-semibold text-ink-muted"
                htmlFor="combined-right-column"
              >
                Clave exacta
              </label>
              <select
                id="combined-right-column"
                className={`${inputClass} mt-1`}
                value={rightColumn}
                onChange={(event) => setRightColumn(Number(event.target.value))}
                disabled={!rightTable}
              >
                {(rightTable?.headers ?? []).map((header, index) => (
                  <option value={index} key={`right-${header}`}>
                    {header}
                  </option>
                ))}
              </select>
            </fieldset>

            <fieldset className="min-w-0 rounded-sm border border-border p-4 md:col-span-2">
              <legend className="px-1 text-sm font-bold text-ink">Tercera fuente opcional</legend>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                Usa la misma clave de la fuente principal. Déjala vacía para cruzar sólo dos
                fuentes.
              </p>
              <label
                className="mt-2 block text-xs font-semibold text-ink-muted"
                htmlFor="combined-third-source"
              >
                Fuente
              </label>
              <select
                id="combined-third-source"
                className={`${inputClass} mt-1`}
                value={thirdId}
                onChange={(event) => {
                  setThirdId(event.target.value);
                  setThirdSheetIndex(0);
                  setThirdColumn(0);
                }}
                disabled={loading || busy || usableSources.length < 3}
              >
                <option value="">Sin tercera fuente</option>
                {usableSources
                  .filter((source) => source.id !== leftId && source.id !== rightId)
                  .map((source) => (
                    <option value={source.id} key={source.id}>
                      {source.name} · {source.kind}
                    </option>
                  ))}
              </select>
              {third ? (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  <label
                    className="block text-xs font-semibold text-ink-muted"
                    htmlFor="combined-third-sheet"
                  >
                    Hoja
                    <select
                      id="combined-third-sheet"
                      className={`${inputClass} mt-1`}
                      value={thirdSheetIndex}
                      onChange={(event) => {
                        setThirdSheetIndex(Number(event.target.value));
                        setThirdColumn(0);
                      }}
                      disabled={!third}
                    >
                      {(third.tables ?? []).map((table) => (
                        <option value={table.index} key={table.index}>
                          {table.name} · {table.rowCount} filas
                        </option>
                      ))}
                    </select>
                  </label>
                  <label
                    className="block text-xs font-semibold text-ink-muted"
                    htmlFor="combined-third-column"
                  >
                    Clave exacta
                    <select
                      id="combined-third-column"
                      className={`${inputClass} mt-1`}
                      value={thirdColumn}
                      onChange={(event) => setThirdColumn(Number(event.target.value))}
                      disabled={!thirdTable}
                    >
                      {columnOptions(
                        thirdTable?.headers ?? [],
                        `third-${thirdTable?.index ?? 0}`,
                      ).map((option) => (
                        <option value={option.column} key={option.key}>
                          {option.header}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              ) : null}
            </fieldset>
          </div>

          <div className="mt-4 flex flex-wrap items-end gap-3 border-t border-border pt-4">
            <label
              className="min-w-[14rem] flex-1 text-xs font-semibold text-ink-muted"
              htmlFor="combined-name"
            >
              Nombre de la fuente combinada
              <input
                id="combined-name"
                className={`${inputClass} mt-1`}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={240}
              />
            </label>
            <button
              type="button"
              className={`${buttonClass} bg-primary text-white hover:bg-primary-hover`}
              onClick={() => void previewSources()}
              disabled={!config || busy || loading}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Combine className="h-4 w-4" aria-hidden />
              )}{' '}
              Simular cruce
            </button>
          </div>

          {preview ? (
            <div className="mt-5 rounded-sm border border-border bg-surface-2/40 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-ink">Resultado de la simulación</h3>
                  <p className="mt-1 text-xs text-ink-muted">
                    {preview.status === 'ready'
                      ? `${preview.summary.matched} coincidencias · ${preview.summary.unmatched} sin coincidencia · ${preview.summary.ambiguous} ambiguas`
                      : 'La captura no está lista para cruzarse.'}
                  </p>
                </div>
                <button
                  type="button"
                  className={`${buttonClass} border border-border-strong bg-surface text-ink`}
                  onClick={() => void saveSources()}
                  disabled={preview.status !== 'ready' || preview.summary.truncated || busy}
                >
                  <Check className="h-4 w-4" aria-hidden /> Guardar fuente privada
                </button>
              </div>
              {preview.errors.length ? (
                <p className="mt-3 text-sm text-rose">{preview.errors.join(' ')}</p>
              ) : null}
              {preview.rows.length ? (
                <div className="mt-4 overflow-x-auto rounded-sm border border-border bg-surface">
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-surface-2 text-ink-muted">
                      <tr>
                        <th className="px-3 py-2 font-semibold">Estado</th>
                        <th className="px-3 py-2 font-semibold">Clave</th>
                        <th className="px-3 py-2 font-semibold">Procedencia</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {preview.rows.slice(0, 12).map((row) => (
                        <tr key={`${row.rowIndex}-${row.key ?? 'missing'}`}>
                          <td className="whitespace-nowrap px-3 py-2 font-semibold text-ink">
                            {row.status === 'matched'
                              ? 'Coincide'
                              : row.status === 'ambiguous'
                                ? 'Ambigua'
                                : 'Sin coincidencia'}
                          </td>
                          <td className="max-w-[14rem] truncate px-3 py-2 text-ink-muted">
                            {row.key ?? 'Sin clave'}
                          </td>
                          <td className="max-w-[32rem] px-3 py-2 text-ink-muted">
                            {row.provenance
                              .map((item) => `${item.sourceName} · fila ${item.rowIndex + 1}`)
                              .join(' / ') || row.reasons.join(' ')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.rows.length > 12 ? (
                    <p className="border-t border-border px-3 py-2 text-xs text-ink-faint">
                      Se muestran 12 filas. La captura conserva el resultado completo hasta el
                      límite de la fuente.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <aside className="min-w-0 rounded-sm border border-border bg-surface-2/40 p-4">
          <div className="flex items-start gap-2">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            <div>
              <h3 className="text-sm font-bold text-ink">Propuestas editables</h3>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                Se basan en encabezados y metadatos. Cargar una propuesta sólo rellena el editor;
                nunca guarda ni activa una regla.
              </p>
            </div>
          </div>
          <div className="mt-4 space-y-3">
            {suggestions.length ? (
              suggestions.slice(0, 8).map((suggestion) => (
                <article
                  className="rounded-sm border border-border bg-surface p-3"
                  key={suggestion.id}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-ink">{suggestion.title}</p>
                      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                        {suggestion.purpose}
                      </p>
                    </div>
                    <span className="shrink-0 rounded-pill bg-primary-soft px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">
                      Editable
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-ink-faint">{suggestion.reason}</p>
                  {suggestion.type === 'combined' ? (
                    <button
                      type="button"
                      className={`${buttonClass} mt-3 w-full border border-border-strong bg-surface text-ink`}
                      onClick={() => useSuggestion(suggestion)}
                    >
                      Usar en el editor <ChevronDown className="h-4 w-4" aria-hidden />
                    </button>
                  ) : (
                    <Link
                      className={`${buttonClass} mt-3 w-full border border-border-strong bg-surface text-center text-ink`}
                      href={href(
                        `/activations?source=${encodeURIComponent(suggestion.sourceIds[0] ?? '')}`,
                      )}
                    >
                      Revisar en Activaciones
                    </Link>
                  )}
                </article>
              ))
            ) : (
              <p className="rounded-sm border border-dashed border-border px-3 py-4 text-xs leading-relaxed text-ink-muted">
                Todavía no hay una propuesta con señales suficientes. Añade una fuente tabular con
                encabezados explícitos.
              </p>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
