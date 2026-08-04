/**
 * Deepgram transcription — the step that turns a recording into something the
 * Brain Knowledge can answer from.
 *
 * Like the Apollo client and unlike everything else in this package, this
 * module NEVER THROWS. A missing key, an exhausted balance and a file Deepgram
 * refuses to decode are ordinary operating conditions for a third party we do
 * not run. A thrown error here would surface to the person as "your recording
 * couldn't be read", which is both wrong and unactionable; a returned
 * `{ ok: false, configured, reason }` lets the ingestion worker write a
 * sentence a human can act on into `transcript_error`.
 *
 * The failure also says whether it is worth trying again. That distinction is
 * the difference between an Inngest run that retries three times and gives up
 * on a file that will never decode, and one that gives up on a network blip.
 */

export interface SpeechTurn {
  /** Diarization gives numbers, not names — "Speaker 1", "Speaker 2", … */
  speaker: string;
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcript {
  turns: SpeechTurn[];
  /** Total length of the audio, from Deepgram's own metadata. */
  durationSeconds: number;
  /** BCP-47 tag Deepgram detected, or null when detection was inconclusive. */
  language: string | null;
  /** Speaker labels in first-heard order. */
  speakers: string[];
}

export interface TranscribeFailure {
  ok: false;
  configured: boolean;
  reason: string;
  /**
   * Whether the same request could succeed later. False for "there is no key"
   * and "this file cannot be decoded"; true for rate limits and outages.
   */
  retryable: boolean;
}

export type TranscribeResult = { ok: true; data: Transcript } | TranscribeFailure;

export const DEEPGRAM_LISTEN_URL = 'https://api.deepgram.com/v1/listen';

export const NOT_CONFIGURED_REASON =
  'Transcription is not switched on for this workspace — there is no Deepgram key, so I cannot turn a recording into something searchable. Someone on the ops team needs to add DEEPGRAM_API_KEY first.';

/**
 * `detect_language` rather than a pinned `language`. Almost everything said
 * here is Spanish, but "almost" is the problem: pinning es-419 mistranscribes
 * an English client call into confident nonsense, which is worse than a slower
 * detection pass, because nonsense still indexes and still gets cited.
 *
 * `diarize` is what makes the whole feature work — without speaker labels a
 * transcript cannot answer "what did the CLIENT promise", only "what was said".
 * `paragraphs` gives us turn boundaries that were decided from prosody and
 * speaker changes rather than from character counts.
 */
const LISTEN_PARAMS: Record<string, string> = {
  model: 'nova-3',
  diarize: 'true',
  punctuate: 'true',
  smart_format: 'true',
  paragraphs: 'true',
  detect_language: 'true',
};

/** An hour of audio is a few minutes of work on Deepgram's side. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
  speaker?: number;
}

interface DeepgramSentence {
  text?: string;
  start?: number;
  end?: number;
}

interface DeepgramParagraph {
  sentences?: DeepgramSentence[];
  speaker?: number;
  start?: number;
  end?: number;
}

interface DeepgramAlternative {
  transcript?: string;
  words?: DeepgramWord[];
  paragraphs?: { transcript?: string; paragraphs?: DeepgramParagraph[] };
}

interface DeepgramChannel {
  alternatives?: DeepgramAlternative[];
  detected_language?: string;
}

export interface DeepgramResponse {
  metadata?: { duration?: number; detected_language?: string };
  results?: { channels?: DeepgramChannel[]; utterances?: unknown };
}

function speakerLabel(index: number | undefined): string {
  // Deepgram numbers speakers from 0; people count from 1, and these labels go
  // straight into the chunk text and into citations.
  return `Speaker ${(index ?? 0) + 1}`;
}

function toMs(seconds: number | undefined): number {
  return Math.max(0, Math.round((seconds ?? 0) * 1000));
}

/**
 * Deepgram's response into our turns.
 *
 * Two shapes are accepted on purpose. `paragraphs` is what we ask for and what
 * we want: Deepgram has already grouped words into a speaker's contiguous
 * stretch of speech. But `smart_format`/`paragraphs` is silently unavailable
 * for some detected languages, and in that case the response still carries
 * per-word speaker ids — so we group the words ourselves rather than throwing
 * away a transcript we already paid for.
 *
 * Exported because this mapping, not the HTTP call, is where the timestamps
 * that end up in a citation are decided.
 */
export function mapDeepgramResponse(body: DeepgramResponse): Transcript {
  const channel = body.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  const paragraphs = alt?.paragraphs?.paragraphs ?? [];

  let turns: SpeechTurn[] = [];

  if (paragraphs.length > 0) {
    turns = paragraphs
      .map((p) => {
        const text = (p.sentences ?? [])
          .map((s) => (s.text ?? '').trim())
          .filter(Boolean)
          .join(' ')
          .trim();
        const first = p.sentences?.[0];
        const last = p.sentences?.[p.sentences.length - 1];
        return {
          speaker: speakerLabel(p.speaker),
          startMs: toMs(p.start ?? first?.start),
          endMs: toMs(p.end ?? last?.end),
          text,
        };
      })
      .filter((t) => t.text.length > 0);
  } else if (alt?.words?.length) {
    // Fallback: a new turn every time the speaker id changes.
    let current: SpeechTurn | null = null;
    for (const w of alt.words) {
      const label = speakerLabel(w.speaker);
      const token = (w.punctuated_word ?? w.word ?? '').trim();
      if (!token) continue;
      if (!current || current.speaker !== label) {
        if (current) turns.push(current);
        current = { speaker: label, startMs: toMs(w.start), endMs: toMs(w.end), text: token };
      } else {
        current.text = `${current.text} ${token}`;
        current.endMs = toMs(w.end);
      }
    }
    if (current) turns.push(current);
  } else if (alt?.transcript?.trim()) {
    // No diarization at all (single-channel music-free monologue, or a model
    // that declined to diarize). One turn is still better than no transcript.
    turns = [
      {
        speaker: speakerLabel(0),
        startMs: 0,
        endMs: toMs(body.metadata?.duration),
        text: alt.transcript.trim(),
      },
    ];
  }

  const speakers: string[] = [];
  for (const t of turns) if (!speakers.includes(t.speaker)) speakers.push(t.speaker);

  return {
    turns,
    durationSeconds: Math.round(body.metadata?.duration ?? 0),
    language: channel?.detected_language ?? body.metadata?.detected_language ?? null,
    speakers,
  };
}

function describeHttpFailure(status: number, body: string): { reason: string; retryable: boolean } {
  if (status === 401 || status === 403) {
    return {
      reason:
        'Deepgram rejected our key. It has most likely been rotated or lost access — ops needs to refresh it before recordings can be transcribed again.',
      retryable: false,
    };
  }
  if (status === 402) {
    return {
      reason:
        "Deepgram's balance for this account is used up, so it will not transcribe anything until someone tops it up.",
      retryable: false,
    };
  }
  if (status === 400 || status === 415) {
    // Deepgram returns 400 for a corrupt container as well as for a bad
    // parameter, and neither improves by being retried.
    return {
      reason: `Deepgram could not decode that audio — the file may be corrupt or in a format it does not support. (It answered ${status}.)`,
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      reason:
        'Deepgram is rate-limiting us right now — too many recordings at once. This clears on its own shortly.',
      retryable: true,
    };
  }
  if (status >= 500) {
    return {
      reason:
        'Deepgram is having trouble on their side and did not answer. That usually clears within a few minutes.',
      retryable: true,
    };
  }
  return {
    reason: `Deepgram could not transcribe that recording (it answered ${status}${body ? `: ${body.slice(0, 200)}` : ''}).`,
    retryable: false,
  };
}

/**
 * Either a signed URL Deepgram can fetch itself, or the bytes.
 *
 * The URL form is strongly preferred and is what ingestion uses: an hour-long
 * recording is tens of megabytes, and pulling it out of Storage into the
 * worker's memory only to push the same bytes straight back out doubles the
 * transfer and holds the whole file in a serverless function's heap for the
 * duration. Handing Deepgram a short-lived signed URL costs one round trip.
 */
export type AudioInput = { url: string } | { bytes: Uint8Array; mime: string };

export interface TranscribeOptions {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  logger?: { warn: (obj: unknown, msg: string) => void } | undefined;
}

export async function transcribeAudio(
  input: AudioInput,
  opts: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const key = process.env['DEEPGRAM_API_KEY'];
  if (!key) {
    return { ok: false, configured: false, reason: NOT_CONFIGURED_REASON, retryable: false };
  }

  const url = `${DEEPGRAM_LISTEN_URL}?${new URLSearchParams(LISTEN_PARAMS).toString()}`;
  const byUrl = 'url' in input;

  // A caller-supplied signal still wins; the timeout is a floor so a stalled
  // upload cannot pin an Inngest step open indefinitely.
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': byUrl ? 'application/json' : input.mime,
        accept: 'application/json',
      },
      body: byUrl ? JSON.stringify({ url: input.url }) : input.bytes,
      signal,
    });
  } catch (err) {
    opts.logger?.warn({ err }, 'deepgram request failed');
    return {
      ok: false,
      configured: true,
      reason:
        'I could not reach Deepgram at all just now, so the recording is still waiting to be transcribed. Worth another try in a moment.',
      retryable: true,
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // The body can contain transcribed speech, so only the status is logged.
    opts.logger?.warn({ status: res.status }, 'deepgram returned an error');
    const { reason, retryable } = describeHttpFailure(res.status, body);
    return { ok: false, configured: true, reason, retryable };
  }

  let body: DeepgramResponse;
  try {
    body = (await res.json()) as DeepgramResponse;
  } catch {
    return {
      ok: false,
      configured: true,
      reason: 'Deepgram answered with something I could not read. Worth trying again in a moment.',
      retryable: true,
    };
  }

  const transcript = mapDeepgramResponse(body);
  if (transcript.turns.length === 0) {
    return {
      ok: false,
      configured: true,
      reason:
        'Deepgram transcribed that recording and found no speech in it — it may be silent, or the wrong track may have been captured.',
      retryable: false,
    };
  }

  return { ok: true, data: transcript };
}
