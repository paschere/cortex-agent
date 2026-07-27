'use client';

import { useEffect, useState } from 'react';

/**
 * Ticking clock, `null` until mount — relative times stay hydration-safe
 * because the server render and the first client render agree on "unknown".
 */
export function useNow(intervalMs = 30_000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
