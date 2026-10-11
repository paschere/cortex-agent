'use client';

import { ArrowUpRight, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { CHART_COLOR } from './colors';
import { dayLabel } from './interactive';
import type { DrillRecord } from './interactive';

/**
 * LO QUE HAY DETRÁS DE UN PUNTO. Un panel lateral (abajo en el teléfono) con
 * los registros de ese día o ese tramo, el más grande primero, y el enlace a la
 * pantalla completa. Se cierra con Esc, con el fondo o con la X; devuelve el
 * foco a quien lo abrió.
 */
export function DrillSheet({
  open,
  onClose,
  title,
  subtitle,
  rows,
  total,
  sum,
  money,
  fullHref,
  fullLabel,
  noun = 'registros',
  note,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  rows: DrillRecord[];
  total: number;
  sum: number;
  money: (n: number) => string;
  fullHref?: string;
  fullLabel?: string;
  noun?: string;
  note?: string;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      (opener.current as HTMLElement | null)?.focus?.();
    };
  }, [open, onClose]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[80]">
      <button
        type="button"
        aria-label="Cerrar"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-ink/25 backdrop-blur-[1px]"
      />
      {/* biome-ignore lint/a11y/useSemanticElements: panel lateral propio con fondo; <dialog> modal no deja moverlo a pie de pantalla en teléfono. */}
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="cx-sheet absolute inset-x-0 bottom-0 flex max-h-[82dvh] flex-col rounded-t-2xl border border-border bg-surface shadow-pop sm:inset-y-0 sm:left-auto sm:right-0 sm:max-h-none sm:w-[26rem] sm:rounded-none sm:rounded-l-2xl"
      >
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-extrabold leading-snug text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-ink-muted">{subtitle}</p>}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-pill text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {rows.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-muted">
              {note ?? `No hay ${noun} en este punto.`}
            </p>
          ) : (
            <>
              <p className="mb-2 flex items-baseline justify-between text-xs text-ink-muted">
                <span>
                  {total} {total === 1 ? noun.replace(/s$/, '') : noun}
                  {total > rows.length ? ` · se muestran ${rows.length}` : ''}
                </span>
                <span className="tabular font-semibold text-ink">{money(sum)}</span>
              </p>
              <ul className="divide-y divide-border">
                {rows.map((r) => (
                  <li key={r.id} className="py-2.5">
                    <RowBody r={r} money={money} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        {fullHref && (
          <footer className="border-t border-border px-5 py-3">
            <Link
              href={fullHref}
              className="inline-flex min-h-9 items-center gap-1.5 text-sm font-semibold text-primary-ink hover:underline"
            >
              {fullLabel ?? 'Abrir la pantalla completa'}
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}

function RowBody({ r, money }: { r: DrillRecord; money: (n: number) => string }) {
  const color =
    r.tone === 'emerald'
      ? CHART_COLOR.emerald
      : r.tone === 'rose'
        ? CHART_COLOR.rose
        : r.tone === 'amber'
          ? CHART_COLOR.amber
          : undefined;
  const body = (
    <div className="flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">{r.title}</p>
        <p className="truncate text-xs text-ink-faint">
          {dayLabel(r.date)}
          {r.subtitle ? ` · ${r.subtitle}` : ''}
        </p>
      </div>
      <span
        className="tabular shrink-0 text-sm font-semibold tabular-nums text-ink"
        style={color ? { color } : undefined}
      >
        {money(r.amount)}
      </span>
    </div>
  );
  return r.href ? (
    <Link href={r.href} className="-mx-2 block rounded-sm px-2 py-0.5 hover:bg-surface-2">
      {body}
    </Link>
  ) : (
    body
  );
}
