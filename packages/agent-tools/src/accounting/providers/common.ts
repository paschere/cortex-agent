/**
 * Ayudas puras que comparten los archivos de Alegra y QuickBooks para traducir
 * a la forma común: recortar texto, leer una fecha, leer un importe. Nada de
 * aquí habla con un programa.
 */

export function clip(value: unknown, max = 400): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

/** «2026-07-15», «2026-07-15T10:00:00-05:00» o «2026-07-15 13:46:50» → «2026-07-15». */
export function day(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim().slice(0, 10) : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

/** Un importe con dos decimales; acepta número o texto («100.00»). */
export function amount(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
}

export function currencyCode(raw: unknown): string | undefined {
  const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  return /^[A-Z]{3}$/.test(code) ? code : undefined;
}

export function monthsAgo(now: Date, months: number): string {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

export function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 24 * 60 * 60_000).toISOString().slice(0, 10);
}

/** El día en Bogotá de un instante: decide «ya es otro día». */
export function bogotaDay(iso: string | Date): string {
  const t = typeof iso === 'string' ? Date.parse(iso) : iso.getTime();
  return new Date(t - 5 * 60 * 60_000).toISOString().slice(0, 10);
}

/** La espera que pide un 429: `Retry-After` o un reinicio en segundos; si no, creciente. */
export function backoffMs(headers: Headers, attempt: number, resetHeader?: string): number {
  for (const name of ['retry-after', resetHeader].filter(Boolean) as string[]) {
    const seconds = Number(headers.get(name));
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 120_000);
  }
  return Math.min(5_000 * 2 ** (attempt - 1), 60_000);
}
