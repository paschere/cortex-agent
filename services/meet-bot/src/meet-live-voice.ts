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
  playbackRemainingMs?: () => Promise<number>;
  recentContext?: () => string;
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
  private inputClosed = false;
  private requestHeard = false;
  private responseAudioAt = 0;
  private lastAudioAt = 0;
  private pendingDelegations = 0;
  private checkingDrain = false;
  private visibleStatus = '';

  private emitStatus(state: string): void {
    if (this.visibleStatus === state) return;
    this.visibleStatus = state;
    this.options.status(state);
  }

  constructor(private readonly options: MeetLiveVoiceOptions) {}

  async wake(): Promise<void> {
    if (this.muted || this.connecting) return;
    if (this.live) {
      if (!this.inputClosed) return;
      await this.sleep('nueva mención');
      this.cooldownUntil = 0;
    }
    if (Date.now() < this.cooldownUntil) return;
    const key = this.options.config.openaiKey;
    if (!key) {
      this.emitStatus('error: falta OPENAI_API_KEY');
      return;
    }
    this.connecting = true;
    const generation = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    this.heard = '';
    this.inputClosed = false;
    this.requestHeard = false;
    this.responseAudioAt = 0;
    this.lastAudioAt = 0;
    this.pendingDelegations = 0;
    this.resampler = new LiveAudioResampler();
    let instructions: string;
    this.emitStatus('preparando Cortex');
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
    const earlierContext = this.options.recentContext?.().slice(-12000) ?? '';
    let delegatedInputLength = 0;
    const captionStartedAt = Date.now();
    const captions = new LiveCaptions(
      `${this.options.sessionId}:${generation}`,
      (captionStartedAt - (this.options.meetingStartedAt ?? captionStartedAt)) / 1000,
    );
    const live = createTransport({
      apiKey: key,
      voice: 'bossa',
      instructions: `${instructions}\nHabla en español de Colombia, tuteando, con frases cortas y entonación conversacional. Evita el tono de locutor, el entusiasmo exagerado y repetir muletillas. Mantén un ritmo fluido con pausas naturales. Usa ocasionalmente y con variedad muletillas como «hmm», «dale», «entiendo» o «espera…» cuando encajen con lo que escuchas. Si estás consultando de verdad el cerebro, puedes decir «dame un momento» o «dame un minuto»; no simules trabajo ni prometas un plazo exacto. No uses muletillas en cada frase ni repitas siempre la misma. Cuando te llamen, di «Te escucho» y escucha.`,
      onAudio: (pcm) => {
        if (generation !== this.generation || this.muted) return;
        this.lastAudioAt = Date.now();
        if (this.requestHeard) this.responseAudioAt = this.lastAudioAt;
        this.emitStatus('respondiendo');
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
        this.options.transcript(captions.append(fragment, Date.now() - captionStartedAt));
        if (role === 'user') {
          this.requestHeard = true;
          this.heard = (this.heard + text).slice(-12_000);
          if (isCortexDismissal(this.heard.slice(-200))) void this.sleep('despedido');
        }
      },
      onDelegation: async ({ transcript }) => {
        if (generation !== this.generation) return '';
        this.requestHeard = true;
        this.pendingDelegations++;
        this.emitStatus('consultando cerebro');
        try {
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
                transcript:
                  `CONTEXTO ANTERIOR TRANSCRITO (puede haber intervalos sin transcribir):\n${earlierContext}\nCONVERSACIÓN ACTIVA:\nParticipante: ${transcript.input}\nCortex: ${transcript.output}`.slice(
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
        } finally {
          if (generation === this.generation) this.pendingDelegations--;
        }
      },
      onError: () => {
        if (generation === this.generation) void this.sleep('error de GPT-Live');
      },
    });
    this.live = live;
    this.connecting = false;
    this.startedAt = this.activityAt = Date.now();
    this.emitStatus('conectando');
    try {
      await live.start();
      if (generation !== this.generation) {
        await live.close();
        return;
      }
      this.emitStatus('conversando');
      live.appendCommentary('Te acaban de llamar. Di brevemente: «Te escucho».');
      this.timer = setInterval(() => {
        void this.finishResponseIfDrained();
        if (liveEngagementExpired(Date.now(), this.startedAt, this.activityAt))
          void this.sleep('reposo');
      }, 1000);
    } catch {
      await this.sleep('no se pudo conectar');
    }
  }

  push(pcm16k: Buffer): void {
    if (!this.live || this.muted) return;
    this.live.sendAudio(
      this.resampler.push(this.inputClosed ? Buffer.alloc(pcm16k.length) : pcm16k),
    );
  }

  /** Quiet gap is a display/playback heuristic, never a provider completion claim. */
  async finishResponseIfDrained(now = Date.now()): Promise<void> {
    if (
      !this.live ||
      this.checkingDrain ||
      !this.lastAudioAt ||
      this.pendingDelegations ||
      this.pendingAudioBytes ||
      now - this.lastAudioAt < 2500
    )
      return;
    this.checkingDrain = true;
    const generation = this.generation;
    const lastAudio = this.lastAudioAt;
    try {
      const remaining = (await this.options.playbackRemainingMs?.()) ?? 0;
      if (
        generation !== this.generation ||
        this.pendingAudioBytes ||
        this.pendingDelegations ||
        this.lastAudioAt !== lastAudio ||
        remaining > 0
      )
        return;
      if (!this.responseAudioAt) {
        this.emitStatus('conversando');
        return;
      }
      this.inputClosed = true;
      await this.sleep('reposo');
    } finally {
      this.checkingDrain = false;
    }
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
    this.emitStatus(reason);
    await live?.close();
  }
}
