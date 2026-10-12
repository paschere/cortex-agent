import {
  type TaskApproval,
  type TaskStatus,
  isActive,
  parseApprovals,
  parseStatus,
} from './status';

/**
 * La tarea tal como la lee el navegador (serializable, sin lo pesado). La
 * construye el servidor desde la fila (`toBanner`) y el cliente la refresca
 * con GET /api/tasks/[id], que devuelve la forma completa y se estrecha igual.
 */
export interface TaskBanner {
  id: string;
  title: string;
  status: TaskStatus;
  conversationId: string | null;
  segment: number;
  stepsCount: number;
  startedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string | null;
  approvals: TaskApproval[];
  result: string | null;
  error: string | null;
}

type RowLike = Record<string, unknown>;

/** Desde la fila de la base (snake_case) o desde `TaskRecord` (camelCase). */
export function toBanner(input: RowLike): TaskBanner {
  const pick = (camel: string, snake: string) => input[camel] ?? input[snake];
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    id: String(input.id),
    title: String(input.title ?? ''),
    status: parseStatus(input.status),
    conversationId: str(pick('conversationId', 'conversation_id')),
    segment: Number(input.segment ?? 0),
    stepsCount: Number(pick('stepsCount', 'steps_count') ?? 0),
    startedAt: str(pick('startedAt', 'started_at')),
    finishedAt: str(pick('finishedAt', 'finished_at')),
    deadlineAt: str(pick('deadlineAt', 'deadline_at')),
    approvals: parseApprovals(pick('approvals', 'pending_approvals')),
    result: str(input.result),
    error: str(input.error),
  };
}

export const taskIsLive = (t: Pick<TaskBanner, 'status'> | null): boolean =>
  Boolean(t) && isActive((t as TaskBanner).status);

/** Corre solo (cola o trabajando): Cortex está haciendo algo ahora mismo. */
export const taskIsRunning = (t: Pick<TaskBanner, 'status'> | null): boolean =>
  t?.status === 'queued' || t?.status === 'working';

/**
 * Huella de una lista de mensajes para saber si cambió algo que valga la pena
 * repintar: ids, largo del texto y estado de cada invocación. Evita reemplazar
 * el hilo entero (y reiniciar scroll y animaciones) en cada consulta.
 */
export function messagesSignature(
  messages: ReadonlyArray<{
    id: string;
    content: string;
    toolInvocations?: ReadonlyArray<{ toolCallId: string; state: string }>;
  }>,
): string {
  return messages
    .map(
      (m) =>
        `${m.id}:${m.content.length}:${(m.toolInvocations ?? [])
          .map((i) => `${i.toolCallId}${i.state}`)
          .join(',')}`,
    )
    .join('|');
}
