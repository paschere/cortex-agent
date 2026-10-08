import { type CoreMessage, createDataStreamResponse, formatDataStreamPart, streamText } from 'ai';
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { continuationNudge, shouldContinue } from './turn-continuation';

const textStep = (text: string) => ({
  stream: simulateReadableStream({
    chunks: [
      { type: 'text-delta' as const, textDelta: text },
      {
        type: 'finish' as const,
        finishReason: 'stop' as const,
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ],
  }),
  rawCall: { rawPrompt: null, rawSettings: {} },
});

/** El mismo armado que `execute` en app/api/chat/route.ts. */
describe('la continuación automática en el stream', () => {
  it('un turno que termina en promesa sigue en el MISMO mensaje, con el empujón', async () => {
    const prompts: unknown[] = [];
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async ({ prompt }) => {
        prompts.push(prompt);
        return call++ === 0
          ? textStep('Las tablas están listas. Ahora diseño la app completa.')
          : textStep(' Quedó creada.');
      },
    });
    const base: CoreMessage[] = [{ role: 'user', content: 'créala' }];
    let lastText = '';
    let finishReason: string | undefined;
    const res = createDataStreamResponse({
      execute: async (ds) => {
        const first = streamText({
          model,
          messages: base,
          onStepFinish: (s) => {
            lastText = s.text;
            finishReason = s.finishReason;
          },
        });
        first.mergeIntoDataStream(ds, { experimental_sendFinish: false });
        await first.consumeStream();
        const kind = shouldContinue({
          lastStepText: lastText,
          lastStepHadTools: false,
          finishReason,
          stepsUsed: 1,
          maxSteps: 12,
          pastSoft: false,
          alreadyContinued: false,
        });
        expect(kind).toBe('promise');
        if (!kind) return;
        const response = await first.response;
        const second = streamText({
          model,
          messages: [
            ...base,
            ...(response.messages as CoreMessage[]),
            { role: 'user', content: continuationNudge(kind, lastText) },
          ],
        });
        second.mergeIntoDataStream(ds);
        await second.consumeStream();
      },
    });
    const body = await res.text();
    expect(body).toContain('Ahora diseño la app completa.');
    expect(body).toContain('Quedó creada.');
    // Un solo «d:» (fin de mensaje): el del segundo tramo.
    expect(body.split('\n').filter((l) => l.startsWith('d:'))).toHaveLength(1);
    expect(JSON.stringify(prompts[1])).toContain('Mensaje automático de Cortex');
    expect(formatDataStreamPart('text', 'x')).toBe('0:"x"\n');
  });
});
