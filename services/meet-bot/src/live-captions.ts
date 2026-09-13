import type { Transcript } from './deepgram';

export interface LiveTranscriptFragment {
  role: 'user' | 'assistant';
  text: string;
  startMs?: number;
  endMs?: number;
}

/** Display grouping only: Live does not emit authoritative completed turns. */
export class LiveCaptions {
  private rows: Transcript[] = [];
  private sequence = 0;
  constructor(
    private readonly prefix: string,
    private readonly offsetSeconds: number,
  ) {}

  append(fragment: LiveTranscriptFragment, fallbackMs: number): Transcript {
    const startMs = fragment.startMs ?? fallbackMs;
    const endMs = fragment.endMs ?? startMs;
    let row = [...this.rows]
      .reverse()
      .find(
        (candidate) =>
          candidate.role === fragment.role &&
          startMs >= (candidate.startMs ?? 0) &&
          startMs <= (candidate.endMs ?? 0) + 1800 &&
          candidate.text.length < 1500,
      );
    if (!row) {
      row = {
        id: `${this.prefix}:${++this.sequence}`,
        source: 'gpt-live',
        role: fragment.role,
        text: '',
        isFinal: false,
        speaker: null,
        at: this.offsetSeconds + startMs / 1000,
        startMs,
        endMs,
        fragments: [],
      };
      this.rows.push(row);
      if (this.rows.length > 200) this.rows.shift();
    }
    row.fragments?.push({ text: fragment.text, startMs, endMs });
    row.fragments?.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    row.text = row.fragments?.map((part) => part.text).join('') ?? '';
    row.endMs = Math.max(row.endMs ?? endMs, endMs);
    return { ...row, fragments: row.fragments?.map((part) => ({ ...part })) };
  }
}

export function retainTranscript(rows: Transcript[], line: Transcript): void {
  if (line.source === 'gpt-live' && line.id) {
    const index = rows.findIndex((row) => row.id === line.id);
    if (index >= 0) rows[index] = line;
    else rows.push(line);
  } else if (line.isFinal) rows.push(line);
}
