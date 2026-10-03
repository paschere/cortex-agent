'use client';

import type { ActionResult, CrmTile, Tone } from '@/lib/crm/shape';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';

/**
 * Piezas compartidas de /comercial: cifras arriba, barras, avisos, el panel
 * lateral y los campos. Sin datos propios.
 */

export const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-ink',
  primary: 'text-primary',
  emerald: 'text-emerald',
  amber: 'text-amber',
  rose: 'text-rose',
};

export const TONE_BAR: Record<Tone, string> = {
  neutral: 'bg-ink-faint/50',
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  rose: 'bg-rose',
};

export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-surface-2',
  primary: 'bg-primary-soft',
  emerald: 'bg-emerald-soft',
  amber: 'bg-amber-soft',
  rose: 'bg-rose-soft',
};

export function Tiles({ tiles }: { tiles: CrmTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      {tiles.map((t) => (
        <div
          key={t.label}
          className="relative overflow-hidden rounded-card border border-border bg-surface px-4 py-3.5 shadow-card"
        >
          <span aria-hidden className={clsx('absolute inset-y-0 left-0 w-1', TONE_BAR[t.tone])} />
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

/** Una barra horizontal de 0 a 1, con el número al lado en tinta (no en color). */
export function Meter({
  share,
  tone = 'primary',
  label,
}: {
  share: number | null;
  tone?: Tone;
  label: string;
}) {
  const w = share === null ? 0 : Math.max(0, Math.min(1, share));
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2" title={label}>
      <span className="relative h-2 min-w-[60px] flex-1 overflow-hidden rounded-pill bg-surface-2">
        <span
          className={clsx('absolute inset-y-0 left-0 rounded-pill', TONE_BAR[tone])}
          style={{ width: `${Math.round(w * 100)}%` }}
        />
      </span>
      <span className="tabular w-12 shrink-0 text-right text-xs font-semibold text-ink">
        {label}
      </span>
    </span>
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
    </p>
  );
}

export function Drawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-[1px]">
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
        className="relative m-0 h-full w-full max-w-xl overflow-y-auto border-l border-border bg-surface p-0 text-ink shadow-card"
      >
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-surface/95 px-6 py-4 backdrop-blur">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold text-ink">{title}</h2>
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

export function SectionTitle({
  icon,
  title,
  note,
  right,
}: {
  icon?: ReactNode;
  title: string;
  note?: string;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-2 px-5 pb-3 pt-4">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
          {icon}
          {title}
        </h2>
        {note && <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{note}</p>}
      </div>
      {right}
    </div>
  );
}
