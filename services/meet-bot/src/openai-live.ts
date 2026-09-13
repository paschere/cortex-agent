import WebSocket from 'ws';

const LIVE_URL = 'wss://api.openai.com/v1/live/sessions';

type LiveSocket = Pick<WebSocket, 'on' | 'send' | 'close' | 'terminate' | 'readyState'>;

export interface LiveDelegation {
  id: string;
  offsetMs: number | null;
  transcript: { input: string; output: string };
}

export interface OpenAILiveOptions {
  apiKey: string;
  instructions: string;
  voice?: string;
  startTimeoutMs?: number;
  closeTimeoutMs?: number;
  onAudio: (pcm24k: Buffer) => void;
  onClearPlayback: () => void;
  onTranscript?: (fragment: { role: 'user' | 'assistant'; text: string }) => void;
  onOutputActivity?: () => void;
  onUsage?: (seconds: number, final: boolean) => void;
  onDelegation: (delegation: LiveDelegation) => Promise<string>;
  onError: (error: Error) => void;
  /** Test seam; production uses ws with the required bearer header. */
  webSocketFactory?: (url: string, options: WebSocket.ClientOptions) => LiveSocket;
}

/** Primary GPT-Live WebSocket transport for mono PCM16LE at 24 kHz. */
export class OpenAILiveTransport {
  private socket: LiveSocket | null = null;
  private started = false;
  private closing = false;
  private finalized = false;
  private pendingByte: Buffer = Buffer.alloc(0);
  private heardOutputSinceClear = false;
  private inputTranscript = '';
  private outputTranscript = '';
  private eventSequence = 0;
  private readonly delegations = new Set<string>();

  constructor(private readonly options: OpenAILiveOptions) {}

