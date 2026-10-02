import {
  type RecommendationKind,
  type RecommendationOutcome,
  type RecommendationStatus,
  type Severity,
  UNMEASURABLE_KINDS,
  isPinnedRecommendation,
} from './shape';

/**
 * APRENDER QUÉ CONSEJOS SIRVEN AQUÍ — SIN DEJAR DE DECIR LO URGENTE.
 *
 * Cada empresa es distinta: en una, «cóbrale primero a quien más debe» se sigue
 * siempre y el cliente paga; en otra, «reparte la carga de Laura» se ignora
 * semana tras semana. Seguir recomendando lo ignorado con la misma fuerza
 * enseña a no leer la revisión. Así que, por empresa y por TIPO de consejo, se
 * lleva la cuenta: cuántos se evaluaron, cuántos se siguieron y en cuántos lo
 * que debía moverse se movió (acierto = seguida Y desenlace bueno).
 *
 * ===========================================================================
 * TRES FRENOS, PORQUE ESTO DECIDE QUÉ SE DEJA DE DECIR
 * ===========================================================================
 *   1. ACOTADO. El peso de un tipo va de 0,7 a 1,3. Un consejo ignorado baja un
 *      puesto o dos; no desaparece. Uno que funciona sube; no tapa lo urgente.
 *   2. CON MUESTRA. Menos de tres evaluados de un tipo = peso 1. Dos semanas
 *      malas no son un patrón.
 *   3. LO CRÍTICO NO SE ORDENA. La caja en rojo, la cartera vencida y toda
 *      señal crítica entran siempre, primero y en su orden de urgencia
 *      (`isPinnedRecommendation`). El aprendizaje sólo reparte los puestos que
 *      quedan.
 *
 * El acierto se suaviza (Laplace: (aciertos+1)/(evaluados+2)) para que un 1 de
 * 1 no valga lo mismo que un 10 de 10. Puro y probado: recibe la historia y los
 * candidatos, devuelve el orden.
 */

/** Cuántos evaluados hacen falta para que un tipo pese distinto de 1. */
export const MIN_SAMPLE_FOR_WEIGHT = 3;
export const MIN_KIND_WEIGHT = 0.7;
export const MAX_KIND_WEIGHT = 1.3;

export interface KindHistory {
  kind: RecommendationKind;
  status: RecommendationStatus;
  outcome: RecommendationOutcome | null;
}

export interface KindStats {
  kind: RecommendationKind;
  /** Seguidas + no seguidas: las que ya tienen veredicto. */
  evaluated: number;
  followed: number;
  ignored: number;
  /** Seguidas y con desenlace bueno. */
  hits: number;
}

export function kindStats(history: readonly KindHistory[]): Map<RecommendationKind, KindStats> {
  const out = new Map<RecommendationKind, KindStats>();
  for (const h of history) {
    if (UNMEASURABLE_KINDS.has(h.kind)) continue;
    if (h.status !== 'followed' && h.status !== 'not_followed') continue;
    const s = out.get(h.kind) ?? { kind: h.kind, evaluated: 0, followed: 0, ignored: 0, hits: 0 };
    s.evaluated += 1;
    if (h.status === 'followed') {
      s.followed += 1;
      if (h.outcome === 'good') s.hits += 1;
    } else s.ignored += 1;
    out.set(h.kind, s);
  }
  return out;
}

/** Acierto suavizado de un tipo, entre 0 y 1. */
export function hitRate(s: KindStats | undefined): number {
  if (!s) return 0.5;
  return (s.hits + 1) / (s.evaluated + 2);
}

/** El peso de un tipo en esta empresa, siempre entre 0,7 y 1,3. */
export function kindWeight(s: KindStats | undefined): number {
  if (!s || s.evaluated < MIN_SAMPLE_FOR_WEIGHT) return 1;
  const ignoredShare = s.ignored / s.evaluated;
  const raw = 1 + 0.6 * (hitRate(s) - 0.5) - 0.3 * Math.max(0, ignoredShare - 0.5);
  return Math.min(MAX_KIND_WEIGHT, Math.max(MIN_KIND_WEIGHT, Math.round(raw * 1000) / 1000));
}

export interface RankCandidate {
  kind: RecommendationKind;
  severity: Severity;
}

/** El puntaje base por urgencia: el primero 1, cada puesto de abajo un 15 % menos. */
function base(position: number): number {
  return Math.max(0.05, 1 - 0.15 * position);
}

/**
 * Los mejores `limit`, en el orden en que se dicen.
 *
 * `candidates` llega en orden de urgencia (el que arma cada fuente). Primero
 * entran los fijos, en ese orden; después, por puntaje = urgencia × peso del
 * tipo, los demás hasta llenar. A igual puntaje manda la urgencia original.
 * Ningún aprendizaje puede sacar a un fijo: sólo cabe que haya más fijos que
 * puestos, y entonces entran los más urgentes.
 */
export function rankRecommendations<T extends RankCandidate>(
  candidates: readonly T[],
  stats: ReadonlyMap<RecommendationKind, KindStats>,
  limit = 3,
): T[] {
  const indexed = candidates.map((c, i) => ({ c, i }));
  const pinned = indexed.filter(({ c }) => isPinnedRecommendation(c));
  const rest = indexed
    .filter(({ c }) => !isPinnedRecommendation(c))
    .map(({ c, i }) => ({ c, i, score: base(i) * kindWeight(stats.get(c.kind)) }))
    .sort((a, b) => b.score - a.score || a.i - b.i);
  // Los fijos van delante, así que el tope sólo puede dejar fuera a otro fijo
  // cuando hay más fijos que puestos — y entonces manda su urgencia.
  const chosen = [...pinned, ...rest].slice(0, limit);
  return chosen.map(({ c }) => c);
}
