import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { approxTokens } from '../chunker';
import {
  DEEPGRAM_LISTEN_URL,
  type DeepgramResponse,
  mapDeepgramResponse,
  transcribeAudio,
} from '../transcribe';
import { chunkOffsetMs, chunkTranscript, formatOffset } from '../transcript-chunker';

/**
 * The two things that have to hold for audio to be worth having in the KB:
 * a chunk never contains half of what someone said, and the offset that was
 * heard survives all the way into `kb_chunks.metadata`. Everything else here
 * is the degradation contract — a workspace with no Deepgram key must get a
 * sentence, not an exception.
 */

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const ORIGINAL_KEY = process.env['DEEPGRAM_API_KEY'];
beforeEach(() => {
  process.env['DEEPGRAM_API_KEY'] = 'test-key';
});
afterAll(() => {
  if (ORIGINAL_KEY === undefined) delete process.env['DEEPGRAM_API_KEY'];
  else process.env['DEEPGRAM_API_KEY'] = ORIGINAL_KEY;
});

/** A two-speaker call, the shape Deepgram returns with paragraphs + diarize. */
const DIARIZED_RESPONSE: DeepgramResponse = {
  metadata: { duration: 754.2 },
  results: {
    channels: [
      {
        detected_language: 'es',
        alternatives: [
          {
            transcript: 'full transcript',
            paragraphs: {
              paragraphs: [
                {
                  speaker: 0,
                  start: 12.4,
                  end: 19.1,
                  sentences: [
                    { text: 'Buenos días, gracias por el tiempo.', start: 12.4, end: 15.0 },
                    { text: '¿Empezamos con el alcance?', start: 15.1, end: 19.1 },
                  ],
                },
                {
                  speaker: 1,
                  start: 19.5,
                  end: 34.8,
                  sentences: [
                    {
                      text: 'Sí, y os confirmo el presupuesto el viernes.',
                      start: 19.5,
                      end: 34.8,
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  },
};

describe('mapDeepgramResponse', () => {
  it('turns diarized paragraphs into speech turns with millisecond offsets', () => {
    const t = mapDeepgramResponse(DIARIZED_RESPONSE);

    expect(t.turns).toHaveLength(2);
    expect(t.turns[0]).toEqual({
      speaker: 'Speaker 1',
      startMs: 12400,
      endMs: 19100,
      text: 'Buenos días, gracias por el tiempo. ¿Empezamos con el alcance?',
    });
    expect(t.turns[1]?.speaker).toBe('Speaker 2');
    expect(t.turns[1]?.startMs).toBe(19500);
  });

  it('reports the duration, the detected language and the speakers it heard', () => {
    const t = mapDeepgramResponse(DIARIZED_RESPONSE);
    expect(t.durationSeconds).toBe(754);
    expect(t.language).toBe('es');
    expect(t.speakers).toEqual(['Speaker 1', 'Speaker 2']);
  });

  it('falls back to grouping words when paragraphs are missing', () => {
    // Some detected languages come back without smart_format paragraphs; the
    // per-word speaker ids are still there and still worth a transcript.
    const t = mapDeepgramResponse({
      metadata: { duration: 4 },
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: 'Hola qué tal bien',
                words: [
                  { punctuated_word: 'Hola', start: 0.0, end: 0.5, speaker: 0 },
                  { punctuated_word: 'qué', start: 0.6, end: 0.9, speaker: 0 },
                  { punctuated_word: 'tal?', start: 1.0, end: 1.4, speaker: 0 },
                  { punctuated_word: 'Bien.', start: 1.6, end: 2.2, speaker: 1 },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(t.turns.map((x) => x.speaker)).toEqual(['Speaker 1', 'Speaker 2']);
    expect(t.turns[0]?.text).toBe('Hola qué tal?');
    expect(t.turns[0]?.endMs).toBe(1400);
    expect(t.turns[1]?.startMs).toBe(1600);
  });

  it('keeps a transcript that was not diarized at all as one turn', () => {
    const t = mapDeepgramResponse({
      metadata: { duration: 30 },
      results: { channels: [{ alternatives: [{ transcript: 'A dictated memo.' }] }] },
    });
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0]?.endMs).toBe(30000);
  });
});

describe('transcribeAudio', () => {
  it('degrades with a readable reason when no key is configured', async () => {
    delete process.env['DEEPGRAM_API_KEY'];

    const res = await transcribeAudio({ url: 'https://storage.example/call.mp3' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.configured).toBe(false);
    // Not worth retrying: the key will not appear between attempts.
    expect(res.retryable).toBe(false);
    expect(res.reason).toMatch(/DEEPGRAM_API_KEY/);
  });

  it('sends the signed URL as a JSON body with the diarizing parameters', async () => {
    let seenUrl = '';
    let seenAuth = '';
    let seenBody: unknown;
    server.use(
      http.post(DEEPGRAM_LISTEN_URL, async ({ request }) => {
        seenUrl = request.url;
        seenAuth = request.headers.get('authorization') ?? '';
        seenBody = await request.json();
        return HttpResponse.json(DIARIZED_RESPONSE);
      }),
    );

    const res = await transcribeAudio({ url: 'https://storage.example/call.mp3?token=abc' });

    expect(res.ok).toBe(true);
    expect(seenAuth).toBe('Token test-key');
    expect(seenBody).toEqual({ url: 'https://storage.example/call.mp3?token=abc' });
    const params = new URL(seenUrl).searchParams;
    expect(params.get('model')).toBe('nova-3');
    expect(params.get('diarize')).toBe('true');
    expect(params.get('detect_language')).toBe('true');
    // Spanish is the common case but never the forced one.
    expect(params.get('language')).toBeNull();
  });

  it('treats a rejected key as terminal and a rate limit as retryable', async () => {
    server.use(http.post(DEEPGRAM_LISTEN_URL, () => new HttpResponse(null, { status: 401 })));
    const rejected = await transcribeAudio({ url: 'https://storage.example/a.mp3' });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.configured).toBe(true);
      expect(rejected.retryable).toBe(false);
    }

    server.resetHandlers();
    server.use(http.post(DEEPGRAM_LISTEN_URL, () => new HttpResponse(null, { status: 429 })));
    const limited = await transcribeAudio({ url: 'https://storage.example/a.mp3' });
    expect(limited.ok).toBe(false);
    if (!limited.ok) expect(limited.retryable).toBe(true);
  });

  it('says so plainly when the recording turned out to be silent', async () => {
    server.use(
      http.post(DEEPGRAM_LISTEN_URL, () =>
        HttpResponse.json({
          metadata: { duration: 12 },
          results: { channels: [{ alternatives: [{ transcript: '' }] }] },
        }),
      ),
    );

    const res = await transcribeAudio({ url: 'https://storage.example/silence.mp3' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.retryable).toBe(false);
      expect(res.reason).toMatch(/no speech/i);
    }
  });
});

describe('chunkTranscript', () => {
  /** n turns of roughly `wordsPerTurn` words each, alternating between two people. */
  const conversation = (turnCount: number, wordsPerTurn: number) =>
    Array.from({ length: turnCount }, (_, i) => ({
      speaker: `Speaker ${(i % 2) + 1}`,
      startMs: i * 10_000,
      endMs: i * 10_000 + 9_000,
      text: `${`palabra${i} `.repeat(wordsPerTurn).trim()}.`,
    }));

  it('never splits one person mid-turn', () => {
    const turns = conversation(30, 40);
    const chunks = chunkTranscript(turns, { targetTokens: 120 });

    expect(chunks.length).toBeGreaterThan(1);
    // Every turn's full text appears intact inside at least one chunk. If the
    // chunker had cut on a token budget, the turns straddling a boundary would
    // exist only as two halves and this would fail.
    for (const turn of turns) {
      expect(chunks.some((c) => c.content.includes(turn.text))).toBe(true);
    }
  });

  it('names the speaker inline so the embedding carries who said it', () => {
    const chunks = chunkTranscript([
      { speaker: 'Speaker 1', startMs: 0, endMs: 3000, text: 'Lo tenemos para el viernes.' },
    ]);
    expect(chunks[0]?.content).toBe('Speaker 1: Lo tenemos para el viernes.');
  });

  it('carries speaker and offsets into the metadata of every chunk', () => {
    const chunks = chunkTranscript(conversation(20, 40), { targetTokens: 120 });

    for (const c of chunks) {
      expect(typeof c.metadata.speaker).toBe('string');
      expect(c.metadata.startMs).toBeGreaterThanOrEqual(0);
      expect(c.metadata.endMs).toBeGreaterThanOrEqual(c.metadata.startMs);
      expect(c.metadata.speakers.length).toBeGreaterThan(0);
      expect(c.metadata.speakers).toContain(c.metadata.speaker);
    }
    // The first chunk starts where the conversation starts, and offsets only
    // move forward.
    expect(chunks[0]?.metadata.startMs).toBe(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.metadata.startMs).toBeGreaterThanOrEqual(chunks[i - 1]!.metadata.startMs);
    }
  });

  it('overlaps by a whole turn so a question keeps its answer', () => {
    const chunks = chunkTranscript(
      [
        { speaker: 'Speaker 1', startMs: 0, endMs: 1000, text: `${'uno '.repeat(60).trim()}.` },
        { speaker: 'Speaker 2', startMs: 1000, endMs: 2000, text: '¿Y eso cuándo sería?' },
        { speaker: 'Speaker 1', startMs: 2000, endMs: 3000, text: `${'dos '.repeat(60).trim()}.` },
      ],
      { targetTokens: 90 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[1]?.content).toContain('¿Y eso cuándo sería?');
  });

  it('splits only a monologue that cannot fit, and keeps the speaker on both halves', () => {
    const monologue = Array.from({ length: 12 }, (_, i) => `Frase número ${i} con algo de texto.`)
      .join(' ')
      .repeat(6);
    const chunks = chunkTranscript(
      [{ speaker: 'Speaker 1', startMs: 60_000, endMs: 600_000, text: monologue }],
      { targetTokens: 100, maxTurnTokens: 150 },
    );

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.startsWith('Speaker 1: ')).toBe(true);
      expect(c.metadata.speaker).toBe('Speaker 1');
      // Interpolated, so it must stay inside the turn it was cut from.
      expect(c.metadata.startMs).toBeGreaterThanOrEqual(60_000);
      expect(c.metadata.endMs).toBeLessThanOrEqual(600_000);
    }
  });

  it('measures itself with the same ruler as the text chunker', () => {
    const chunks = chunkTranscript(conversation(12, 40), { targetTokens: 150 });
    for (const c of chunks) expect(c.tokens).toBe(approxTokens(c.content));
  });

  it('produces nothing from an empty transcript rather than an empty chunk', () => {
    expect(chunkTranscript([])).toEqual([]);
    expect(chunkTranscript([{ speaker: 'Speaker 1', startMs: 0, endMs: 0, text: '   ' }])).toEqual(
      [],
    );
  });
});

describe('the offset survives from Deepgram to a citation', () => {
  it('maps, chunks and renders back the minute it was said', () => {
    const transcript = mapDeepgramResponse(DIARIZED_RESPONSE);
    const chunks = chunkTranscript(transcript.turns);

    // One short exchange fits in a single chunk, anchored at the first turn.
    const [chunk] = chunks;
    expect(chunk?.metadata.startMs).toBe(12400);

    // …and that is exactly what search would hand back as `metadata`.
    const asStoredJsonb = JSON.parse(JSON.stringify(chunk?.metadata)) as unknown;
    const offsetMs = chunkOffsetMs(asStoredJsonb);
    expect(offsetMs).toBe(12400);
    expect(formatOffset(offsetMs as number)).toBe('0:12');
    expect(`[${formatOffset(offsetMs as number)}] ${chunk?.content}`).toMatch(
      /^\[0:12\] Speaker 1: Buenos días/,
    );
  });

  it('reads nothing from the metadata of a chunk that is not audio', () => {
    expect(chunkOffsetMs({ pages: 12 })).toBeNull();
    expect(chunkOffsetMs({})).toBeNull();
    expect(chunkOffsetMs(null)).toBeNull();
    expect(chunkOffsetMs(undefined)).toBeNull();
  });

  it('writes offsets past an hour with the hour in them', () => {
    expect(formatOffset(0)).toBe('0:00');
    expect(formatOffset(65_000)).toBe('1:05');
    expect(formatOffset(3_725_000)).toBe('1:02:05');
  });
});
