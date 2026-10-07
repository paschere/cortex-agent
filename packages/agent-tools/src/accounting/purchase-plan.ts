import { addDays, bogotaToday } from '../commitments/shape';
import type { AccountingProviderId } from './types';

export interface PurchaseCursor {
  /** Last successful pass. */
  since?: string;
  /** Last complete historical pass for Siigo. */
  full_at?: string;
  resume?: { page: number; since: string; mode: 'initial' | 'rolling' | 'sweep' };
}

export type PurchasePlan = NonNullable<PurchaseCursor['resume']>;

const SIIGO_FULL_SWEEP_MS = 30 * 24 * 60 * 60_000;

/** Siigo gets a full backfill and monthly history check; other programs retain 90 days. */
export function planPurchaseSync(
  provider: AccountingProviderId,
  previous: PurchaseCursor | undefined,
  now: Date,
): PurchasePlan {
  if (previous?.resume) return previous.resume;
  if (provider === 'siigo') {
    if (!previous?.since) return { mode: 'initial', since: '', page: 1 };
    if (!previous.full_at || now.getTime() - Date.parse(previous.full_at) >= SIIGO_FULL_SWEEP_MS)
      return { mode: 'sweep', since: '', page: 1 };
  }
  return { mode: 'rolling', since: addDays(bogotaToday(now), -90), page: 1 };
}

export function nextPurchaseCursor(
  previous: PurchaseCursor | undefined,
  plan: PurchasePlan,
  nextPage: number | null,
  now: Date,
): PurchaseCursor {
  if (nextPage !== null) return { ...previous, resume: { ...plan, page: nextPage } };
  return {
    since: now.toISOString(),
    ...(plan.mode === 'rolling'
      ? previous?.full_at
        ? { full_at: previous.full_at }
        : {}
      : { full_at: now.toISOString() }),
  };
}
