import type { AuditEventRow } from '@/app/api/admin/_lib/audit-filters';

/** Full timestamp for the `title` attribute and the detail drawer. */
export function absoluteTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function formatLatency(ms: number): string {
  if (!ms || ms <= 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Token usage recorded on a `__agent_turn` row. */
export function turnTokens(metadata: Record<string, unknown> | null): {
  model: string;
  tokensIn: number;
  tokensOut: number;
} {
  const m = metadata ?? {};
  return {
    model: typeof m.model === 'string' ? m.model : '',
    tokensIn: Number(m.tokensIn ?? 0) || 0,
    tokensOut: Number(m.tokensOut ?? 0) || 0,
  };
}

/**
 * The one line an auditor needs in the Detail column: why it was risky, what
 * broke, what scopes were missing, or what the turn cost.
 */
export function eventDetail(e: AuditEventRow): string | null {
  if (e.risk_reason) return e.risk_reason;
  const m = e.metadata ?? {};
  if (typeof m.error === 'string' && m.error) return m.error;
  if (typeof m.reason === 'string' && m.reason) {
    if (m.reason === 'missing_scopes') {
      const scopes = Array.isArray(m.scopes) ? m.scopes.join(', ') : '';
      return `missing ${String(m.provider ?? '')} scopes: ${scopes}`.trim();
    }
    return String(m.reason).replaceAll('_', ' ');
  }
  if (e.tool_id === '__agent_turn') {
    const { model, tokensIn, tokensOut } = turnTokens(e.metadata);
    if (tokensIn || tokensOut) {
      return `${model ? `${model} · ` : ''}${formatTokens(tokensIn)} in / ${formatTokens(tokensOut)} out tokens`;
    }
  }
  if (typeof m.summary === 'string' && m.summary) return m.summary;
  return null;
}

/** `__agent_turn` is synthetic — show it as what it actually is. */
export function isAgentTurn(toolId: string): boolean {
  return toolId === '__agent_turn';
}
