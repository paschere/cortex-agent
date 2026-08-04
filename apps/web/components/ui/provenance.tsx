import { clsx } from 'clsx';
import type { ReactNode } from 'react';

/**
 * The signature element of the interface.
 *
 * Cortex's whole claim is that nothing it says is unattributed: every figure
 * carries the system it was read from and the moment it was read. This is that
 * claim made visible — a stamp applied to the page, the way a customs officer
 * marks a form as checked.
 *
 * Use it anywhere the product asserts a fact it did not get from the person
 * reading it: a SIMIT lookup, a bank balance, a quoted sentence from a call. If
 * a value has no provenance to show, it does not get a stamp — an empty one
 * would turn the whole device into decoration and quietly devalue the real ones.
 */

export type ProvenanceTone = 'stamp' | 'seal';

export function Provenance({
  source,
  readAt,
  detail,
  tone = 'stamp',
  className,
}: {
  /** The system of record: "SIMIT", "RUNT", "BANCOLOMBIA", "Call · 12 Jul". */
  source: string;
  /** When it was read. Already formatted — this component does not guess a locale. */
  readAt?: string;
  /** One short qualifier: "no fines", "3 pending", "min 14:32". */
  detail?: string;
  /** `seal` is red, for a fact that blocks something: lapsed, overdue, refused. */
  tone?: ProvenanceTone;
  className?: string;
}) {
  return (
    <span
      className={clsx('stamp', tone === 'seal' && 'stamp--seal', className)}
      // Screen readers get the sentence; sighted users get the stamp.
      aria-label={[source, readAt && `read ${readAt}`, detail].filter(Boolean).join(', ')}
    >
      <span className="font-semibold">{source}</span>
      {readAt && (
        <>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          <span className="tabular">{readAt}</span>
        </>
      )}
      {detail && (
        <>
          <span aria-hidden className="opacity-40">
            ·
          </span>
          <span>{detail}</span>
        </>
      )}
    </span>
  );
}

/**
 * A labelled box on a form. The label names what the box holds and the value
 * gets the monospaced treatment every piece of evidence gets, so a column of
 * these lines up the way a printed ledger does.
 */
export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={clsx('min-w-0', className)}>
      <div className="field-label">{label}</div>
      <div className="tabular mt-1 text-[15px] font-medium text-ink">{children}</div>
    </div>
  );
}
