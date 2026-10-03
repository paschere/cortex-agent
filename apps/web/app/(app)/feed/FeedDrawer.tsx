'use client';

import type { SpaceChoice } from '@/app/(chat)/chat/actions';
import type { FeedDetail, FeedEntry } from '@/lib/feed/shared';
import { clsx } from 'clsx';
import {
  Brain,
  Check,
  ExternalLink,
  Loader2,
  MessageSquare,
  RefreshCw,
  Table2,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { TypeIcon } from './TypeIcon';
import {
  type FeedStatus,
  ORIGIN_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
  TYPE_LABEL,
  feedOrigin,
  feedType,
  formatBytes,
} from './inbox-model';

const AREA: Record<string, string> = {
  financial: 'Finanzas',
  administrative: 'Administración',
  commercial: 'Comercial',
  operations: 'Operaciones',
};

const btn =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-pill px-3.5 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * LA VISTA PREVIA: un cajón que entra por la derecha (pantalla completa en el
 * teléfono) con lo que Cortex leyó —el texto, o la hoja de cálculo con sus
 * pestañas—, para qué puede servir y todo lo que se puede hacer con la
 * entrada. Lee el detalle por la misma ruta de siempre (/api/feed/[id]).
 */
export function FeedDrawer({
  entry,
  detail,
  status,
  busy,
  activationHref,
  onClose,
  onConsult,
  onTable,
  onRefresh,
  onLoadSpaces,
  onPromote,
  onDelete,
}: {
  entry: FeedEntry;
  detail: FeedDetail | null;
  status: FeedStatus;
  busy: boolean;
  activationHref: string;
  onClose: () => void;
  onConsult: () => void;
  onTable: () => void;
  onRefresh: (() => void) | null;
  onLoadSpaces: () => Promise<SpaceChoice[]>;
  onPromote: (space: string) => void;
  onDelete: () => void;
}) {
  const [sheet, setSheet] = useState(0);
  const [saving, setSaving] = useState<SpaceChoice[] | null>(null);
  const [space, setSpace] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [spacesError, setSpacesError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: cada entrada abre el cajón desde cero.
  useEffect(() => {
    setSheet(0);
    setSaving(null);
    setDeleting(false);
    closeRef.current?.focus();
  }, [entry.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const type = feedType(entry);
  const table = detail?.feed_tables?.[sheet];
  const promoted = !!(detail?.promoted_document_id ?? entry.promoted_document_id);

  return (
    <>
      <button
        type="button"
        aria-label="Cerrar la vista previa"
        onClick={onClose}
        className="fixed inset-0 z-40 bg-ink/20"
      />
      <aside
        aria-label={`Vista previa de ${entry.filename}`}
        className="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-surface shadow-pop sm:w-[min(640px,92vw)] sm:rounded-l-card"
      >
        <header className="flex items-start gap-3 border-b border-border p-4 sm:p-5">
          <TypeIcon type={type} />
          <div className="min-w-0 flex-1">
            <h2 className="break-words text-base font-extrabold text-ink">{entry.filename}</h2>
            <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-muted">
              <span>{TYPE_LABEL[type]}</span>
              <span aria-hidden>·</span>
              <span>{ORIGIN_LABEL[feedOrigin(entry)]}</span>
              <span aria-hidden>·</span>
              <span className="tabular">{formatBytes(entry.byte_size)}</span>
              <span
                className={clsx(
                  'rounded-pill px-2 py-0.5 text-micro font-bold',
                  STATUS_TONE[status],
                )}
              >
                {STATUS_LABEL[status]}
              </span>
            </p>
            <p className="mt-1 text-micro text-ink-faint">
              En tu bandeja hasta el{' '}
              <span className="tabular">
                {new Date(entry.purge_at).toLocaleString('es-CO', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                  timeZone: 'America/Bogota',
                })}
              </span>
              {promoted ? ' · la copia del cerebro se queda' : ''}
            </p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Cerrar"
            onClick={onClose}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-pill text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3 sm:px-5">
          <button
            type="button"
            disabled={busy}
            onClick={onConsult}
            className={clsx(btn, 'bg-primary text-white hover:bg-primary-strong')}
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
            {entry.conversation_id ? 'Seguir la consulta' : 'Consultar con Cortex'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onTable}
            className={clsx(btn, 'border border-border-strong text-ink hover:bg-surface-2')}
          >
            <Table2 className="h-3.5 w-3.5" aria-hidden /> Convertir en tabla
          </button>
          {promoted ? (
            <span className="inline-flex items-center gap-1 px-2 text-xs font-bold text-emerald">
              <Check className="h-3.5 w-3.5" aria-hidden /> En el cerebro
            </span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setSpacesError(null);
                onLoadSpaces()
                  .then((list) => {
                    setSaving(list);
                    setSpace('');
                  })
                  .catch(() => setSpacesError('No se pudieron cargar los espacios.'));
              }}
              className={clsx(btn, 'border border-border-strong text-ink hover:bg-surface-2')}
            >
              <Brain className="h-3.5 w-3.5" aria-hidden /> Guardar en el cerebro
            </button>
          )}
          <Link
            href={activationHref}
            className={clsx(btn, 'border border-border-strong text-ink hover:bg-surface-2')}
          >
            <Zap className="h-3.5 w-3.5" aria-hidden /> Crear activación
          </Link>
          {onRefresh && (
            <button
              type="button"
              disabled={busy}
              onClick={onRefresh}
              className={clsx(btn, 'text-ink-muted hover:bg-surface-2 hover:text-ink')}
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Actualizar captura
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => setDeleting(true)}
            className={clsx(btn, 'ml-auto text-ink-muted hover:bg-rose-soft hover:text-rose')}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden /> Borrar
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-5">
          {spacesError && (
            <p className="mb-3 rounded-sm bg-rose-soft px-3 py-2 text-xs text-ink">{spacesError}</p>
          )}
          {saving && (
            <div className="mb-4 flex flex-col gap-3 rounded-sm bg-surface-2 p-3">
              <p className="text-sm text-ink">
                Se guarda una copia en el espacio que elijas y Cortex la usa en respuestas futuras.
                La entrada de la bandeja sigue venciendo.
              </p>
              <label htmlFor="drawer-space" className="text-xs font-bold text-ink">
                Guardar en
              </label>
              <select
                id="drawer-space"
                value={space}
                onChange={(e) => setSpace(e.target.value)}
                className="rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink"
              >
                <option value="">Mis notas privadas</option>
                {saving.map((s) => (
                  <option key={s.id} value={s.name} disabled={!s.writable}>
                    {s.name}
                    {!s.writable ? ' (sin permiso de escritura)' : ''}
                  </option>
                ))}
              </select>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onPromote(space)}
                  className={clsx(btn, 'bg-primary text-white hover:bg-primary-strong')}
                >
                  {busy ? 'Guardando…' : 'Guardar en este espacio'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setSaving(null)}
                  className={clsx(btn, 'text-ink-muted hover:bg-surface')}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}
          {deleting && (
            <div className="mb-4 rounded-sm bg-rose-soft p-3 text-sm text-ink">
              <p>
                Se borran esta entrada y su archivo temporal. Las respuestas del chat y las copias
                que guardaste en el cerebro se quedan.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={onDelete}
                  className={clsx(btn, 'bg-rose text-white hover:opacity-90')}
                >
                  Borrar de la bandeja
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setDeleting(false)}
                  className={clsx(btn, 'text-ink hover:bg-surface')}
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {!detail ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-2 text-sm text-ink-muted">
              <Loader2
                className="h-5 w-5 animate-spin text-primary motion-reduce:animate-none"
                aria-hidden
              />
              Leyendo la entrada…
            </div>
          ) : (
            <>
              {detail.source_url && (
                <a
                  href={detail.source_url}
                  target="_blank"
                  rel="noreferrer"
                  className="mb-4 inline-flex max-w-full items-center gap-1.5 break-all text-xs font-semibold text-primary hover:underline"
                >
                  <ExternalLink className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {detail.source_url}
                </a>
              )}

              {detail.recommendation && (
                <section className="mb-4 rounded-sm border border-primary/20 bg-primary-soft/60 p-4">
                  <h3 className="text-sm font-extrabold text-ink">Para qué puede servir</h3>
                  <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                    {promoted
                      ? 'Ya tiene una copia en el cerebro. Esta propuesta no ha cambiado ninguna cifra.'
                      : 'Propuesta según los encabezados. No se ha copiado al cerebro ni aplicado a cifras.'}
                  </p>
                  {detail.recommendation.tables.length === 0 ? (
                    <p className="mt-2 text-xs text-ink-muted">
                      Cortex necesita revisarla contigo para proponer un destino.
                    </p>
                  ) : (
                    <ul className="mt-3 flex flex-col gap-3">
                      {detail.recommendation.tables.map((t, i) => (
                        <li
                          key={`${t.name}:${i}`}
                          className="border-t border-primary/15 pt-3 first:border-0 first:pt-0"
                        >
                          <p className="flex flex-wrap items-center gap-1.5 text-sm font-bold text-ink">
                            {t.name}
                            {(t.areas.length ? t.areas : ['']).map((a) => (
                              <span
                                key={a || 'none'}
                                className="rounded-pill bg-surface px-2 py-0.5 text-micro font-bold text-primary"
                              >
                                {AREA[a] ?? 'Uso por confirmar'}
                              </span>
                            ))}
                          </p>
                          <p className="mt-1 text-xs text-ink-muted">{t.reasons.join(' ')}</p>
                          {t.missingRequiredFields.length > 0 && (
                            <p className="mt-1 text-xs text-amber">
                              Falta revisar: {t.missingRequiredFields.join(', ')}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}

              {(detail.feed_truncated || detail.extracted_text.length > 12000) && (
                <p className="mb-3 rounded-sm bg-amber-soft p-3 text-xs text-ink">
                  {detail.feed_truncated
                    ? 'La fuente se capturó parcialmente; los cálculos no cubren el archivo original completo. '
                    : ''}
                  El chat recibe una lectura inicial de hasta 12.000 caracteres. En hojas de
                  cálculo, Cortex también consulta las filas y calcula sobre toda la captura
                  guardada.
                </p>
              )}

              {table ? (
                <>
                  {(detail.feed_tables?.length ?? 0) > 1 && (
                    <div
                      className="mb-3 flex gap-1 overflow-x-auto"
                      aria-label="Pestañas de la hoja"
                    >
                      {detail.feed_tables?.map((t, i) => (
                        <button
                          key={`${i}-${t.name}`}
                          type="button"
                          aria-pressed={i === sheet}
                          onClick={() => setSheet(i)}
                          className={clsx(
                            'shrink-0 rounded-pill px-3 py-1 text-xs font-semibold',
                            i === sheet
                              ? 'bg-ink text-surface'
                              : 'bg-surface-2 text-ink-muted hover:text-ink',
                          )}
                        >
                          {t.name} <span className="tabular opacity-70">{t.rows.length}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="max-h-[60vh] overflow-auto rounded-sm border border-border">
                    <table className="w-full text-left text-xs">
                      <caption className="sr-only">Vista previa de {table.name}</caption>
                      <tbody>
                        {table.rows.slice(0, 100).map((row, r) => (
                          <tr
                            key={`${table.name}-row-${r}`}
                            className={
                              r === 0
                                ? 'sticky top-0 bg-surface-2 font-bold'
                                : 'border-t border-border'
                            }
                          >
                            <th
                              scope="row"
                              className="sticky left-0 bg-surface-2 px-2 py-2 text-right font-mono text-micro text-ink-faint"
                            >
                              {r + 1}
                            </th>
                            {row.map((cell, c) => (
                              <td
                                key={`${table.name}-cell-${r}-${c}`}
                                className="tabular max-w-64 truncate whitespace-nowrap px-3 py-2 text-ink"
                                title={String(cell ?? '')}
                              >
                                {String(cell ?? '')}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="mt-2 text-xs text-ink-muted">
                    Vista previa:{' '}
                    <span className="tabular">{Math.min(table.rows.length, 100)}</span> de{' '}
                    <span className="tabular">{table.rows.length}</span> filas. Se conservan todas
                    las celdas leídas; las fórmulas usan el resultado guardado en Excel.
                  </p>
                </>
              ) : (
                <pre className="whitespace-pre-wrap break-words rounded-sm bg-surface-2/60 p-4 font-sans text-sm leading-relaxed text-ink">
                  {detail.extracted_text || 'No se pudo leer texto de esta entrada.'}
                </pre>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
