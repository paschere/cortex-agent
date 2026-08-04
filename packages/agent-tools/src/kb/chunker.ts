export interface Chunk {
  content: string;
  chunkIndex: number;
  tokens: number;
}

/**
 * Approximate token count: words * 1.3.
 *
 * Exported so the transcript chunker measures speech with exactly the same
 * ruler. Two chunkers with two different notions of "400 tokens" would produce
 * systematically different-sized embeddings for the same amount of meaning,
 * and hybrid search ranks them against each other.
 */
export function approxTokens(text: string): number {
  return Math.ceil(text.split(/\s+/).filter(Boolean).length * 1.3);
}

/**
 * Split text into segments. First tries paragraph boundaries (\n\n+),
 * then falls back to sentence boundaries for paragraphs that exceed targetTokens.
 */
function splitIntoSegments(text: string, targetTokens: number): string[] {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const segments: string[] = [];

  for (const para of paras) {
    if (approxTokens(para) <= targetTokens) {
      segments.push(para);
    } else {
      // Split long paragraph into sentences
      const sentences = para.split(/(?<=[.!?])\s+/).filter(Boolean);
      let buf = '';
      for (const sentence of sentences) {
        const candidate = buf ? `${buf} ${sentence}` : sentence;
        if (approxTokens(candidate) > targetTokens && buf) {
          segments.push(buf);
          buf = sentence;
        } else {
          buf = candidate;
        }
      }
      if (buf) segments.push(buf);
    }
  }

  return segments;
}

/**
 * Chunk text into token-bounded segments with overlap.
 * Defaults: targetTokens=400, overlap=50.
 */
export function chunkText(
  text: string,
  opts: { targetTokens?: number; overlap?: number } = {},
): Chunk[] {
  const targetTokens = opts.targetTokens ?? 400;
  const overlapTokens = opts.overlap ?? 50;

  const segments = splitIntoSegments(text, targetTokens);
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  const flush = () => {
    if (!buf.length) return;
    const content = buf.join('\n\n');
    chunks.push({ content, tokens: bufTokens, chunkIndex: chunks.length });

    // Build overlap from the tail of buf — only include segments that fit within overlapTokens
    const overlap: string[] = [];
    let oTokens = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      const seg = buf[i]!;
      const t = approxTokens(seg);
      if (oTokens + t > overlapTokens) break;
      overlap.unshift(seg);
      oTokens += t;
    }
    buf = [...overlap];
    bufTokens = oTokens;
  };

  for (const seg of segments) {
    const t = approxTokens(seg);
    if (bufTokens + t > targetTokens && buf.length) {
      flush();
    }
    buf.push(seg);
    bufTokens += t;
  }
  flush();

  return chunks;
}
