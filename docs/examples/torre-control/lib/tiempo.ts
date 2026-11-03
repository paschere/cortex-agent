/** Horas y fechas en Bogotá (UTC-5, sin horario de verano). */
const BOGOTA_MS = -5 * 3600_000;

export function hoyBogota(now = Date.now()): string {
  return new Date(now + BOGOTA_MS).toISOString().slice(0, 10);
}

/** Minutos desde ahora hasta la hora HH:MM de la fecha AAAA-MM-DD (negativo = ya pasó). */
export function minutosHasta(fecha: string, hora: string, now = Date.now()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !/^\d{1,2}:\d{2}/.test(hora)) return null;
  const [h, m] = hora.split(':').map(Number);
  const t = Date.parse(`${fecha}T00:00:00Z`) + ((h as number) * 60 + (m as number)) * 60_000 - BOGOTA_MS;
  return Math.round((t - now) / 60_000);
}

export function textoMinutos(min: number | null): string {
  if (min === null) return 'sin hora';
  const abs = Math.abs(min);
  const t = abs >= 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${abs} min`;
  return min >= 0 ? `en ${t}` : `hace ${t}`;
}

/** Minutos transcurridos desde una hora HH:MM de hoy. */
export function minutosDesde(hora: string, now = Date.now()): number | null {
  const m = minutosHasta(hoyBogota(now), hora, now);
  return m === null ? null : -m;
}

export const texto = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    // Las relaciones llegan como {"id","label"}.
    if (v.startsWith('{')) {
      try {
        const o = JSON.parse(v) as { label?: string };
        if (o.label) return o.label;
      } catch {}
    }
    return v;
  }
  return String(v);
};
