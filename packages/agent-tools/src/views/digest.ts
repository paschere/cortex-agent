import { type ViewSource, todayIn } from './compute';
import type { ViewDigest } from './spec';

/**
 * EL RESUMEN PERIÓDICO DE UNA VISTA: qué toca enviar y qué contar.
 *
 * Funciones puras. Lo que lee la base y manda el correo vive en
 * apps/web/inngest/functions/view-digest.ts; aquí sólo se decide CUÁNDO y
 * QUÉ, para poder probarlo sin infraestructura.
 *
 * La hora es la de Bogotá (UTC-5 fijo, sin horario de verano). Un resumen
 * «diario a las 8» toca desde las 8:00 de cada día y deja de tocar en cuanto
 * se reclama esa franja (`digest_last_sent_at` posterior a ella): un reloj que
 * llega tarde, un reintento o dos vueltas seguidas mandan UNO.
 */

export interface DigestCandidate {
  id: string;
  digest: ViewDigest;
  lastSentAt: Date | null;
}

/** 1 = lunes … 7 = domingo, del día AAAA-MM-DD. */
export function digestWeekday(day: string): number {
  return ((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

/** El inicio de la franja de hoy (hora de Bogotá) o null si hoy no toca ese día. */
export function digestSlotStart(digest: ViewDigest, now: Date): Date | null {
  const day = todayIn(now);
  if (digest.cadence === 'weekly' && digestWeekday(day) !== (digest.weekday ?? 1)) return null;
  return new Date(`${day}T${String(digest.hour).padStart(2, '0')}:00:00-05:00`);
}

/** ¿Toca mandar este resumen ahora? */
export function isDigestDue(digest: ViewDigest, lastSentAt: Date | null, now: Date): boolean {
  const slot = digestSlotStart(digest, now);
  if (!slot || now < slot) return false;
  return !lastSentAt || lastSentAt < slot;
}

/** De las vistas con resumen, las que tocan ahora. */
export function selectDueDigests<T extends DigestCandidate>(candidates: T[], now: Date): T[] {
  return candidates.filter(
    (c) => c.digest.recipients.length > 0 && isDigestDue(c.digest, c.lastSentAt, now),
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Desde cuándo cuentan las novedades: el último envío, o un período si es el primero. */
export function digestSince(digest: ViewDigest, lastSentAt: Date | null, now: Date): Date {
  return lastSentAt ?? new Date(now.getTime() - (digest.cadence === 'weekly' ? 7 : 1) * DAY_MS);
}

export interface DigestSourceSummary {
  name: string;
  /** Filas creadas desde `since`. */
  added: number;
  /** Filas que ya existían y cambiaron desde `since`. */
  changed: number;
  /** Filas con la marca de duplicado de la tabla, hoy. */
  flagged: number;
  /** Nombres de hasta cinco filas nuevas. */
  sample: string[];
}

/**
 * Novedades por fuente. Las fuentes que no se leyeron (`blocked`: personales,
 * del Feed, módulos apagados) no aportan nada: lo que no se leyó no viaja.
 */
export function summarizeSources(
  sources: Map<string, ViewSource>,
  since: Date,
): DigestSourceSummary[] {
  const t0 = since.getTime();
  const out: DigestSourceSummary[] = [];
  for (const src of sources.values()) {
    if (src.blocked) continue;
    const flag = src.tracker.alertFlag;
    const fresh = src.rows.filter((r) => Date.parse(r.created_at) > t0);
    const changed = src.rows.filter(
      (r) => Date.parse(r.created_at) <= t0 && Date.parse(r.updated_at) > t0,
    );
    const flagged = flag
      ? src.rows.filter((r) => String(r.values[flag.field] ?? '') === flag.value).length
      : 0;
    if (!fresh.length && !changed.length && !flagged) continue;
    out.push({
      name: src.tracker.name,
      added: fresh.length,
      changed: changed.length,
      flagged,
      sample: [...fresh]
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, 5)
        .map((r) => r.label),
    });
  }
  return out;
}
