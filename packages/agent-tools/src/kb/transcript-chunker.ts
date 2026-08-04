import { approxTokens } from './chunker';
import type { SpeechTurn } from './transcribe';

/**
 * Chunking a conversation.
 *
 * WHY NOT THE TEXT CHUNKER. `chunkText` splits on paragraph and sentence
 * boundaries and counts characters on the way. Run it over a transcript and it
 * cuts wherever the count runs out — which lands mid-answer, orphaning the
 * second half of what someone said from the name of the person saying it. The
 * retrieved chunk then reads like an anonymous assertion, and the one question
 * this feature exists to answer ("what did the CLIENT promise?") cannot be
 * answered from it.
 *
 * So the unit here is the speech turn, and a turn is never broken to make a
 * chunk fit. Chunks grow by whole turns until the next one would push them
 * over target, and then they close early. A chunk that comes in at 300 tokens
 * because the next turn was long is a better chunk than a 400-token one that
 * ends mid-sentence.
 *
 * WHAT TRAVELS WITH IT. Every chunk carries `{ speaker, speakers, startMs,
 * endMs }` into `kb_chunks.metadata`, and every turn is rendered with its
 * speaker inline ("Ana: …"). The inline name is not decoration: the embedding
 * is computed from the chunk text, so "what Ana said about the deadline" only
 * retrieves Ana's turn if the name is IN the text being embedded. The metadata
 * is what the citation is built from; the inline name is what makes the chunk
 * findable in the first place.
 */

export interface TranscriptChunkMetadata {
  /** Who is speaking first in this chunk — the one the citation names. */
  speaker: string;
  /** Everyone heard in this chunk, in order, when it spans an exchange. */
  speakers: string[];
  startMs: number;
  endMs: number;
}

export interface TranscriptChunk {
  content: string;
  chunkIndex: number;
  tokens: number;
  metadata: TranscriptChunkMetadata;
}

/**
 * 350 tokens, slightly under the 400 the text chunker uses.
 *
 * Speech carries less per token than written prose — fillers, restarts,
 * confirmations — so an equal token budget buys noticeably less meaning, and
 * an over-long chunk dilutes its own embedding until it matches everything
 * weakly and nothing well. 350 tokens is roughly one to two minutes of
 * conversation at conversational speaking rates, which is about the span of a
 * single topic before someone changes it. It also keeps chunks close enough in
 * size to the text ones that hybrid search is not quietly biased toward or
 * against recordings.
 */
const TARGET_TOKENS = 350;

/**
 * A single turn longer than this is a monologue — a presenter, a dictated
 * memo, someone answering at length — and returning it whole would hand the
 * embedder a chunk several times the size of everything it is ranked against.
 * Past this ceiling, and only past it, the turn is split at sentence
 * boundaries, with the speaker prefix repeated on each piece and the offsets
 * interpolated across it, so a citation still points into the right minute.
 */
const MAX_TURN_TOKENS = 700;

/**
 * One turn of overlap between consecutive chunks.
 *
 * Conversation refers backwards constantly — "and when would that be?" / "the
 * 15th". Splitting those two turns into different chunks leaves one chunk with
 * a question nobody answers and another with a date about nothing. One turn is
 * enough to keep the adjacency and cheap enough not to duplicate the whole
 * transcript.
 */
const OVERLAP_TURNS = 1;

function renderTurn(turn: SpeechTurn): string {
  return `${turn.speaker}: ${turn.text}`;
}

/** Split an over-long monologue on sentence boundaries, keeping the speaker. */
function splitLongTurn(turn: SpeechTurn): SpeechTurn[] {
  const sentences = turn.text.split(/(?<=[.!?…])\s+/).filter(Boolean);
  if (sentences.length <= 1) return [turn];

  const pieces: SpeechTurn[] = [];
  const totalChars = turn.text.length || 1;
  const spanMs = Math.max(0, turn.endMs - turn.startMs);
  let consumed = 0;
  let buf: string[] = [];
  let bufChars = 0;

  // Offsets interpolated by character position. It is an approximation, but a
  // citation a few seconds out still drops the listener in the right place;
  // one that points at the start of a ten-minute monologue does not. Clamped
  // because the running character count includes the separators that
  // `join(' ')` will not reproduce exactly — a piece must never be timestamped
  // past the end of the turn it was cut from.
  const at = (chars: number) => turn.startMs + Math.round(Math.min(1, chars / totalChars) * spanMs);

  const flush = () => {
    if (!buf.length) return;
    const startMs = at(consumed);
    consumed += bufChars;
    pieces.push({ speaker: turn.speaker, startMs, endMs: at(consumed), text: buf.join(' ') });
    buf = [];
    bufChars = 0;
  };

  for (const sentence of sentences) {
    const candidate = buf.length ? `${buf.join(' ')} ${sentence}` : sentence;
    if (buf.length && approxTokens(candidate) > TARGET_TOKENS) flush();
    buf.push(sentence);
    bufChars += sentence.length + 1;
  }
  flush();

  return pieces.length ? pieces : [turn];
}

