'use client';

import type { StudioPage } from '@/lib/views/studio';
import { clsx } from 'clsx';
import { Settings2 } from 'lucide-react';

/**
 * «PÁGINAS»: MOVERSE ENTRE LAS PESTAÑAS DE UNA VISTA.
 *
 * Sólo aparece cuando la vista tiene páginas (`spec.pages`, del motor). Crear,
 * renombrar y quitar páginas vive en un solo sitio, «Ajustes de la vista →
 * Páginas» (ViewSettings): aquí no hay un segundo editor de lo mismo. Lo que
 * sí hace este panel es lo que el lienzo necesita para trabajar por páginas:
 * elegir cuál se ve (el lienzo muestra sólo sus bloques y lo que se agrega cae
 * en ella) y decir en qué páginas sale el bloque elegido. Un bloque puede
 * estar en varias; el que no está nombrado en ninguna sale en la primera —la
 * misma regla que `computePages` en el motor—.
 */
export function PagesPanel({
  pages,
  current,
  counts,
  selectedTitle,
  selectedPages,
  selectedLoose,
  onPick,
  onToggle,
  onManage,
}: {
  pages: StudioPage[];
  current: string | null;
  counts: Map<string, number>;
  selectedTitle: string | null;
  /** Las páginas donde sale el bloque elegido. */
  selectedPages: string[];
  /** El bloque elegido no está nombrado en ninguna página (sale en la primera). */
  selectedLoose: boolean;
  onPick: (id: string) => void;
  onToggle: (pageId: string, on: boolean) => void;
  /** Abre «Ajustes de la vista», donde se crean y renombran. */
  onManage: () => void;
}) {
  return (
    <div className="space-y-4">
      <ol className="space-y-1">
        {pages.map((p, i) => (
          <li key={p.id}>
            <button
              type="button"
              aria-pressed={current === p.id}
              onClick={() => onPick(p.id)}
              className={clsx(
                'flex w-full items-center gap-2 rounded-sm border px-2 py-1.5 text-left transition-colors duration-150',
                current === p.id
                  ? 'border-primary/50 bg-primary-soft/50'
                  : 'border-transparent hover:bg-surface-2',
              )}
            >
              <span className="tabular w-5 shrink-0 text-center font-mono text-micro text-ink-faint">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-semibold text-ink">{p.title}</span>
                <span className="text-micro text-ink-faint">
                  {counts.get(p.id) ?? 0} {(counts.get(p.id) ?? 0) === 1 ? 'bloque' : 'bloques'}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {selectedTitle && (
        <fieldset className="rounded-sm border border-border bg-surface-2/50 p-3">
          <legend className="field-label px-1">«{selectedTitle}» sale en</legend>
          <ul className="mt-1 space-y-1">
            {pages.map((p, i) => {
              const on = selectedPages.includes(p.id);
              // Un bloque sin página nombrada sale en la primera: para sacarlo
              // de ahí hay que ponerlo en otra.
              const locked = i === 0 && selectedLoose;
              return (
                <li key={p.id}>
                  <label
                    className={clsx(
                      'flex items-center gap-2 text-xs text-ink',
                      locked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={locked}
                      onChange={(e) => onToggle(p.id, e.target.checked)}
                      className="h-4 w-4 accent-[rgb(var(--primary))]"
                    />
                    <span className="truncate">{p.title}</span>
                  </label>
                </li>
              );
            })}
          </ul>
          {selectedLoose && (
            <p className="mt-2 text-micro leading-relaxed text-ink-faint">
              No está en ninguna página, así que sale en la primera. Márcalo en otra para moverlo.
            </p>
          )}
        </fieldset>
      )}

      <button
        type="button"
        onClick={onManage}
        className="inline-flex items-center gap-1.5 text-micro font-semibold text-ink-muted transition-colors hover:text-primary"
      >
        <Settings2 className="h-3.5 w-3.5" aria-hidden /> Agregar, renombrar o quitar páginas
      </button>
    </div>
  );
}