  start(): Promise<void> {
    if (this.socket) return Promise.reject(new Error('GPT-Live transport already started'));
    this.closing = false;
    this.finalized = false;

    const factory =
      this.options.webSocketFactory ?? ((url, options) => new WebSocket(url, options));
    const socket = factory(LIVE_URL, {
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
    });
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = new Error('GPT-Live session.start timed out');
        this.report(error);
        socket.terminate();
        reject(error);
      }, this.options.startTimeoutMs ?? 10_000);

      const failStart = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };

      socket.on('open', () => {
        this.sendEvent({
          type: 'session.start',
          event_id: this.nextEventId('start'),
          session: {
            model: 'gpt-live-1',
            store: false,
            instructions: this.options.instructions,
            audio: {
              format: { type: 'audio/pcm', rate: 24_000 },
              output: { voice: this.options.voice ?? 'marin' },
            },
            delegation: { type: 'client' },
          },
        });
      });
      socket.on('message', (raw) => {
        const event = this.parseEvent(raw);
        if (!event) return;
        if (event.type === 'session.started' && !settled) {
          this.started = true;
          settled = true;
          clearTimeout(timeout);
          resolve();
        }
        this.handleEvent(event);
        if (event.type === 'error' && !this.started) {
          const detail = event.error as Record<string, unknown> | undefined;
          failStart(
            new Error(
              typeof detail?.message === 'string'
                ? detail.message
                : 'GPT-Live rejected session.start',
            ),
          );
        }
      });
      socket.on('error', (value) => {
        const error = value instanceof Error ? value : new Error(String(value));
        this.report(error);
        failStart(error);
      });
      socket.on('close', () => {
        this.started = false;
        this.socket = null;
        if (!this.finalized && !this.closing) {
          const error = new Error('GPT-Live connection closed before session.closed');
          this.report(error);
          failStart(error);
        }
      });
    });
  }

  sendAudio(chunk: Buffer): void {
    if (!this.started || this.closing || !this.isOpen()) return;
    const bytes = this.pendingByte.length ? Buffer.concat([this.pendingByte, chunk]) : chunk;
    const completeLength = bytes.length - (bytes.length % 2);
    this.pendingByte =
      completeLength === bytes.length
        ? Buffer.alloc(0)
        : Buffer.from(bytes.subarray(completeLength));
    if (!completeLength) return;
    this.sendEvent({
      type: 'session.input_audio.append',
      audio: bytes.subarray(0, completeLength).toString('base64'),
    });
  }

  /** Adds application-authorized speech context outside a delegation. */
  appendCommentary(content: string): boolean {
    if (!content.trim() || !this.started || this.closing || !this.isOpen()) return false;
    this.sendEvent({
      type: 'session.commentary.append',
      event_id: this.nextEventId('commentary'),
      delegation_id: null,
      content,
    });
    return true;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.pendingByte = Buffer.alloc(0);
    const socket = this.socket;
    if (!socket) return;
    if (!this.started || socket.readyState !== WebSocket.OPEN) {
      socket.terminate();
      this.socket = null;
      return;
    }

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        socket.close();
        resolve();
      };
      const timeout = setTimeout(() => {
        this.report(new Error('GPT-Live session.close timed out before session.closed'));
        socket.terminate();
        finish();
      }, this.options.closeTimeoutMs ?? 15_000);
      socket.on('message', (raw) => {
        const event = this.parseEvent(raw);
        if (event?.type === 'session.closed') {
          this.finalized = true;
          finish();
        }
      });
      socket.on('close', finish);
      this.sendEvent({ type: 'session.close', event_id: this.nextEventId('close') });
    });
    this.socket = null;
    this.started = false;
  }

  private handleEvent(event: Record<string, unknown>): void {
    if (event.type === 'session.usage.updated' || event.type === 'session.closed') {
      const usage = event.usage as { seconds?: unknown } | undefined;
      if (typeof usage?.seconds === 'number' && Number.isFinite(usage.seconds))
        this.options.onUsage?.(usage.seconds, event.type === 'session.closed');
    }
    if (this.closing) return;
    if (event.type === 'session.output_audio.delta' && typeof event.delta === 'string') {
      try {
        const audio = Buffer.from(event.delta, 'base64');
        if (audio.length) {
          this.heardOutputSinceClear = true;
          this.options.onOutputActivity?.();
          this.options.onAudio(audio);
        }
      } catch (error) {
        this.report(error instanceof Error ? error : new Error(String(error)));
      }
      return;
    }

    if (event.type === 'session.input_transcript.delta' && typeof event.delta === 'string') {
      this.inputTranscript = (this.inputTranscript + event.delta).slice(-20_000);
      this.options.onTranscript?.({ role: 'user', text: event.delta });
      // Live has no output-audio-done marker. New caller speech after output audio
      // is the reliable local barge-in boundary for discarding queued playback.
      this.clearPlaybackIfNeeded();
      return;
    }
    if (event.type === 'session.output_transcript.delta' && typeof event.delta === 'string') {
      this.outputTranscript = (this.outputTranscript + event.delta).slice(-20_000);
      this.options.onTranscript?.({ role: 'assistant', text: event.delta });
      return;
    }
    if (
      event.type === 'session.output_audio.interrupted' ||
      event.type === 'session.output_audio.cleared'
    ) {
      this.clearPlaybackIfNeeded(true);
      return;
    }
    if (event.type === 'session.delegation.created') {
      const delegation = event.delegation as Record<string, unknown> | undefined;
      if (delegation?.target === 'client' && typeof delegation.id === 'string') {
        void this.resolveDelegation(
          delegation.id,
          typeof event.offset_ms === 'number' ? event.offset_ms : null,
        );
      }
      return;
    }
    if (event.type === 'session.closed') {
      this.finalized = true;
      return;
    }
    if (event.type === 'error') {
      const detail = event.error as Record<string, unknown> | undefined;
      this.report(
        new Error(typeof detail?.message === 'string' ? detail.message : 'GPT-Live session error'),
      );
    }
  }

  private async resolveDelegation(id: string, offsetMs: number | null): Promise<void> {
    if (this.delegations.has(id) || this.closing || !this.started) return;
    this.delegations.add(id);
    try {
      const content = await this.options.onDelegation({
        id,
        offsetMs,
        transcript: { input: this.inputTranscript, output: this.outputTranscript },
      });
      if (!content.trim() || !this.started || this.closing || !this.isOpen()) return;
      this.sendEvent({
        type: 'session.commentary.append',
        event_id: this.nextEventId('delegation'),
        delegation_id: id,
        content,
      });
    } catch (error) {
      this.report(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private clearPlaybackIfNeeded(force = false): void {
    if (!force && !this.heardOutputSinceClear) return;
    this.heardOutputSinceClear = false;
    this.options.onClearPlayback();
  }

  private parseEvent(raw: unknown): Record<string, unknown> | null {
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString() : String(raw);
      const value = JSON.parse(text) as unknown;
      return value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : null;
    } catch {
      this.report(new Error('GPT-Live sent an invalid JSON event'));
      return null;
    }
  }

  private sendEvent(event: Record<string, unknown>): void {
    if (!this.isOpen()) return;
    this.socket?.send(JSON.stringify(event));
  }

  private isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  private nextEventId(kind: string): string {
    this.eventSequence += 1;
    return `cortex_${kind}_${this.eventSequence}`;
  }

  private report(error: Error): void {
    this.options.onError(error);
  }
}
