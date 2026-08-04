/** Compact relative time: "ahora", "hace 5m", "hace 3h", "hace 2d", or a date. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'ahora';
  if (min < 60) return `hace ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `hace ${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `hace ${day}d`;
  return new Date(iso).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}
