import { describe, expect, it } from 'vitest';
import { readVoiceText, realtimeSession } from './voice-realtime';

describe('voice realtime bridge', () => {
  it('handles split SSE frames and emits text before completion', async () => {
    const encoder = new TextEncoder();
    const seen: string[] = [];
    const response = new Response(
      new ReadableStream({
        start(c) {
          for (const part of [
            'event: text\ndata: {"text":"Ho',
            'la"}\n\nevent: text\ndata: {"text":"Cortex"}\n',
            '\nevent: done\ndata: {}\n\n',
          ])
            c.enqueue(encoder.encode(part));
          c.close();
        },
      }),
    );
    expect(await readVoiceText(response, (value) => seen.push(value))).toBe('Hola Cortex');
    expect(seen).toEqual(['Hola', 'Hola Cortex']);
  });
  it('does not present failed or empty tool work as successful', async () => {
    await expect(
      readVoiceText(new Response('event: error\ndata: {"message":"Sin acceso"}\n\n')),
    ).rejects.toThrow('Sin acceso');
    expect(await readVoiceText(new Response('event: done\ndata: {}\n\n'))).toContain(
      'No confirmes',
    );
  });
  it('uses speech-to-speech with interruption and a company tool boundary', () => {
    const config = realtimeSession('example-model', [{ role: 'you', text: 'Mi empresa' }]);
    expect(config.audio.input.turn_detection.interrupt_response).toBe(true);
    expect(config.tools.map((tool) => tool.name)).toEqual(['consult_cortex']);
    expect(config.instructions).toContain('no inventes acceso');
    expect(config.model).toBe('example-model');
  });
});