export interface ChunkTranscriptOptions {
  targetTokens?: number;
  /** Turns of context repeated at the head of the next chunk. */
  overlapTurns?: number;
  maxTurnTokens?: number;
}

export function chunkTranscript(
  turns: SpeechTurn[],
  opts: ChunkTranscriptOptions = {},
): TranscriptChunk[] {
  const targetTokens = opts.targetTokens ?? TARGET_TOKENS;
  const overlapTurns = opts.overlapTurns ?? OVERLAP_TURNS;
  const maxTurnTokens = opts.maxTurnTokens ?? MAX_TURN_TOKENS;

  // Normalise first: drop empties, and break up only the turns that genuinely
  // cannot fit, so the packing loop below never has to split anything.
  const units: SpeechTurn[] = [];
  for (const turn of turns) {
    const text = turn.text.trim();
    if (!text) continue;
    const normalised: SpeechTurn = { ...turn, text };
    if (approxTokens(renderTurn(normalised)) > maxTurnTokens) {
      units.push(...splitLongTurn(normalised));
    } else {
      units.push(normalised);
    }
  }
  if (units.length === 0) return [];

  const chunks: TranscriptChunk[] = [];
  let buf: SpeechTurn[] = [];
  let bufTokens = 0;

  const flush = () => {
    if (!buf.length) return;
    const speakers: string[] = [];
    for (const t of buf) if (!speakers.includes(t.speaker)) speakers.push(t.speaker);
    const first = buf[0] as SpeechTurn;
    const last = buf[buf.length - 1] as SpeechTurn;

    chunks.push({
      content: buf.map(renderTurn).join('\n'),
      chunkIndex: chunks.length,
      tokens: bufTokens,
      metadata: {
        speaker: first.speaker,
        speakers,
        startMs: first.startMs,
        endMs: Math.max(last.endMs, first.startMs),
      },
    });

    const carried = overlapTurns > 0 ? buf.slice(-overlapTurns) : [];
    buf = [...carried];
    bufTokens = carried.reduce((sum, t) => sum + approxTokens(renderTurn(t)), 0);
  };

  for (const unit of units) {
    const t = approxTokens(renderTurn(unit));
    if (buf.length && bufTokens + t > targetTokens) flush();
    buf.push(unit);
    bufTokens += t;
  }
  // The tail may be nothing but carried-over overlap, which would duplicate the
  // previous chunk verbatim and give search two copies of the same exchange.
  const tailIsOnlyOverlap =
    chunks.length > 0 && buf.length > 0 && buf.length <= overlapTurns && bufTokens > 0
      ? buf.every((t) => (chunks[chunks.length - 1] as TranscriptChunk).content.includes(t.text))
      : false;
  if (!tailIsOnlyOverlap) flush();

  return chunks;
}

/**
 * Where in the recording a retrieved chunk came from, or null if it did not
 * come from one.
 *
 * Takes the raw `kb_chunks.metadata` jsonb because that is exactly what search
 * hands back, and it may be anything: `{pages: 3}` from a PDF, `{}` from a
 * plain text file, or nothing at all on a row written before 0058. Returning
 * null for all of those lets every caller render text and audio hits through
 * one code path, with no media_kind lookup per hit.
 *
 * Only the offset, never the speaker: a transcript chunk's content already
 * opens with "Speaker 2: …" — the chunker put it there so the embedding would
 * carry it — so `[12:34] ` + content reads `[12:34] Speaker 2: …` without
 * naming anyone twice.
 */
export function chunkOffsetMs(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const m = metadata as { startMs?: unknown };
  if (typeof m.startMs !== 'number' || !Number.isFinite(m.startMs) || m.startMs < 0) return null;
  return m.startMs;
}

/** `[mm:ss]` / `[h:mm:ss]` — how an offset is written in a citation. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${hours}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}
