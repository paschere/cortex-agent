/** Compare persisted inputs without depending on JSON object key order. */
export function canonicalInput(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalInput(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

/** Recover legacy intermediate results only from server-persisted parts.
 * A recorded result always wins, including claimed, failed and completed calls.
 */
export function confirmationResults(
  results: unknown,
  parts: unknown,
): Array<Record<string, unknown>> {
  const saved = Array.isArray(results) ? results.filter((r) => r && typeof r === 'object') : [];
  const ids = new Set(saved.map((r) => r.toolCallId));
  const recovered = Array.isArray(parts)
    ? parts.flatMap((part) => {
        const invocation = part?.type === 'tool-invocation' ? part.toolInvocation : null;
        if (
          invocation?.state !== 'result' ||
          typeof invocation.toolCallId !== 'string' ||
          ids.has(invocation.toolCallId)
        )
          return [];
        return [
          {
            toolCallId: invocation.toolCallId,
            toolName: invocation.toolName,
            args: invocation.args,
            result: invocation.result,
          },
        ];
      })
    : [];
  return [...saved, ...recovered];
}
export function pendingConfirmationIndex(
  results: unknown,
  toolId: string,
  input: unknown,
  toolCallId?: string,
): number {
  if (!Array.isArray(results)) return -1;
  const matches = results.flatMap((entry, i) => {
    const result = entry?.result;
    return result?.__requires_confirmation === true &&
      result.toolId === toolId &&
      (!toolCallId || entry.toolCallId === toolCallId) &&
      canonicalInput(result.input) === canonicalInput(input)
      ? [i]
      : [];
  });
  return matches.length === 1 ? (matches[0] ?? -1) : -1;
}
