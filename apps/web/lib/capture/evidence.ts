/**
 * FOTOS CON EVIDENCIA — la parte pura.
 *
 * Una foto de entrega o de inspección vale más si dice CUÁNDO y DÓNDE se tomó y
 * quién la tomó. Con `evidence` el campo guarda la fecha y hora (del teléfono) y
 * el GPS (si la persona lo permite) dentro del archivo; con `watermark` además
 * se queman en la imagen, abajo, para que viajen con la foto aunque la copien.
 *
 * La hora es la del teléfono: sirve como evidencia de contexto, no es una
 * prueba. El servidor guarda además cuándo llegó el archivo.
 */

const TZ = 'America/Bogota';

export interface Evidence {
  /** ISO de cuándo se tomó. */
  takenAt: string;
  lat?: number;
  lng?: number;
  /** Precisión del GPS en metros. */
  accuracy?: number;
}

export interface GpsFix {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
}

/** «12/10/2026 14:32» en hora de Colombia, sin depender de la zona del teléfono. */
export function formatStamp(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('es-CO', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}/${get('month')}/${get('year')} ${get('hour')}:${get('minute')}`;
}

/** «4.71099, -74.07209» con 5 decimales (≈ 1 m). */
export function coordLabel(lat: number, lng: number): string {
  return `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
}

/** La evidencia de una foto tomada ahora; sin GPS (negado o sin señal) queda sólo la hora. */
export function buildEvidence(now: Date, fix?: GpsFix | null): Evidence {
  const ev: Evidence = { takenAt: now.toISOString() };
  if (
    fix &&
    Number.isFinite(fix.latitude) &&
    Number.isFinite(fix.longitude) &&
    Math.abs(fix.latitude) <= 90 &&
    Math.abs(fix.longitude) <= 180 &&
    !(fix.latitude === 0 && fix.longitude === 0)
  ) {
    ev.lat = Math.round(fix.latitude * 1e6) / 1e6;
    ev.lng = Math.round(fix.longitude * 1e6) / 1e6;
    if (fix.accuracy != null && Number.isFinite(fix.accuracy) && fix.accuracy >= 0)
      ev.accuracy = Math.round(fix.accuracy);
  }
  return ev;
}

/**
 * Las líneas de la marca de agua, de arriba abajo:
 *   «12/10/2026 14:32» · «4.71099, -74.07209 (±12 m)» · «Ana Gómez · Control de planta»
 * Sin GPS dice «Sin ubicación» para que se note que faltaba, no que se omitió.
 */
export function watermarkLines(input: {
  evidence: Evidence;
  user?: string | null;
  place?: string | null;
}): string[] {
  const { evidence } = input;
  const lines = [formatStamp(evidence.takenAt)];
  if (evidence.lat !== undefined && evidence.lng !== undefined) {
    const acc = evidence.accuracy !== undefined ? ` (±${evidence.accuracy} m)` : '';
    lines.push(`${coordLabel(evidence.lat, evidence.lng)}${acc}`);
  } else {
    lines.push('Sin ubicación');
  }
  const who = [input.user?.trim(), input.place?.trim()].filter(Boolean).join(' · ');
  if (who) lines.push(who.slice(0, 80));
  return lines.filter(Boolean);
}

/** La geometría de la marca: tamaño de letra y alto de la banda según el ancho de la imagen. */
export function watermarkLayout(
  width: number,
  height: number,
  lines: number,
): { font: number; pad: number; band: number; lineHeight: number } {
  const font = Math.max(14, Math.round(Math.min(width, height) * 0.032));
  const pad = Math.round(font * 0.6);
  const lineHeight = Math.round(font * 1.25);
  return { font, pad, lineHeight, band: pad * 2 + lineHeight * Math.max(lines, 1) };
}

/** Pega la evidencia a la descripción del archivo subido (`takenAt`, `lat`, `lng`, `accuracy`). */
export function withEvidence<T extends object>(
  file: T,
  evidence: Evidence | null,
): T & Partial<Evidence> {
  return evidence ? { ...file, ...evidence } : file;
}
