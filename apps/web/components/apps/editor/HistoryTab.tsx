'use client';

import { formatDateTime } from '@cortex/agent-tools/src/format/display';

import { restoreVersionAction } from '@/lib/apps/phase6-actions';
import { compareVersionsAction } from '@/lib/apps/review-actions';
import type { CompareLine } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { GitCompareArrows, History, RotateCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type AppEditorData, BTN_PRIMARY, BTN_SECONDARY, CARD, ErrorLine } from './shared';

/**
 * «HISTORIAL» (0225): cada vez que se publica queda una versión numerada con
 * lo que cambió. La publicada es la que ven los usuarios; el borrador es lo
 * que se está armando. «Volver a esta versión» devuelve el borrador a lo que
 * esa versión decía (y, si se quiere, la publica de una vez). Los datos de las
 * tablas no se versionan: no se pierde ni se pisa ningún registro.
 */

const DATE = { format: (d: Date) => formatDateTime(d.toISOString()) };

const KIND: Record<string, string> = {
  added: 'bg-emerald-soft text-emerald',
  removed: 'bg-rose-soft text-rose',
  changed: 'bg-amber-soft text-amber',
};
const KIND_LABEL: Record<string, string> = {
  added: 'Nuevo',
  removed: 'Quitado',
  changed: 'Cambio',
};

export function HistoryTab({ data }: { data: AppEditorData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [comparing, setComparing] = useState<{
    number: number;
    lines: CompareLine[] | null;
    error?: string;
  } | null>(null);
  const versions = data.versions ?? [];
  const draft = data.draft;

  /** Qué cambiaría en el borrador si se vuelve a la versión `n`, en español. */
  function compare(n: number) {
    if (comparing?.number === n) return setComparing(null);
    setComparing({ number: n, lines: null });
    start(async () => {
      const res = await compareVersionsAction(data.app.id, 'draft', n);
      setComparing(
        res.ok ? { number: n, lines: res.lines } : { number: n, lines: [], error: res.error },
      );
    });
  }

  function restore(n: number, publish: boolean) {
    setError(null);
    setNote(null);
    start(async () => {
      const res = await restoreVersionAction(data.app.id, n, publish);
      if (!res.ok) return setError(res.error);
      setAsking(null);
      setNote(
        `${publish ? 'Publiqué' : 'Dejé en el borrador'} la versión ${n}.${res.skipped.length ? ` No pude devolver: ${res.skipped.join(' · ')}` : ''}`,
      );
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <section
        className={clsx(
          CARD,
          'flex flex-wrap items-center justify-between gap-3',
          draft?.hasChanges && 'border-amber/40',
        )}
      >
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">
            {draft?.hasChanges
              ? 'El borrador tiene cambios sin publicar'
              : 'El borrador coincide con lo publicado'}
          </h3>
          <p className="mt-0.5 text-xs text-ink-muted">
            {draft?.publishedNumber
              ? `Los usuarios ven la versión ${draft.publishedNumber}${draft.publishedAt ? ` (${DATE.format(new Date(draft.publishedAt))})` : ''}.`
              : 'Todavía no hay una versión publicada.'}
            {draft?.hasChanges && draft.summary ? ` ${draft.summary}.` : ''}
          </p>
        </div>
      </section>
      <ErrorLine error={error} />
      {note && (
        <p className="rounded-card bg-emerald-soft px-3 py-2 text-xs text-emerald">{note}</p>
      )}

      {versions.length === 0 ? (
        <div className="rounded-card border border-dashed border-border-strong bg-surface px-4 py-10 text-center text-sm text-ink-muted">
          <History className="mx-auto mb-2 h-6 w-6 text-ink-faint" aria-hidden />
          Aquí aparecerán las versiones cuando publiques la app.
        </div>
      ) : (
        <ol className="space-y-3">
          {versions.map((v) => (
            <li key={v.number} className={clsx(CARD, 'space-y-2')}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="stat-display text-lg text-ink">v{v.number}</span>
                {v.current && (
                  <span className="rounded-pill bg-emerald-soft px-2 py-0.5 text-micro font-semibold text-emerald">
                    Publicada
                  </span>
                )}
                <span className="text-xs text-ink-faint">{DATE.format(new Date(v.createdAt))}</span>
                <span className="text-xs text-ink-faint">
                  · {v.screens} pantallas · {v.roles} roles
                </span>
                <span className="ml-auto flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={BTN_SECONDARY}
                    disabled={pending}
                    onClick={() => compare(v.number)}
                  >
                    <GitCompareArrows className="h-3.5 w-3.5" aria-hidden /> Comparar con el borrador
                  </button>
                  {!v.current && (
                    <button
                      type="button"
                      className={BTN_SECONDARY}
                      disabled={pending}
                      onClick={() => setAsking(asking === v.number ? null : v.number)}
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Volver a esta versión
                    </button>
                  )}
                </span>
              </div>
              {v.note && <p className="text-sm font-semibold text-ink">{v.note}</p>}
              {v.changes.length > 0 ? (
                <ul className="space-y-1">
                  {v.changes.slice(0, 8).map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: texto repetible
                    <li key={i} className="flex items-start gap-2 text-xs text-ink-muted">
                      <span
                        className={clsx(
                          'mt-px shrink-0 rounded-pill px-1.5 py-px text-micro font-semibold',
                          KIND[c.kind],
                        )}
                      >
                        {KIND_LABEL[c.kind]}
                      </span>
                      {c.text}
                    </li>
                  ))}
                  {v.changes.length > 8 && (
                    <li className="text-xs text-ink-faint">y {v.changes.length - 8} más</li>
                  )}
                </ul>
              ) : (
                <p className="text-xs text-ink-faint">{v.summary}</p>
              )}
              {comparing?.number === v.number && (
                <div className="space-y-1.5 rounded-card border border-border bg-surface-2/60 p-3">
                  <p className="text-xs font-semibold text-ink">
                    Si vuelves a la versión {v.number}, el borrador cambiaría así:
                  </p>
                  {comparing.lines === null ? (
                    <p className="text-xs text-ink-muted">Comparando…</p>
                  ) : comparing.error ? (
                    <p className="text-xs text-rose">{comparing.error}</p>
                  ) : comparing.lines.length === 0 ? (
                    <p className="text-xs text-ink-muted">
                      Nada: el borrador ya dice lo mismo (pantallas, bloques, campos, permisos y
                      apariencia).
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {comparing.lines.map((c) => (
                        <li key={`${c.kind}:${c.text}`} className="flex items-start gap-2 text-xs text-ink-muted">
                          <span
                            className={clsx(
                              'mt-px shrink-0 rounded-pill px-1.5 py-px text-micro font-semibold',
                              KIND[c.kind],
                            )}
                          >
                            {KIND_LABEL[c.kind]}
                          </span>
                          {c.text}
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-micro text-ink-faint">
                    Las automatizaciones y los datos de las tablas no forman parte de una versión.
                  </p>
                </div>
              )}
              {asking === v.number && (
                <div className="space-y-2 rounded-card border border-border bg-surface-2/60 p-3">
                  <p className="text-xs text-ink-muted">
                    El borrador volverá a lo que decía la versión {v.number}. Los roles que hoy
                    tienen personas se conservan y los registros no se tocan.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className={BTN_SECONDARY}
                      disabled={pending}
                      onClick={() => restore(v.number, false)}
                    >
                      Restaurar como borrador
                    </button>
                    <button
                      type="button"
                      className={BTN_PRIMARY}
                      disabled={pending}
                      onClick={() => restore(v.number, true)}
                    >
                      Restaurar y publicar
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
