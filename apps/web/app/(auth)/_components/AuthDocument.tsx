'use client';

import { clsx } from 'clsx';
import { type InputHTMLAttributes, type ReactNode, useId } from 'react';

/**
 * The access screens are the first thing anyone sees, so they set the promise
 * the rest of the product has to keep: a well-made instrument, not the
 * paperwork it replaces.
 *
 * Every screen in the flow shares the same card: a soft indigo band up top, a
 * curved white body, and depth that comes from a lifted shadow rather than a
 * ruled line. Sharing these pieces is what stops the six screens drifting
 * into six different products.
 */

/** The card itself: white, curved, lifted off the canvas. */
export function AuthDocument({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
      {children}
    </div>
  );
}

/**
 * The band at the top of the card.
 *
 * The wordmark sits directly on the mesh rather than in its own chip — boxing
 * it up would read as a sticker dropped on top of the gradient instead of a
 * mark that belongs to it.
 */
export function AuthMasthead({
  note = 'Cerebro operativo · logística postal y aduanera',
}: {
  note?: string;
}) {
  return (
    <div className="hero-mesh px-6 py-6 text-white sm:px-8">
      <div className="flex items-center gap-3">
        {/* App icon lives at /icon.png (Next metadata) — same mark as the tab. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/icon.png" alt="" className="h-7 w-7" />
        <span className="text-[25px] font-semibold uppercase leading-none tracking-[0.2em]">
          Cortex
        </span>
      </div>
      <p className="mt-4 text-[13px] leading-snug text-white/75">{note}</p>
    </div>
  );
}

/** Everything below the masthead sits in the body of the form. */
export function AuthBody({ children }: { children: ReactNode }) {
  return <div className="px-6 py-6 sm:px-8">{children}</div>;
}

export function AuthTitle({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-5">
      <h1 className="text-[17px] font-bold tracking-tight text-ink">{children}</h1>
      {hint && <p className="mt-1.5 text-[13px] leading-snug text-ink-muted">{hint}</p>}
    </div>
  );
}

/**
 * A labelled box on the form. The label is a real `<label>`, not a
 * placeholder — a placeholder disappears the moment someone starts typing,
 * which is precisely when they need to know which box they are in.
 */
export function AuthField({
  label,
  mono,
  className,
  ...rest
}: { label: string; mono?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        id={id}
        className={clsx(
          'mt-1 w-full rounded-sm border border-border bg-surface-2 px-3 py-2.5 text-[13px] text-ink',
          'transition-colors placeholder:text-ink-faint focus:border-primary focus:bg-surface',
          'focus:outline-none focus:ring-4 focus:ring-primary/10',
          // Credentials and one-time codes are read character by character.
          // Mono is what stops an l passing for a 1 at the worst moment.
          mono && 'font-mono',
          className,
        )}
        {...rest}
      />
    </div>
  );
}

export function AuthDivider({ label = 'o' }: { label?: string }) {
  return (
    <div className="my-4 flex items-center gap-3">
      <span className="h-px flex-1 bg-border" />
      <span className="text-[11px] font-medium text-ink-faint">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** An error banner inside the card: soft rose, never dismissed on its own. */
export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-4 rounded-sm border border-rose/40 bg-rose-soft px-3 py-2 text-[12.5px] leading-snug text-rose"
    >
      {children}
    </p>
  );
}
