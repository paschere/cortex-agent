import { createDataStreamResponse, streamText, tool } from 'ai';
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { TOOL_PROGRESS_TYPE } from './tool-progress';

/** Mismo armado que app/api/chat/route.ts: avance como anotación, el resto igual. */
describe('stream del chat con avance de herramientas', () => {
  it('entrega texto, tool call, anotación de avance y el error humano', async () => {
    let write: ((a: never) => void) | null = null;
    const model = new MockLanguageModelV1({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            {
              type: 'tool-call',
              toolCallType: 'function',
              toolCallId: 'c1',
              toolName: 't',
              args: '{}',
            },
            {
              type: 'finish',
              finishReason: 'tool-calls',
              usage: { promptTokens: 1, completionTokens: 1 },
            },
          ],
        }),
        rawCall: { rawPrompt: null, rawSettings: {} },
      }),
    });
    const result = streamText({
      model,
      prompt: 'x',
      tools: {
        t: tool({
          parameters: z.object({}),
          execute: async (_a, { toolCallId }) => {
            write?.({ type: TOOL_PROGRESS_TYPE, toolCallId, line: 'Leyendo…', at: 1 } as never);
            return 'ok';
          },
        }),
      },
    });
    const res = createDataStreamResponse({
      headers: { 'X-Conversation-Id': 'conv' },
      execute: (ds) => {
        write = (a) => ds.writeMessageAnnotation(a);
        result.mergeIntoDataStream(ds, { sendReasoning: true });
      },
      onError: () => 'error humano',
    });
    expect(res.headers.get('X-Conversation-Id')).toBe('conv');
    const body = await res.text();
    expect(body).toContain('"toolCallId":"c1"');
    expect(body).toContain('Leyendo…');
    expect(body).toContain('tool-progress');
  });
});
