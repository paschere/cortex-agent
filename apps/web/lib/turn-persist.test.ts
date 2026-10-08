import { type CoreMessage, createDataStreamResponse, streamText, tool } from 'ai';
import { MockLanguageModelV1, simulateReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTurnBudget } from './turn-budget';
import {
  type AssistantRow,
  type MergeTarget,
  type MessagesWriter,
  createTurnPersister,
  guardTurnStream,
  turnOutcome,
} from './turn-persist';
import { INTERRUPTION_NOTES, TurnTranscript, formatNote } from './turn-transcript';

/** La tabla `messages` en memoria, con el registro de cada escritura. */
function fakeTable(opts: { failParts?: boolean } = {}) {
  const rows = new Map<string, AssistantRow>();
  const log: string[] = [];
  const writer: MessagesWriter = {
    insert: async (row) => {
      if (opts.failParts && 'parts' in row) {
        log.push('insert-fail');
        return { id: null, error: 'payload too large' };
      }
      const id = `m${rows.size + 1}`;
      rows.set(id, row);
      log.push(`insert:${id}`);
      return { id };
    },
    update: async (id, row) => {
      rows.set(id, row);
      log.push(`update:${id}`);
      return {};
    },
  };
  return { rows, log, writer };
}

const toolCallStep = {
  stream: simulateReadableStream({
    chunks: [
      { type: 'text-delta' as const, textDelta: 'Leo la hoja.' },
      {
        type: 'tool-call' as const,
        toolCallType: 'function' as const,
        toolCallId: 'c1',
        toolName: 'leer',
        args: '{}',
      },
      {
        type: 'finish' as const,
        finishReason: 'tool-calls' as const,
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ],
  }),
  rawCall: { rawPrompt: null, rawSettings: {} },
};

/** El segundo paso escribe un poco y se queda colgado hasta que lo abortan. */
function hangingStep(abortSignal: AbortSignal | undefined) {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-delta', textDelta: ' Van 40 filas' });
        abortSignal?.addEventListener('abort', () =>
          controller.error(new DOMException('aborted', 'AbortError')),
        );
      },
    }),
    rawCall: { rawPrompt: null, rawSettings: {} },
  };
}

/** El mismo armado que app/api/chat/route.ts, en miniatura. */
async function runTurn(model: MockLanguageModelV1, budget: ReturnType<typeof createTurnBudget>) {
  const transcript = new TurnTranscript();
  const table = fakeTable();
  const persister = createTurnPersister({ writer: table.writer });
  let finished = false;
  let errored = false;
  let markEnded = () => {};
  const ended = new Promise<void>((r) => {
    markEnded = r;
  });
  const res = createDataStreamResponse({
    execute: async (ds) => {
      try {
        const result = streamText({
          model,
          messages: [{ role: 'user', content: 'lee' }] as CoreMessage[],
          tools: { leer: tool({ parameters: z.object({}), execute: async () => ({ rows: 40 }) }) },
          maxSteps: 5,
          abortSignal: budget.signal,
          onChunk: ({ chunk }) => transcript.onChunk(chunk),
          onStepFinish: () => {
            if (transcript.onStepFinish()) persister.checkpoint(transcript.steps());
          },
          onFinish: () => {
            finished = true;
          },
          onError: () => {
            errored = true;
          },
        });
        result.mergeIntoDataStream(
          guardTurnStream(ds as unknown as MergeTarget, budget.reason) as never,
        );
        await result.consumeStream();
      } finally {
        markEnded();
      }
    },
    onError: () => 'error humano',
  });
  const body = await res.text();
  await ended;
  const outcome = turnOutcome({ interrupted: budget.reason(), finished, errored });
  const id = await persister.finalize(transcript.steps(), outcome);
  budget.dispose();
  return { body, outcome, id, table };
}

describe('un turno que se corta por tiempo', () => {
  it('corta limpio, no muestra error, y guarda texto + resultado de herramienta + nota', async () => {
    let call = 0;
    const model = new MockLanguageModelV1({
      doStream: async ({ abortSignal }) => (call++ === 0 ? toolCallStep : hangingStep(abortSignal)),
    });
    const budget = createTurnBudget({ limitMs: 400, startedAt: Date.now(), marginMs: 250 });
    const { body, outcome, id, table } = await runTurn(model, budget);

    expect(outcome).toBe('deadline');
    // Sin parte de error: la persona ve su respuesta a medias con la nota.
    expect(body).not.toMatch(/(^|\n)3:/);
    expect(body).toContain('escríbeme «sigue»');
    // Punto de control tras el paso con herramienta, y la misma fila al final.
    expect(table.log[0]).toBe('insert:m1');
    expect(table.log[table.log.length - 1]).toBe('update:m1');
    expect(id).toBe('m1');
    const row = table.rows.get('m1');
    expect(row?.content).toBe(
      `Leo la hoja. Van 40 filas\n\n${formatNote(INTERRUPTION_NOTES.deadline)}`,
    );
    expect(row?.tool_results).toEqual([
      expect.objectContaining({ toolCallId: 'c1', result: { rows: 40 } }),
    ]);
  });
});

describe('un turno que falla antes de producir nada', () => {
  it('no se cuelga, no guarda un mensaje vacío y la persona ve el error humano', async () => {
    const model = new MockLanguageModelV1({
      doStream: async () => {
        throw new Error('messages: text content blocks must be non-empty');
      },
    });
    const budget = createTurnBudget({ limitMs: 60_000, startedAt: Date.now() });
    const { body, outcome, id, table } = await runTurn(model, budget);
    expect(outcome).toBe('error');
    expect(id).toBeNull();
    expect(table.log).toEqual([]);
    expect(body).toContain('3:"error humano"');
  });
});

describe('el guardado por pasos', () => {
  it('si la fila completa no entra, guarda al menos texto y herramientas', async () => {
    const table = fakeTable({ failParts: true });
    const p = createTurnPersister({ writer: table.writer });
    const id = await p.finalize([{ text: 'hola' }], 'complete');
    expect(table.log).toEqual(['insert-fail', 'insert:m1']);
    expect(id).toBe('m1');
  });

  it('el desenlace: un abort nuestro manda sobre un onFinish tardío', () => {
    expect(turnOutcome({ interrupted: 'deadline', finished: true, errored: true })).toBe(
      'deadline',
    );
    expect(turnOutcome({ interrupted: null, finished: true, errored: false })).toBe('complete');
    expect(turnOutcome({ interrupted: null, finished: true, errored: true })).toBe('error');
    expect(turnOutcome({ interrupted: null, finished: false, errored: false })).toBe('error');
  });
});
