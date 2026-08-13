import type { CoreMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { ScreenGlanceSchema, attachScreenFrame, glanceTokens, screenBlock } from './screen-glance';

/**
 * Everything a screen question can get wrong before it reaches the model.
 *
 * No model, no browser, no database and no network: the four things under test
 * are pure, and the point of extracting them from the chat route was that they
 * could be checked without any of that. In particular NOTHING HERE CALLS
 * ANTHROPIC — the token figure is asserted against the published formula, which
 * is what the code claims to implement; whether the provider's own count agrees
 * is a separate question and is marked as unverified in screen-glance.ts.
 */

const FRAME = {
  base64: 'QUJD',
  mimeType: 'image/jpeg' as const,
  width: 1280,
  height: 720,
  takenAt: '2026-08-12T14:32:05.000Z',
};

describe('ScreenGlanceSchema', () => {
  it('accepts a frame the composer would really send', () => {
    expect(ScreenGlanceSchema.safeParse(FRAME).success).toBe(true);
  });

  it('refuses a payload too big to be one frame', () => {
    // The cap is what stops a tampered client posting a film one part at a
    // time; a frame at 1280px and quality 0.85 is nowhere near it.
    const huge = { ...FRAME, base64: 'A'.repeat(1_400_001) };
    expect(ScreenGlanceSchema.safeParse(huge).success).toBe(false);
  });

  it('refuses a media type that is not an image', () => {
    const video = { ...FRAME, mimeType: 'video/mp4' };
    expect(ScreenGlanceSchema.safeParse(video).success).toBe(false);
  });

  it('refuses a frame with no dimensions, because the cost is computed from them', () => {
    expect(ScreenGlanceSchema.safeParse({ ...FRAME, width: 0 }).success).toBe(false);
  });

  it('refuses a capture time that is not a timestamp', () => {
    // It is shown to the person under their own question, so a client that
    // sends prose here would put prose in the transcript.
    expect(ScreenGlanceSchema.safeParse({ ...FRAME, takenAt: 'ahora' }).success).toBe(false);
  });
});

describe('glanceTokens', () => {
  it('prices a laptop tab at the published rate', () => {
    // 1280 × 720 / 750. The figure quoted throughout this feature.
    expect(glanceTokens(1280, 720)).toBe(1229);
  });

  it('scales with area and not with anything else', () => {
    // Halving both edges quarters the bill: the argument for leaving MAX_EDGE
    // alone rests on this being the only knob that costs money.
    expect(glanceTokens(640, 360)).toBe(Math.round(glanceTokens(1280, 720) / 4));
  });

  it('never returns zero, so the row can never claim a free glance', () => {
    // The check constraint in migration 0092 requires > 0 whenever a glance
    // happened; a 1×1 frame must not violate it.
    expect(glanceTokens(1, 1)).toBeGreaterThan(0);
  });
});

describe('screenBlock', () => {
  const block = screenBlock(FRAME.takenAt);

  it('stamps the instant the picture was taken', () => {
    expect(block).toContain(FRAME.takenAt);
  });

  it('says the frame is not company memory', () => {
    // The failure this prevents is a citation the reader cannot follow.
    expect(block).toContain('NO es un documento ni parte de la memoria de la empresa');
  });

  it('demands a source when the answer crosses the screen with what is known', () => {
    // The differentiator. Without this the model answers from the picture
    // alone, because the picture is right there and searching is work.
    expect(block).toContain('cita la fuente');
  });

  it('requires the model to say what it cannot see', () => {
    expect(block).toContain('Di qué NO alcanzas a ver');
  });

  it('forbids transcribing a credential that is visible on screen', () => {
    expect(block).toContain('no lo transcribas');
  });
});

describe('attachScreenFrame', () => {
  const history: CoreMessage[] = [
    { role: 'user', content: '¿Cuánto facturamos en julio?' },
    { role: 'assistant', content: 'Cuarenta millones.' },
    { role: 'user', content: '¿Qué significa este error?' },
  ];

  it('puts the picture on the question that was just asked', () => {
    const out = attachScreenFrame(history, FRAME);
    expect(out[2]).toEqual({
      role: 'user',
      content: [
        { type: 'image', image: FRAME.base64, mimeType: FRAME.mimeType },
        { type: 'text', text: '¿Qué significa este error?' },
      ],
    });
  });

  it('leaves every earlier message exactly as it was', () => {
    // A frame that reached an older turn would silently re-answer a question
    // the person is no longer asking.
    const out = attachScreenFrame(history, FRAME);
    expect(out[0]).toBe(history[0]);
    expect(out[1]).toBe(history[1]);
  });

  it('does not mutate the array it was given', () => {
    const out = attachScreenFrame(history, FRAME);
    expect(history[2]?.content).toBe('¿Qué significa este error?');
    expect(out).not.toBe(history);
  });

  it('attaches to the last user message even when an assistant turn follows', () => {
    // `reload()` and the transcript merge can both leave an assistant row at
    // the tail; the picture still belongs to the question.
    const trailing: CoreMessage[] = [...history, { role: 'assistant', content: '' }];
    const out = attachScreenFrame(trailing, FRAME);
    expect(Array.isArray(out[2]?.content)).toBe(true);
    expect(out[3]).toEqual({ role: 'assistant', content: '' });
  });

  it('drops the frame rather than hang it off a turn nobody asked', () => {
    const noUser: CoreMessage[] = [{ role: 'assistant', content: 'Hola.' }];
    expect(attachScreenFrame(noUser, FRAME)).toEqual(noUser);
  });
});
