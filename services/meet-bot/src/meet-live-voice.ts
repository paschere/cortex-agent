import type { Config } from './config';
import type { Transcript } from './deepgram';
import { LiveAudioResampler, isCortexDismissal, liveEngagementExpired } from './live-activation';
import { LiveCaptions } from './live-captions';
import { type MeetingVoiceSnapshot, wantsCurrentMeetingView } from './live-visual-request';
import { type OpenAILiveOptions, OpenAILiveTransport } from './openai-live';
import { readVoiceAnswerStream } from './voice-stream';

type LiveConnection = Pick<
  OpenAILiveTransport,
  'start' | 'sendAudio' | 'appendCommentary' | 'close'
>;

export interface MeetLiveVoiceOptions {
  captureView?: () => Promise<MeetingVoiceSnapshot | null>;
  createTransport?: (options: OpenAILiveOptions) => LiveConnection;
  config: Config;
  owner: string;
  sessionId: string;
  audio: (pcm: Buffer) => Promise<void>;
  clear: () => Promise<void>;
  transcript: (line: Transcript) => void;
  meetingStartedAt?: number;
  status: (state: string) => void;
}

/** One short billed conversation per wake. No room audio is retained in standby. */
export class MeetLiveVoice {
  private live: LiveConnection | null = null;
  private connecting = false;
  private generation = 0;
  private muted = false;
  private startedAt = 0;
  private activityAt = 0;
  private cooldownUntil = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private resampler = new LiveAudioResampler();
  private heard = '';
  private abort: AbortController | null = null;
  private playback: Promise<void> = Promise.resolve();
  private playbackGeneration = 0;
  private pendingAudioBytes = 0;

  constructor(private readonly options: MeetLiveVoiceOptions) {}

