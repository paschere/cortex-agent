'use client';

import type { ActionResult, InventoryTile, Tone } from '@/lib/inventory/shape';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';

/**
 * Piezas compartidas de /inventario: cifras arriba, avisos de resultado, la
 * ventana modal y los campos. Sin datos propios.
 */

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink',
  primary: 'text-primary',
  emerald: 'text-emerald',
  amber: 'text-amber',
  rose: 'text-rose',
};

export const TONE_BAR: Record<Tone, string> = {
  neutral: 'bg-ink-faint/40',
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  rose: 'bg-rose',
};

export function Tiles({ tiles }: { tiles: InventoryTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="rounded-card border border-border bg-surface px-4 py-3.5 shadow-card"
        >
          <div className="text-xs font-semibold text-ink-muted">{t.label}</div>
          <div className={clsx('stat-num mt-2 text-lg leading-none', TONE_TEXT[t.tone])}>
            {t.value}
          </div>
          <div className="mt-1.5 text-xs leading-snug text-ink-faint">{t.note}</div>
        </div>
      ))}
    </div>
  );
}

export function Feedback({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <p
      aria-live="polite"
      className={clsx(
        'rounded-sm px-3 py-2 text-xs leading-relaxed',
        result.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
      )}
    >
      {result.ok ? (result.note ?? 'Listo.') : result.error}
      {result.ok && result.href && (
        <>
          {' '}
          <a href={result.href} className="font-semibold underline underline-offset-2">
            Ver
          </a>
        </>
      )}
    </p>
  );
}

export function Modal({
  title,
  subtitle,
  onClose,
  children,
  wide,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-6">
      <button
        type="button"
        aria-label="Cerrar"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />
      <dialog
        open
        aria-modal="true"
        aria-label={title}
        className={clsx(
          'relative m-0 max-h-[92vh] w-full overflow-y-auto p-0 text-ink rounded-t-card border border-border bg-surface shadow-card sm:rounded-card',
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4">
          <div>
            <h2 className="text-base font-bold text-ink">{title}</h2>
            {subtitle && <p className="mt-1 text-xs leading-relaxed text-ink-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <X className="h-4 w-4" aria-hidden />
            <span className="sr-only">Cerrar</span>
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
      </dialog>
    </div>
  );
}

export const FIELD =
  'min-h-9 w-full rounded-sm border border-border bg-surface px-3 text-sm text-ink placeholder:text-ink-faint focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30';

export const NUMBER_FIELD = `${FIELD} tabular text-right`;

export function Empty({
  title,
  body,
  action,
}: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-border-strong bg-surface px-6 py-10 text-center">
      <p className="text-base font-bold text-ink">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">{body}</p>
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

/** Un número escrito por una persona: «1.500», «12,5», «1500». */
export function readNumber(raw: string): number | null {
  const t = raw.trim().replace(/\s/g, '');
  if (!t) return null;
  const normalized = /,\d{1,2}$/.test(t)
    ? t.replace(/\./g, '').replace(',', '.')
    : t.replace(/[.,](?=\d{3}\b)/g, '');
  const n = Number(normalized);
  return Number.isFinite(n) ? n : null;
}
