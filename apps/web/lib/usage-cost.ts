import { rateFor, stepCostUsd } from '@/lib/model-pricing';

/**
 * EL COSTO DE CORTEX, EN PESOS, A PARTIR DEL CONSUMO REGISTRADO (0228). Puro.
 *
 * `model_usage` guarda enteros —entrada sin caché, lectura y escritura de
 * caché, salida— y el modelo; aquí se les pone precio con `model-pricing.ts`
 * (que elige la tarifa por la FECHA del consumo) y se agrupa por conversación,
 * tarea, persona, día y superficie. El caché cuenta: una lectura vale 0,1× la
 * entrada y una escritura 1,25×, así que sumar «tokens» sin separarlos
 * mentiría en ambos sentidos.
 *
 * Los modelos sin tarifa conocida suman sus tokens pero no su precio, y se
 * cuentan aparte (`unpriced`) para que la pantalla lo diga: inventar una
 * tarifa sería peor que no tenerla.
 */

/** Pesos por dólar cuando la empresa no fijó una (ajustes de la empresa). */
export const DEFAULT_USD_COP = 4000;

export interface UsageRow {
  userId: string | null;
  conversationId: string | null;
  taskId: string | null;
  surface: string;
  source: string;
  model: string;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  /** ISO. */
  at: string;
  /** Pasos (peticiones al modelo) del turno; parte el tramo largo de Haiku 5.5. */
  steps?: number;
  /** Fila del mensaje (para cruzar con 👍/👎). */
  messageId?: string | null;
  /** Experimento de modelos (0236). */
  arm?: 'haiku' | 'sonnet' | null;
  toolErrors?: number;
  retries?: number;
  refusals?: number;
  fellBack?: boolean;
}

export function rowTokens(r: Pick<UsageRow, 'input' | 'cacheRead' | 'cacheWrite' | 'output'>) {
  return r.input + r.cacheRead + r.cacheWrite + r.output;
}

/** Dólares de una fila, o null si el modelo no tiene tarifa conocida. */
export function rowCostUsd(r: UsageRow): number | null {
  const rate = rateFor(r.model, r.at);
  if (!rate) return null;
  return stepCostUsd(
    rate,
    { input: r.input, cacheRead: r.cacheRead, cacheWrite: r.cacheWrite, output: r.output },
    r.steps ?? 1,
  );
}

export interface CostTotals {
  usd: number;
  tokens: number;
  turns: number;
  /** Turnos de modelos sin tarifa: sus tokens están, su precio no. */
  unpriced: number;
}

const zero = (): CostTotals => ({ usd: 0, tokens: 0, turns: 0, unpriced: 0 });

function add(t: CostTotals, r: UsageRow): void {
  const usd = rowCostUsd(r);
  t.tokens += rowTokens(r);
  t.turns += 1;
  if (usd === null) t.unpriced += 1;
  else t.usd += usd;
}

export function sumUsage(rows: readonly UsageRow[]): CostTotals {
  const t = zero();
  for (const r of rows) add(t, r);
  return t;
}

/** Pesos redondeados de un monto en dólares. */
export function usdToCop(usd: number, rate: number): number {
  return Math.round(usd * rate);
}

/** «$ 1.240» (pesos completos). */
export function formatCop(usd: number, rate: number): string {
  return `$ ${usdToCop(usd, rate).toLocaleString('es-CO')}`;
}

/** «12.400 tokens». */
export function formatTokenCount(tokens: number): string {
  return `${Math.round(tokens).toLocaleString('es-CO')} ${Math.round(tokens) === 1 ? 'token' : 'tokens'}`;
}

/** La línea discreta de la cabecera: «$ 1.240 · 12.400 tokens». */
export function costLine(totals: CostTotals, rate: number): string {
  const money =
    totals.turns > 0 && totals.unpriced === totals.turns ? '—' : formatCop(totals.usd, rate);
  return `${money} · ${formatTokenCount(totals.tokens)}`;
}

/** El día de Bogotá (UTC−5, sin horario de verano) de un instante ISO. */
export function bogotaDay(iso: string): string {
  return new Date(Date.parse(iso) - 5 * 3_600_000).toISOString().slice(0, 10);
}

export interface DayCost {
  day: string;
  usd: number;
  tokens: number;
}

/** Una serie por día, rellenando los días sin consumo con cero. `days` termina en `today`. */
export function costByDay(rows: readonly UsageRow[], days: number, today: string): DayCost[] {
  const map = new Map<string, DayCost>();
  const end = Date.parse(`${today}T00:00:00Z`);
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(end - i * 86_400_000).toISOString().slice(0, 10);
    map.set(day, { day, usd: 0, tokens: 0 });
  }
  for (const r of rows) {
    const d = map.get(bogotaDay(r.at));
    if (!d) continue;
    d.usd += rowCostUsd(r) ?? 0;
    d.tokens += rowTokens(r);
  }
  return [...map.values()];
}

export interface GroupCost extends CostTotals {
  key: string;
}

function groupBy(rows: readonly UsageRow[], keyOf: (r: UsageRow) => string | null): GroupCost[] {
  const map = new Map<string, GroupCost>();
  for (const r of rows) {
    const key = keyOf(r);
    if (key === null) continue;
    let g = map.get(key);
    if (!g) {
      g = { key, ...zero() };
      map.set(key, g);
    }
    add(g, r);
  }
  return [...map.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

export const costByUser = (rows: readonly UsageRow[]) =>
  groupBy(rows, (r) => r.userId ?? 'sin-persona');
export const costBySurface = (rows: readonly UsageRow[]) =>
  groupBy(rows, (r) => r.surface || 'web');
export const costByConversation = (rows: readonly UsageRow[]) =>
  groupBy(rows, (r) => r.conversationId);
export const costByTask = (rows: readonly UsageRow[]) => groupBy(rows, (r) => r.taskId);

/** Las conversaciones más caras (por defecto 10). */
export function topConversations(rows: readonly UsageRow[], limit = 10): GroupCost[] {
  return costByConversation(rows).slice(0, limit);
}

/** Validación del dato que escribe una persona como tasa. */
export function parseUsdCopRate(raw: unknown): number | null {
  const n = Number(
    String(raw ?? '')
      .replace(/\./g, '')
      .replace(',', '.'),
  );
  return Number.isFinite(n) && n >= 500 && n <= 20000 ? Math.round(n * 100) / 100 : null;
}
