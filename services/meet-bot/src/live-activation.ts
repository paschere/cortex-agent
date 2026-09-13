/** Billing boundary: no provider session or audio outside an explicit engagement. */
export function isCortexWake(text: string): boolean {
  return /\b(c[oó]rtex|coartex|kortex|korteks)\b/i.test(text);
}

export function isCortexDismissal(text: string): boolean {
  const folded = text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  return (
    /\b(cortex|kortex)\b/.test(folded) &&
    /\b(gracias|eso es todo|puedes descansar|puedes apagar|ya no|silencio|callate|hasta luego|dejamos aqui)\b/.test(
      folded,
    )
  );
}

/** Stateful 16k -> 24k linear interpolation; preserves phase across input frames. */
export class LiveAudioResampler {
  private samples: number[] = [];
  private position = 0;
  push(pcm: Buffer): Buffer {
    for (let i = 0; i + 1 < pcm.length; i += 2) this.samples.push(pcm.readInt16LE(i));
    const values: number[] = [];
    while (this.position + 1 < this.samples.length) {
      const i = Math.floor(this.position);
      const f = this.position - i;
      values.push(Math.round(this.samples[i] * (1 - f) + this.samples[i + 1] * f));
      this.position += 2 / 3;
    }
    const consumed = Math.floor(this.position);
    this.samples = this.samples.slice(consumed);
    this.position -= consumed;
    const out = Buffer.alloc(values.length * 2);
    values.forEach((value, i) => out.writeInt16LE(value, i * 2));
    return out;
  }
}

export const LIVE_IDLE_MS = 30_000;
export const LIVE_MAX_ENGAGEMENT_MS = 180_000;

export function liveEngagementExpired(
  now: number,
  startedAt: number,
  lastActivityAt: number,
): boolean {
  return now - lastActivityAt >= LIVE_IDLE_MS || now - startedAt >= LIVE_MAX_ENGAGEMENT_MS;
}
