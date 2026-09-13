export interface LiveTranscriptLine {
  id?: string;
  text: string;
  isFinal: boolean;
  speaker: string | null;
  at: number;
  role?: 'user' | 'assistant';
  source?: 'gpt-live';
  startMs?: number;
  endMs?: number;
  fragments?: Array<{ text: string; startMs?: number; endMs?: number }>;
}

export function isGptLiveLine(line: LiveTranscriptLine): boolean {
  return line.source === 'gpt-live' && typeof line.id === 'string' && line.id.length > 0;
}

function sameLegacyLine(a: LiveTranscriptLine, b: LiveTranscriptLine): boolean {
  return a.at === b.at && a.text === b.text && a.speaker === b.speaker;
}

/**
 * GPT Live publishes growing display rows whose ids remain stable. Deepgram's
 * non-final result still belongs in the separate, replaceable interim slot.
 */
export function upsertDisplayLine(
  lines: LiveTranscriptLine[],
  incoming: LiveTranscriptLine,
): LiveTranscriptLine[] {
  if (isGptLiveLine(incoming)) {
    const index = lines.findIndex((line) => isGptLiveLine(line) && line.id === incoming.id);
    if (index < 0) return [...lines, incoming];
    const existing = lines[index];
    if (!existing) return [...lines, incoming];
    const incomingProgress = incoming.endMs ?? incoming.fragments?.at(-1)?.endMs;
    const existingProgress = existing.endMs ?? existing.fragments?.at(-1)?.endMs;
    if (
      (incomingProgress !== undefined &&
        existingProgress !== undefined &&
        incomingProgress < existingProgress) ||
      (incomingProgress === undefined &&
        existingProgress === undefined &&
        incoming.text.length < existing.text.length)
    ) {
      return lines;
    }
    const next = [...lines];
    next[index] = incoming;
    return next;
  }
  if (!incoming.isFinal || lines.some((line) => sameLegacyLine(line, incoming))) return lines;
  return [...lines, incoming];
}

export function mergeTranscriptSnapshot(
  current: LiveTranscriptLine[],
  snapshot: LiveTranscriptLine[],
): LiveTranscriptLine[] {
  return snapshot
    .filter((line) => line.isFinal !== false || isGptLiveLine(line))
    .reduce(upsertDisplayLine, current);
}
