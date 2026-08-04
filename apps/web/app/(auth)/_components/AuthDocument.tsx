'use client';

import { clsx } from 'clsx';
import { type InputHTMLAttributes, type ReactNode, useId } from 'react';

/**
 * The access screens are the first thing anyone sees, so they set the promise
 * the rest of the product has to keep: this is a system of record, not a
 * consumer app.
 *
 * Every screen in the flow is the same document — one masthead printed on
 * security paper, fields that look like the boxes on a form, and definition
 * from rules rather than shadows. Sharing these pieces is what stops the six
 * screens drifting into six different products.
 */

/** The sheet itself: white, ruled, flat. */
export function AuthDocument({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-card border border-border-strong bg-surface">
      {children}
    </div>
  );
}

/**
 * The printed head of the document.
 *
 * The wordmark is set in wide caps directly on the guilloche rather than in a
 * chip: on security paper a name that sits in its own box reads as a sticker,
 * and this one has to read as printed.
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
      <div className="mt-5 h-px bg-white/25" />
      <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-white/75">{note}</p>
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
          'mt-1 w-full rounded-card border border-border bg-surface-2 px-3 py-2.5 text-[13px] text-ink',
          'transition-colors placeholder:text-ink-faint focus:border-primary focus:bg-surface',
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
      <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
        {label}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** A refusal stamped on the form: red, ruled, and never dismissible. */
export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="mt-4 rounded-card border border-rose/40 bg-rose-soft px-3 py-2 text-[12.5px] leading-snug text-rose"
    >
      {children}
    </p>
  );
}
