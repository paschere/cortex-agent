import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import path from 'node:path';

export interface LocalWakeDetectorOptions {
  modelPath?: string;
  pythonPath?: string;
  scriptPath?: string;
  readyTimeoutMs?: number;
  maxQueuedBytes?: number;
  onWake: () => void;
  onError: (error: Error) => void;
}

/** Runs the local PCM16LE 16 kHz wake gate. It has no network fallback. */
export class LocalWakeDetector {
  private process: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private stopping = false;
  private writable = true;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private queue: Buffer[] = [];
  private queuedBytes = 0;

  constructor(private readonly options: LocalWakeDetectorOptions) {}

  start(): Promise<void> {
    if (this.process) return Promise.reject(new Error('local wake detector already started'));
    this.stopping = false;
    const child = spawn(
      this.options.pythonPath ?? 'python3',
      [
        this.options.scriptPath ?? path.join(__dirname, 'local-wake.py'),
        this.options.modelPath ?? '/opt/cortex-wake-model',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.process = child;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        const error = new Error('local wake detector ready handshake timed out');
        fail(error);
        child.kill('SIGKILL');
      }, this.options.readyTimeoutMs ?? 15_000);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.options.onError(error);
        reject(error);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        this.stdoutBuffer = (this.stdoutBuffer + chunk.toString()).slice(-8192);
        let newline = this.stdoutBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = this.stdoutBuffer.slice(0, newline);
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          this.handleProtocolLine(line, () => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              this.ready = true;
              resolve();
              this.flushQueue();
            }
          });
          newline = this.stdoutBuffer.indexOf('\n');
        }
      });
      child.stderr.on('data', (chunk: Buffer) => {
        this.stderrBuffer = (this.stderrBuffer + chunk.toString()).slice(-8_192);
      });
      child.stdin.on('drain', () => {
        this.writable = true;
        this.flushQueue();
      });
      child.stdin.on('error', (error) => {
        if (this.stopping) return;
        if (!settled) fail(error);
        else this.options.onError(error);
      });
      child.on('error', fail);
      child.on('exit', (code, signal) => {
        this.process = null;
        this.ready = false;
        if (this.stopping) return;
        const detail = this.stderrBuffer.trim();
        const error = new Error(
          detail || `local wake detector exited unexpectedly (${signal ?? code ?? 'unknown'})`,
        );
        if (!settled) fail(error);
        else this.options.onError(error);
      });
    });
  }

  push(chunk: Buffer): void {
    if (this.stopping || !chunk.length) return;
    if (this.ready && this.writable && this.process) {
      this.writable = this.process.stdin.write(chunk);
      return;
    }
    this.enqueue(chunk);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.queue = [];
    this.queuedBytes = 0;
    const child = this.process;
    this.process = null;
    if (!child) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        finish();
      }, 1_000);
      child.once('exit', finish);
      child.kill('SIGTERM');
    });
  }

  private handleProtocolLine(line: string, onReady: () => void): void {
    try {
      const event = JSON.parse(line) as { type?: string };
      if (event.type === 'ready') onReady();
      else if (event.type === 'wake' && this.ready && !this.stopping) this.options.onWake();
    } catch {
      // Stdout is protocol-only. Ignore malformed output without exposing it.
    }
  }

  private enqueue(chunk: Buffer): void {
    const limit = this.options.maxQueuedBytes ?? 160_000;
    const boundedChunk = chunk.length > limit ? chunk.subarray(chunk.length - limit) : chunk;
    while (this.queue.length && this.queuedBytes + boundedChunk.length > limit) {
      this.queuedBytes -= this.queue.shift()?.length ?? 0;
    }
    if (this.queuedBytes + boundedChunk.length <= limit) {
      const copy = Buffer.from(boundedChunk);
      this.queue.push(copy);
      this.queuedBytes += copy.length;
    }
  }

  private flushQueue(): void {
    while (this.ready && this.writable && this.process && this.queue.length) {
      const chunk = this.queue.shift();
      if (!chunk) return;
      this.queuedBytes -= chunk.length;
      this.writable = this.process.stdin.write(chunk);
    }
  }
}
