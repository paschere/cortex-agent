/**
 * SSE del cerebro (voice-answer) y corte en cláusulas para el TTS.
 */

/** Fin de oración, no miles/decimales ni comas de inciso. «4.247,52» no se parte. */
export const VOICE_CLAUSE = /^([\s\S]*?(?<!\d)[.!?…]+)(\s+)([\s\S]*)$/;

export function takeClauses(buf: string): { clauses: string[]; rest: string } {
  const clauses: string[] = [];
  let rest = buf;
  let m = rest.match(VOICE_CLAUSE);
  while (m) {
    const c = (m[1] ?? '').trim();
    if (c) clauses.push(c);
    rest = m[3] ?? '';
    m = rest.match(VOICE_CLAUSE);
  }
  return { clauses, rest };
}

export function parseSseBlock(block: string): { event: string; data: string } {
  let event = 'message';
  const dataLines: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^\s/, ''));
  }
  return { event, data: dataLines.join('\n') };
}

export function sseBlockToText(block: string): { text: string | null; done: boolean } {
  const { event, data } = parseSseBlock(block);
  if (event === 'done' || event === 'error') return { text: null, done: true };
  if (event !== 'text' && event !== 'message') return { text: null, done: false };
  try {
    const parsed = JSON.parse(data) as { text?: string; answer?: string };
    return { text: (parsed.text || parsed.answer || '').trim() || null, done: false };
  } catch {
    return { text: data.trim() || null, done: false };
  }
}

export async function* readVoiceAnswerStream(res: Response): AsyncGenerator<string> {
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!ctype.includes('text/event-stream')) {
    const data = (await res.json().catch(() => null)) as { answer?: string } | null;
    const answer = data?.answer?.trim();
    if (answer) yield answer;
    return;
  }
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx = buf.indexOf('\n\n');
    while (idx >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const parsed = sseBlockToText(raw);
      if (parsed.text) yield parsed.text;
      if (parsed.done) return;
      idx = buf.indexOf('\n\n');
    }
  }
}

/** Cola para arrancar el fetch del cerebro mientras suena el «dame un minuto». */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(v: T): void {
    this.items.push(v);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    while (this.waiters.length) this.waiters.shift()?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const next = this.items.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}
