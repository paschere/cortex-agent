import { formatDataStreamPart } from 'ai';
import type { StepLike } from './message-parts';
import type { InterruptReason } from './turn-budget';
import {
  INTERRUPTION_NOTES,
  type TurnOutcome,
  buildAssistantRecord,
  formatNote,
} from './turn-transcript';

/**
 * LA RESPUESTA SE GUARDA MIENTRAS SE PRODUCE, NO SÓLO AL FINAL.
 *
 * Cada paso que ejecutó herramientas deja un PUNTO DE CONTROL: la fila del
 * asistente se inserta (o se actualiza) con lo que va, marcada «se cortó antes
 * de terminar». Si la función muere sin llegar al final —la plataforma, un
 * despliegue, un error que nadie vio— lo que queda en la base es exactamente lo
 * producido hasta el último paso, con sus resultados de herramientas, y el
 * siguiente «sigue» lo retoma (ver `digestToolWork`). Al final, `finalize`
 * sobreescribe la misma fila con el estado verdadero.
 *
 * Las escrituras van en fila: una actualización nunca adelanta a la inserción
 * de la que depende. Y nunca lanza: guardar mal cuesta un log, no el turno.
 */

export interface AssistantRow {
  content: string;
  tool_calls: unknown;
  tool_results: unknown;
  parts?: unknown;
  brain_sources?: unknown;
}

/** Lo poco que esto necesita de la tabla `messages`. */
export interface MessagesWriter {
  insert(row: AssistantRow): Promise<{ id: string | null; error?: string }>;
  update(id: string, row: AssistantRow): Promise<{ error?: string }>;
}

export interface TurnPersister {
  checkpoint(steps: readonly StepLike[]): void;
  finalize(steps: readonly StepLike[], outcome: TurnOutcome): Promise<string | null>;
  /** El id de la fila, si ya existe. */
  id(): string | null;
}

export function createTurnPersister(opts: {
  writer: MessagesWriter;
  /** Columnas que sólo van en la escritura completa (p. ej. `brain_sources`). */
  extra?: Partial<AssistantRow>;
  log?: (message: string, detail: Record<string, unknown>) => void;
}): TurnPersister {
  let rowId: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let finalized = false;
  const log = opts.log ?? (() => {});

  const write = async (steps: readonly StepLike[], outcome: TurnOutcome) => {
    const record = buildAssistantRecord(steps, outcome);
    if (!record) return;
    const full: AssistantRow = {
      content: record.content,
      tool_calls: record.toolCalls,
      tool_results: record.toolResults,
      parts: record.parts,
      ...opts.extra,
    };
    // Sin `parts` ni extras: si la fila completa no entra (jsonb gigante, una
    // columna nueva sin migrar), al menos el texto y las herramientas sí.
    const lean: AssistantRow = {
      content: record.content,
      tool_calls: record.toolCalls,
      tool_results: record.toolResults,
    };
    if (rowId === null) {
      const first = await opts.writer.insert(full);
      if (!first.error && first.id) {
        rowId = first.id;
        return;
      }
      log('chat: assistant message insert failed', { error: first.error, outcome });
      const second = await opts.writer.insert(lean);
      if (second.error || !second.id) {
        log('chat: assistant message fallback insert failed', { error: second.error, outcome });
        return;
      }
      rowId = second.id;
      return;
    }
    const first = await opts.writer.update(rowId, full);
    if (!first.error) return;
    log('chat: assistant message update failed', { error: first.error, outcome });
    const second = await opts.writer.update(rowId, lean);
    if (second.error)
      log('chat: assistant message fallback update failed', { error: second.error });
  };

  const enqueue = (steps: readonly StepLike[], outcome: TurnOutcome) => {
    // Copia: los pasos siguen creciendo mientras la escritura espera turno.
    const snapshot = steps.map((s) => ({ ...s }));
    chain = chain
      .then(() => write(snapshot, outcome))
      .catch((err) =>
        log('chat: assistant message write threw', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    return chain;
  };

  return {
    checkpoint(steps) {
      if (finalized) return;
      void enqueue(steps, 'pending');
    },
    async finalize(steps, outcome) {
      finalized = true;
      await enqueue(steps, outcome);
      return rowId;
    },
    id: () => rowId,
  };
}

/**
 * El desenlace de un turno a partir de lo que se sabe al cerrar el stream.
 * Un abort nuestro manda sobre todo (aunque el SDK haya alcanzado a llamar a
 * `onFinish` con los pasos previos); después, un error visto en el stream.
 */
export function turnOutcome(input: {
  interrupted: InterruptReason | null;
  finished: boolean;
  errored: boolean;
}): TurnOutcome {
  if (input.interrupted) return input.interrupted;
  if (input.errored) return 'error';
  return input.finished ? 'complete' : 'error';
}

/** Lo que `mergeIntoDataStream` usa del escritor. */
export interface MergeTarget {
  merge(stream: ReadableStream<string>): void;
  onError: ((error: unknown) => string) | undefined;
}

/**
 * Envuelve el escritor del data stream para que un CORTE NUESTRO no se vea como
 * un error: si el turno se abortó por tiempo o porque el cliente se fue, las
 * partes de error (`3:`) y el error del stream se tragan, y en el corte por
 * tiempo se agrega al final la misma nota que queda guardada. Así la persona ve
 * su respuesta a medias con «escríbeme sigue», no una tarjeta roja — y al
 * recargar ve exactamente lo mismo.
 *
 * Un error de verdad (el turno NO fue interrumpido) pasa tal cual.
 */
export function guardTurnStream(
  target: MergeTarget,
  interrupted: () => InterruptReason | null,
): MergeTarget {
  return {
    onError: target.onError,
    merge(stream) {
      target.merge(
        new ReadableStream<string>({
          async start(controller) {
            const reader = stream.getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (interrupted() && typeof value === 'string' && value.startsWith('3:')) continue;
                controller.enqueue(value);
              }
            } catch (error) {
              if (!interrupted()) {
                controller.error(error);
                return;
              }
            }
            if (interrupted() === 'deadline') {
              controller.enqueue(
                formatDataStreamPart('text', `\n\n${formatNote(INTERRUPTION_NOTES.deadline)}`),
              );
            }
            controller.close();
          },
        }),
      );
    },
  };
}
