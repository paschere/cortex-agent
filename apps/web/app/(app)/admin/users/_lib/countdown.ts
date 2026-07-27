/**
 * Compact forward-looking time — the mirror of `lib/relative-time`.
 *
 * `relativeTime` measures now-minus-then, so a timestamp in the future collapses
 * to "just now". Token expiries, pending confirmations and next scheduled runs
 * are all in the future, and they need to read as a countdown.
 */
export function countdown(iso: string | null): string {
  if (!iso) return 'not scheduled';
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return iso;

  const diff = target - Date.now();
  if (diff <= 0) return 'overdue';

  const min = Math.round(diff / 60_000);
  if (min < 1) return 'in under a minute';
  if (min < 60) return `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 7) return `in ${day}d`;
  return `on ${new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
