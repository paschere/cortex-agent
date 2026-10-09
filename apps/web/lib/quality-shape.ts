/**
 * Lo puro del panel de salud interna: percentiles, agrupar fallos, razón 👍/👎.
 * Sin base de datos ni `server-only`, para probarlo.
 */

export interface LatencyRow {
  total_ms: number;
  message_id: string | null;
}

export interface FeedbackLite {
  rating: number;
  reason: string | null;
  comment: string | null;
  created_at: string;
}

export interface QualitySummary {
  turns: number;
  /** Turnos cuya respuesta no llegó a guardarse (cortados o fallidos). */
  brokenTurns: number;
  brokenRatio: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  failingTools: Array<{ toolId: string; errors: number }>;
  up: number;
  down: number;
  latestDown: Array<{ reason: string | null; comment: string; createdAt: string }>;
}

/** Percentil por rango más cercano; null si no hay datos. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export function summarizeQuality(input: {
  latencies: readonly LatencyRow[];
  errorToolIds: readonly string[];
  feedback: readonly FeedbackLite[];
}): QualitySummary {
  const turns = input.latencies.length;
  const brokenTurns = input.latencies.filter((l) => !l.message_id).length;
  const totals = input.latencies.map((l) => l.total_ms).filter((n) => Number.isFinite(n));

  const counts = new Map<string, number>();
  for (const id of input.errorToolIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const failingTools = [...counts.entries()]
    .map(([toolId, errors]) => ({ toolId, errors }))
    .sort((a, b) => b.errors - a.errors || a.toolId.localeCompare(b.toolId))
    .slice(0, 5);

  const down = input.feedback.filter((f) => f.rating === -1);
  return {
    turns,
    brokenTurns,
    brokenRatio: turns > 0 ? brokenTurns / turns : null,
    p50Ms: percentile(totals, 50),
    p95Ms: percentile(totals, 95),
    failingTools,
    up: input.feedback.filter((f) => f.rating === 1).length,
    down: down.length,
    latestDown: down
      .filter((f) => f.comment && f.comment.trim().length > 0)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, 5)
      .map((f) => ({
        reason: f.reason,
        comment: (f.comment as string).slice(0, 240),
        createdAt: f.created_at,
      })),
  };
}
