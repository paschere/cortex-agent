'use client';

import { relative, untilNext } from './format';
import { useNow } from './useNow';

/**
 * A live "in 2h 10m" / "3d ago" stamp for server-rendered pages. Renders the
 * fallback until the clock exists on the client, so nothing mismatches.
 */
export function LiveRelative({
  ts,
  mode = 'past',
  fallback = '—',
}: {
  ts: string | null;
  /** `next` reads past timestamps as "due now" — right for a pending run. */
  mode?: 'past' | 'next';
  fallback?: string;
}) {
  const now = useNow();
  const text = mode === 'next' ? untilNext(ts, now) : relative(ts, now);
  return <span suppressHydrationWarning>{text ?? fallback}</span>;
}