  async wake(): Promise<void> {
    if (this.live || this.connecting || this.muted || Date.now() < this.cooldownUntil) return;
    const key = this.options.config.openaiKey;
    if (!key) {
      this.options.status('error: falta OPENAI_API_KEY');
      return;
    }
    this.connecting = true;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.heard = '';
    this.resampler = new LiveAudioResampler();
    let instructions: string;
    this.options.status('preparando Cortex');
    try {
      const response = await fetch(
        `${this.options.config.cortexBaseUrl.replace(/\/+$/, '')}/api/meetings/live/voice-answer`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.config.serviceToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            owner: this.options.owner,
            sessionId: this.options.sessionId,
            bootstrap: true,
          }),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]),
        },
      );
      if (!response.ok) throw new Error('Context unavailable');
      const context = (await response.json()) as { instructions?: unknown };
      if (typeof context.instructions !== 'string' || !context.instructions.trim())
        throw new Error('Empty context');
      instructions = context.instructions;
    } catch {
      if (generation === this.generation)
        await this.sleep('no se pudo cargar el contexto de Cortex');
      return;
    }
    if (generation !== this.generation || this.muted) return;
    const createTransport =
      this.options.createTransport ??
      ((options: OpenAILiveOptions) => new OpenAILiveTransport(options));
    let delegatedInputLength = 0;
    const captionStartedAt = Date.now();
    const captions = new LiveCaptions(
      `${this.options.sessionId}:${generation}`,
      (captionStartedAt - (this.options.meetingStartedAt ?? captionStartedAt)) / 1000,
    );
    const live = createTransport({
      apiKey: key,
      voice: 'bossa',
      instructions: `${instructions}\nHabla en español de Colombia, tuteando, con frases cortas y entonación conversacional. Evita el tono de locutor, el entusiasmo exagerado y repetir muletillas. Mantén un ritmo fluido con pausas naturales. Cuando te llamen, di «Te escucho» y escucha.`,
      onAudio: (pcm) => {
        if (generation !== this.generation || this.muted) return;
        const pg = this.playbackGeneration;
        // Bounded producer queue: never accumulate seconds of stale speech in Node.
        if (this.pendingAudioBytes + pcm.length > 240_000) {
          void this.sleep('audio saturado');
          return;
        }
        this.pendingAudioBytes += pcm.length;
        this.playback = this.playback
          .then(async () => {
            if (generation === this.generation && pg === this.playbackGeneration && !this.muted)
              await this.options.audio(pcm);
          })
          .catch(() => {
            void this.sleep('falló reproducción');
          })
          .finally(() => {
            this.pendingAudioBytes -= pcm.length;
          });
      },
      onClearPlayback: () => {
        this.playbackGeneration++;
        void this.options.clear();
      },
      onUsage: (seconds, final) => {
        console.log(
          `[cortex-meet] ${this.options.sessionId} GPT-Live usage seconds=${seconds} final=${final}`,
        );
      },
      onOutputActivity: () => {
        this.activityAt = Date.now();
      },
      onTranscript: (fragment) => {
        const { role, text } = fragment;
        if (generation !== this.generation) return;
        this.activityAt = Date.now();
        this.options.transcript(captions.append(fragment, Date.now() - captionStartedAt));
        if (role === 'user') {
          this.heard = (this.heard + text).slice(-12_000);
          if (isCortexDismissal(this.heard.slice(-200))) void this.sleep('despedido');
        }
      },
      onDelegation: async ({ transcript }) => {
        if (generation !== this.generation) return '';
        const newRequest = transcript.input.slice(delegatedInputLength);
        delegatedInputLength = transcript.input.length;
        const visualRequested = wantsCurrentMeetingView(newRequest);
        const visual = visualRequested
          ? await this.options.captureView?.().catch(() => null)
          : null;
        if (generation !== this.generation || abort.signal.aborted) return '';
        const response = await fetch(
          `${this.options.config.cortexBaseUrl.replace(/\/+$/, '')}/api/meetings/live/voice-answer`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${this.options.config.serviceToken}`,
              'content-type': 'application/json',
              accept: 'text/event-stream',
            },
            body: JSON.stringify({
              owner: this.options.owner,
              sessionId: this.options.sessionId,
              question:
                transcript.input.slice(-500) ||
                'Responde a la última petición de esta conversación.',
              transcript: `Participante: ${transcript.input}\nCortex: ${transcript.output}`.slice(
                -20_000,
              ),
              conversational: true,
              visualRequested,
              ...(visual ? { visual } : {}),
            }),
            signal: AbortSignal.any([abort.signal, AbortSignal.timeout(55_000)]),
          },
        );
        if (!response.ok)
          return 'No pude consultar el cerebro de Cortex. No se confirmó ninguna acción.';
        let result = '';
        for await (const part of readVoiceAnswerStream(response))
          result += `${result ? ' ' : ''}${part}`;
        if (generation !== this.generation) return '';
        // Stay below Live's 500-token append cap; the backend retains detailed results.
        return (
          result.slice(0, 1200) ||
          'No obtuve un resultado confirmado. Revisa la petición en Cortex.'
        );
      },
      onError: () => {
        if (generation === this.generation) void this.sleep('error de GPT-Live');
      },
    });
    this.live = live;
    this.connecting = false;
    this.startedAt = this.activityAt = Date.now();
    this.options.status('conectando');
    try {
      await live.start();
      if (generation !== this.generation) {
        await live.close();
        return;
      }
      this.options.status('conversando');
      live.appendCommentary('Te acaban de llamar. Di brevemente: «Te escucho».');
      this.timer = setInterval(() => {
        if (liveEngagementExpired(Date.now(), this.startedAt, this.activityAt))
          void this.sleep('reposo');
      }, 1000);
    } catch {
      await this.sleep('no se pudo conectar');
    }
  }

  push(pcm16k: Buffer): void {
    if (!this.live || this.muted) return;
    this.live.sendAudio(this.resampler.push(pcm16k));
  }

  async say(text: string): Promise<boolean> {
    await this.wake();
    return this.live?.appendCommentary(text.slice(0, 1200)) ?? false;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) void this.sleep('silenciado');
  }

  async sleep(reason = 'reposo'): Promise<void> {
    ++this.generation;
    ++this.playbackGeneration;
    this.abort?.abort();
    this.abort = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const live = this.live;
    this.live = null;
    this.connecting = false;
    this.heard = '';
    this.cooldownUntil = Date.now() + 2500;
    await this.options.clear().catch(() => undefined);
    await live?.close();
    this.options.status(reason);
  }
}
