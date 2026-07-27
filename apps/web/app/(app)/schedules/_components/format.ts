/**
 * Pure formatting helpers shared by the Routines page and its client
 * components. Kept free of `'use client'` and of React so the server page can
 * import them too.
 */

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Humanize the common cron shapes; fall back to the raw expression. */
export function humanizeCron(cron: string | null, tz: string): string {
  if (!cron) return '—';
  const m = cron.trim().split(/\s+/);
  if (m.length !== 5) return `${cron} (${tz})`;
  const [min, hour, dom, , dow] = m as [string, string, string, string, string];
  const time =
    /^\d+$/.test(hour) && /^\d+$/.test(min)
      ? `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`
      : null;

  if (min.startsWith('*/') && hour === '*') return `Every ${min.slice(2)} min`;
  if (time && dom === '*' && dow === '*') return `Daily at ${time}`;
  if (time && dom === '*' && dow === '1-5') return `Weekdays at ${time}`;
  if (time && dom === '*' && /^\d$/.test(dow)) return `${DOW[Number(dow)]}s at ${time}`;
  if (time && /^\d+$/.test(dom) && dow === '*') return `Monthly on day ${dom} at ${time}`;
  return `${cron} (${tz})`;
}

/** Compact absolute stamp, e.g. "Mar 4, 09:30". */
export function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Full stamp with weekday and seconds — used in the run drawer. */
export function fmtLong(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** How long a finished run took, e.g. "12.4s". Null while still running. */
export function runDuration(startedAt: string, finishedAt: string | null): string | null {
  if (!finishedAt) return null;
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${Math.round(secs % 60)}s`;
}

function spell(absMs: number): string {
  const mins = Math.round(absMs / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * "in 2h 10m" / "3d ago". `now` is passed in (rather than read from the clock)
 * so client components can hold it in state and stay hydration-safe.
 */
export function relative(ts: string | null, now: number | null): string | null {
  if (!ts || now === null) return null;
  const diff = new Date(ts).getTime() - now;
  if (!Number.isFinite(diff)) return null;
  if (Math.abs(diff) < 45_000) return diff >= 0 ? 'in a moment' : 'just now';
  return diff >= 0 ? `in ${spell(diff)}` : `${spell(-diff)} ago`;
}

/**
 * Flatten markdown into plain prose for one- or two-line previews, so a report
 * reads as "Weekly payroll summary — 14 people…" instead of "## Weekly payroll".
 * Deliberately naive (and dependency-free): it only has to survive a clamp.
 */
export function stripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
    .replace(/`([^`]*)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → their label
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // headings
    .replace(/^\s{0,3}>\s?/gm, '') // block quotes
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ') // horizontal rules
    .replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, ' ') // table separator rows
    .replace(/^\s*[-*+]\s+/gm, '') // bullets
    .replace(/^\s*\d+\.\s+/gm, '') // ordered list markers
    .replace(/\|/g, ' · ') // remaining table pipes
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // bold
    .replace(/(\*|_)(.*?)\1/g, '$2') // italics
    .replace(/~~(.*?)~~/g, '$1') // strikethrough
    .replace(/\s+/g, ' ')
    .trim();
}

/** Same as `relative`, but past timestamps read as "due now". */
export function untilNext(ts: string | null, now: number | null): string | null {
  if (!ts || now === null) return null;
  if (new Date(ts).getTime() - now <= 0) return 'due now';
  return relative(ts, now);
}
