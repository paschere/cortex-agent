/**
 * UNIR LAS PIEZAS EN UNA TABLA. Puro: sin red ni modelo.
 *
 * Cada pieza devuelve una ficha (`values` por campo, notas, fuentes). Aquí se
 * normalizan los valores, se ponen en el orden del encargo y se arma el
 * resultado que ve el modelo y la tarjeta del chat (columnas + filas + resumen
 * + cuántas faltan + tokens).
 */

export type FieldKind = 'text' | 'number' | 'money' | 'date';

export interface ResearchField {
  key: string;
  label: string;
  kind: FieldKind;
  description?: string | undefined;
}

export interface ResearchItem {
  id: string;
  label: string;
  context?: string | undefined;
}

export type ItemStatus = 'Listo' | 'Parcial' | 'Sin dato' | 'Error';
export type Scalar = string | number | boolean | null;

export interface ItemOutcome {
  status: ItemStatus;
  values: Record<string, unknown>;
  notes: string;
  sources: string[];
  promptTokens: number;
  completionTokens: number;
  steps: number;
  toolCalls: number;
  ms: number;
  error?: string;
}

export interface ResearchRow {
  id: string;
  label: string;
  status: ItemStatus;
  values: Record<string, Scalar>;
  notes: string;
  sources: string;
}

const MAX_TEXT = 300;

/** Un valor suelto → escalar legible, respetando el tipo del campo. */
export function coerceValue(kind: FieldKind, raw: unknown): Scalar {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text || /^(n\/a|na|null|none|desconocido|no encontrado|sin dato)$/i.test(text)) return null;
  if (kind === 'number' || kind === 'money') {
    // Sólo se convierte lo que es un número sin ambigüedad; "1.234,5" se deja
    // como texto antes que adivinar si el punto es de miles o de decimales.
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  }
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function normalizeValues(
  fields: readonly ResearchField[],
  values: Record<string, unknown> | undefined,
): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const f of fields) out[f.key] = coerceValue(f.kind, values?.[f.key]);
  return out;
}

/** Cuántos campos quedaron con dato. */
export function filledCount(values: Record<string, Scalar>): number {
  return Object.values(values).filter((v) => v !== null).length;
}

/**
 * Estado de una pieza que SÍ entregó ficha: todo lleno = Listo, algo = Parcial,
 * nada = Sin dato. Un fallo (error, tiempo) se marca antes, aparte.
 */
export function statusFromValues(values: Record<string, Scalar>): ItemStatus {
  const filled = filledCount(values);
  const total = Object.keys(values).length;
  if (filled === 0) return 'Sin dato';
  return filled === total ? 'Listo' : 'Parcial';
}

export function buildRow(
  item: ResearchItem,
  outcome: ItemOutcome,
  fields: readonly ResearchField[],
): ResearchRow {
  const values = normalizeValues(fields, outcome.values);
  // «Parcial» sin ficha (la pieza se quedó sin pasos) se respeta: no es lo mismo
  // que haber buscado y no encontrado nada.
  const status: ItemStatus =
    outcome.status === 'Error'
      ? 'Error'
      : outcome.status === 'Parcial' && filledCount(values) === 0
        ? 'Parcial'
        : statusFromValues(values);
  const notes = (outcome.error && status === 'Error' ? outcome.error : outcome.notes)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return {
    id: item.id,
    label: item.label,
    status,
    values,
    notes,
    sources: [...new Set(outcome.sources.map((s) => s.trim()).filter(Boolean))]
      .slice(0, 4)
      .join(' · '),
  };
}

/** Columnas para la rejilla del chat (`values.<clave>` baja un nivel). */
export function gridColumns(fields: readonly ResearchField[]) {
  return [
    { key: 'label', label: 'Elemento', kind: 'text' as const },
    ...fields.map((f) => ({
      key: `values.${f.key}`,
      label: f.label,
      kind: f.kind === 'text' ? ('text' as const) : f.kind,
    })),
    { key: 'status', label: 'Estado', kind: 'text' as const },
    { key: 'notes', label: 'Notas y fuentes', kind: 'text' as const },
  ];
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  subRuns: number;
  toolCalls: number;
}

