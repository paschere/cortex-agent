import type { ToolInvocation } from 'ai';

interface StoredToolCall {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
}

interface StoredToolResult {
  toolCallId?: string;
  result?: unknown;
}

/**
 * Rebuilds AI SDK tool invocations from the `tool_calls` / `tool_results`
 * columns so a persisted conversation renders the same ToolCallCards the live
 * chat showed, instead of dropping everything the agent actually did.
 *
 * A call with no matching result stays in the 'call' state — that is a turn
 * that was interrupted, and showing it as still-running is the truth.
 */
export function toToolInvocations(
  toolCalls: unknown,
  toolResults: unknown,
): ToolInvocation[] | undefined {
  const calls = Array.isArray(toolCalls) ? (toolCalls as StoredToolCall[]) : [];
  if (calls.length === 0) return undefined;

  const results = Array.isArray(toolResults) ? (toolResults as StoredToolResult[]) : [];
  const resultMap = new Map(results.map((r) => [r.toolCallId, r.result]));

  return calls.map((tc, i) => {
    const toolCallId = tc.toolCallId ?? `call-${i}`;
    const base = {
      toolCallId,
      toolName: tc.toolName ?? 'unknown',
      args: tc.args,
    };
    return resultMap.has(tc.toolCallId)
      ? { ...base, state: 'result' as const, result: resultMap.get(tc.toolCallId) }
      : { ...base, state: 'call' as const };
  }) as ToolInvocation[];
}
