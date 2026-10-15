/**
 * MOVIMIENTOS FUERA DE LO NORMAL, PARA EL CIERRE (0228). Puro.
 *
 * Tres señales baratas y explicables, sin modelo: un monto muy por encima de lo
 * habitual en su categoría, un posible duplicado (misma contraparte y mismo
 * valor en pocos días) y una categoría cuyo total del mes se disparó contra
 * los meses anteriores. Cada hallazgo dice qué vio en una frase, porque la
 * persona lo va a revisar o a explicar, no a creerle a ciegas.
 *
 * No decide que algo esté mal: una compra grande de inventario es normal. Por
 * eso el cierre lo deja como tarea que se da por hecha con evidencia.
 */

export interface MovementLite {
  id: string;
  date: string;
  amount: number;
  direction: 'in' | 'out';
  category: string | null;
  counterparty: string | null;
}

export type UnusualKind = 'monto_alto' | 'duplicado' | 'categoria_disparada';

export interface Unusual {
  kind: UnusualKind;
  label: string;
  amount: number;
  /** Movimientos involucrados (para el detalle). */
  ids: string[];
  category: string | null;
}

/** Un monto es «alto» desde este múltiplo de la mediana de su categoría. */
export const HIGH_AMOUNT_FACTOR = 3;
/** Historia mínima de la categoría para poder decir qué es lo habitual. */
export const MIN_HISTORY = 4;
/** Debajo de esto un monto no merece una alerta aunque sea «alto» (pesos). */
export const MIN_ALERT_AMOUNT = 500_000;
/** Ventana para dos movimientos iguales (días). */
export const DUPLICATE_DAYS = 5;
/** Una categoría se «dispara» cuando su mes pasa de este múltiplo del promedio. */
export const SURGE_FACTOR = 2;
export const MIN_SURGE_INCREASE = 1_000_000;
/** Cuántos hallazgos se devuelven como máximo. */
export const MAX_FINDINGS = 12;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function norm(text: string | null): string {
  return (text ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function dayNumber(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

function pesos(n: number): string {
  return `$ ${Math.round(n).toLocaleString('es-CO')}`;
}

function categoryName(category: string | null): string {
  if (!category) return 'sin categoría';
  const t = category.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * `month`: los movimientos del mes que se cierra; `prior`: los de los meses
 * anteriores (hasta 3), de donde sale lo habitual. Sólo se miran las salidas:
 * una venta grande no es una alerta de cierre.
 */
export function findUnusualMovements(
  month: readonly MovementLite[],
  prior: readonly MovementLite[],
): Unusual[] {
  const out: Unusual[] = [];
  const spend = month.filter((m) => m.direction === 'out' && m.amount > 0);
  const history = prior.filter((m) => m.direction === 'out' && m.amount > 0);

  // 1. Un monto muy por encima de lo habitual de su categoría.
  const byCategory = new Map<string, number[]>();
  for (const m of history) {
    const k = m.category ?? 'sin_categoria';
    byCategory.set(k, [...(byCategory.get(k) ?? []), m.amount]);
  }
  for (const m of spend) {
    const past = byCategory.get(m.category ?? 'sin_categoria') ?? [];
    if (past.length < MIN_HISTORY) continue;
    const typical = median(past);
    if (typical <= 0) continue;
    if (m.amount >= typical * HIGH_AMOUNT_FACTOR && m.amount >= MIN_ALERT_AMOUNT) {
      out.push({
        kind: 'monto_alto',
        category: m.category,
        amount: m.amount,
        ids: [m.id],
        label: `${pesos(m.amount)} en ${categoryName(m.category).toLowerCase()}${m.counterparty ? ` (${m.counterparty})` : ''}, ${(m.amount / typical).toFixed(1).replace('.', ',')} veces lo habitual`,
      });
    }
  }

  // 2. Posibles duplicados: misma contraparte y valor, a pocos días.
  const seen = new Set<string>();
  const sorted = [...spend].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i] as MovementLite;
    const who = norm(a.counterparty);
    if (!who || seen.has(a.id) || a.amount < 100_000) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j] as MovementLite;
      if (dayNumber(b.date) - dayNumber(a.date) > DUPLICATE_DAYS) break;
      if (seen.has(b.id)) continue;
      if (norm(b.counterparty) === who && Math.abs(b.amount - a.amount) < 0.5) {
        seen.add(a.id);
        seen.add(b.id);
        out.push({
          kind: 'duplicado',
          category: a.category,
          amount: a.amount,
          ids: [a.id, b.id],
          label: `posible duplicado: ${pesos(a.amount)} a ${a.counterparty} dos veces (${a.date.slice(8)}/${a.date.slice(5, 7)} y ${b.date.slice(8)}/${b.date.slice(5, 7)})`,
        });
        break;
      }
    }
  }

  // 3. Categorías disparadas contra el promedio de los meses anteriores.
  const monthKeys = [...new Set(history.map((m) => m.date.slice(0, 7)))];
  if (monthKeys.length >= 2) {
    const total = (rows: readonly MovementLite[], cat: string) =>
      rows.filter((r) => (r.category ?? 'sin_categoria') === cat).reduce((s, r) => s + r.amount, 0);
    const cats = new Set(spend.map((m) => m.category ?? 'sin_categoria'));
    for (const cat of cats) {
      const now = total(spend, cat);
      const avg = total(history, cat) / monthKeys.length;
      if (avg <= 0) continue;
      if (now >= avg * SURGE_FACTOR && now - avg >= MIN_SURGE_INCREASE) {
        out.push({
          kind: 'categoria_disparada',
          category: cat === 'sin_categoria' ? null : cat,
          amount: now,
          ids: spend
            .filter((m) => (m.category ?? 'sin_categoria') === cat)
            .slice(0, 5)
            .map((m) => m.id),
          label: `${categoryName(cat === 'sin_categoria' ? null : cat)} suma ${pesos(now)} este mes contra ${pesos(avg)} en promedio`,
        });
      }
    }
  }

  return out.sort((a, b) => b.amount - a.amount).slice(0, MAX_FINDINGS);
}