export function sumUsage(outcomes: readonly ItemOutcome[]): Usage {
  let promptTokens = 0;
  let completionTokens = 0;
  let toolCalls = 0;
  for (const o of outcomes) {
    promptTokens += o.promptTokens;
    completionTokens += o.completionTokens;
    toolCalls += o.toolCalls;
  }
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    subRuns: outcomes.length,
    toolCalls,
  };
}

export type StopReason = 'tiempo' | 'presupuesto' | 'cancelado' | null;

export function summaryText(args: {
  requested: number;
  rows: readonly ResearchRow[];
  remaining: number;
  stopReason: StopReason;
}): string {
  const count = (s: ItemStatus) => args.rows.filter((r) => r.status === s).length;
  const parts = [
    `Investigué ${args.rows.length} de ${args.requested}`,
    `${count('Listo')} completos, ${count('Parcial')} parciales, ${count('Sin dato')} sin dato, ${count('Error')} con error`,
  ];
  let text = `${parts[0]}: ${parts[1]}.`;
  if (args.remaining > 0) {
    const why =
      args.stopReason === 'tiempo'
        ? 'por el tiempo de este turno'
        : args.stopReason === 'presupuesto'
          ? 'por el tope de gasto'
          : 'porque se canceló';
    text += ` Faltan ${args.remaining} ${why}: vuelve a llamar con los pendientes (campo \`pending\`) o ejecútalo como tarea en segundo plano.`;
  }
  return text;
}

export interface ResearchResult {
  goal: string;
  columns: ReturnType<typeof gridColumns>;
  rows: ResearchRow[];
  summary: string;
  counts: {
    requested: number;
    processed: number;
    complete: number;
    partial: number;
    noData: number;
    error: number;
  };
  /** Cuántas piezas no alcanzaron a empezar («faltan N»). */
  remaining: number;
  /** Las piezas que faltan, listas para pasarlas tal cual en otra llamada. */
  pending: ResearchItem[];
  stopReason: StopReason;
  /** true = conviene seguir como tarea en segundo plano / otra llamada. */
  runInBackground: boolean;
  usage: Usage;
  model: string;
  elapsedMs: number;
}

export function buildResult(args: {
  goal: string;
  fields: readonly ResearchField[];
  items: readonly ResearchItem[];
  /** Una por pieza que empezó, con su elemento. En el orden original. */
  done: ReadonlyArray<{ item: ResearchItem; outcome: ItemOutcome }>;
  notStarted: readonly ResearchItem[];
  stopReason: StopReason;
  model: string;
  elapsedMs: number;
}): ResearchResult {
  const rows = args.done.map((d) => buildRow(d.item, d.outcome, args.fields));
  const count = (s: ItemStatus) => rows.filter((r) => r.status === s).length;
  const remaining = args.notStarted.length;
  return {
    goal: args.goal,
    columns: gridColumns(args.fields),
    rows,
    summary: summaryText({
      requested: args.items.length,
      rows,
      remaining,
      stopReason: args.stopReason,
    }),
    counts: {
      requested: args.items.length,
      processed: rows.length,
      complete: count('Listo'),
      partial: count('Parcial'),
      noData: count('Sin dato'),
      error: count('Error'),
    },
    remaining,
    pending: args.notStarted.map((i) => ({
      id: i.id,
      label: i.label,
      ...(i.context ? { context: i.context } : {}),
    })),
    stopReason: remaining > 0 ? args.stopReason : null,
    runInBackground: remaining > 0,
    usage: sumUsage(args.done.map((d) => d.outcome)),
    model: args.model,
    elapsedMs: args.elapsedMs,
  };
}
