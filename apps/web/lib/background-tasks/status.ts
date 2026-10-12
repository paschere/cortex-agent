/**
 * LA MÁQUINA DE ESTADOS DE UNA TAREA EN SEGUNDO PLANO (migración 0222).
 *
 * Pura: sin base, sin reloj propio, sin imports del servidor. La importan la
 * pantalla «Tareas», el corredor y las pruebas, y por eso vive aparte.
 *
 *   queued ──▶ working ──▶ done
 *      │          │ ▲
 *      │          ▼ │            (la acción parada se aprobó o se rechazó)
 *      │       needs_you
 *      ▼          │
 *  cancelled ◀────┴──▶ failed
 *
 * `done`, `failed` y `cancelled` son finales. «Reintentar» no revive una tarea:
 * crea otra que apunta a la primera (`retry_of`), para que la historia diga lo
 * que pasó.
 */

export const TASK_STATUSES = [
  'queued',
  'working',
  'needs_you',
  'done',
  'failed',
  'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  queued: 'En cola',
  working: 'Trabajando',
  needs_you: 'Te necesita',
  done: 'Lista',
  failed: 'Falló',
  cancelled: 'Cancelada',
};

export type TaskTone = 'neutral' | 'primary' | 'emerald' | 'amber' | 'rose';

export const TASK_STATUS_TONE: Record<TaskStatus, TaskTone> = {
  queued: 'neutral',
  working: 'primary',
  needs_you: 'amber',
  done: 'emerald',
  failed: 'rose',
  cancelled: 'neutral',
};

const NEXT: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['working', 'cancelled', 'failed'],
  working: ['working', 'needs_you', 'done', 'failed', 'cancelled'],
  needs_you: ['working', 'done', 'failed', 'cancelled'],
  done: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return NEXT[from].includes(to);
}

export function isTerminal(status: TaskStatus): boolean {
  return NEXT[status].length === 0;
}

export function isActive(status: TaskStatus): boolean {
  return !isTerminal(status);
}

/** Cancelar se puede mientras no haya terminado. */
export const canCancel = isActive;

/** Reintentar se ofrece cuando no salió bien: falló o la cancelaron. */
export function canRetry(status: TaskStatus): boolean {
  return status === 'failed' || status === 'cancelled';
}

export function parseStatus(value: unknown): TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus) ? (value as TaskStatus) : 'queued';
}

// ---------------------------------------------------------------------------
// Tiempos
// ---------------------------------------------------------------------------

/** El tope de una tarea entera, desde que empieza a trabajar. */
export const TASK_CAP_MS = 20 * 60_000;

/**
 * Lo que dura UNA tanda. El puente de trabajos (`/api/jobs/run`) corre con
 * maxDuration=800 s; la tanda corta bastante antes para guardar lo producido.
 */
export const SEGMENT_MS = 600_000;

/** Sin latido en este tiempo, una tarea «trabajando» se da por muerta (el barrido la cierra). */
export const STALE_AFTER_MS = 5 * 60_000;

export function deadlineFor(startedAt: Date): Date {
  return new Date(startedAt.getTime() + TASK_CAP_MS);
}

/** Cuánto puede durar la siguiente tanda: la tanda estándar o lo que le quede al tope. */
export function segmentBudgetMs(deadlineAt: Date | null, now: Date): number {
  if (!deadlineAt) return SEGMENT_MS;
  return Math.max(0, Math.min(SEGMENT_MS, deadlineAt.getTime() - now.getTime()));
}

/**
 * Entre dos tandas la tarea sigue «trabajando» pero sin latido (`heartbeat_at`
 * nulo) durante los segundos que tarda la siguiente en arrancar: eso no es
 * estar muerta. Un trabajo perdido entre tandas lo recoge el barrido por
 * `updated_at`, no esta función.
 */
export function isStale(
  task: { status: TaskStatus; heartbeatAt: string | null; startedAt: string | null },
  now: Date,
): boolean {
  if (task.status !== 'working' || !task.heartbeatAt) return false;
  return now.getTime() - new Date(task.heartbeatAt).getTime() > STALE_AFTER_MS;
}

/** Duración mostrada: hasta que terminó, o hasta ahora si sigue. Nulo si no empezó. */
export function durationMs(
  task: { startedAt: string | null; finishedAt: string | null },
  now: Date,
): number | null {
  if (!task.startedAt) return null;
  const end = task.finishedAt ? new Date(task.finishedAt) : now;
  const ms = end.getTime() - new Date(task.startedAt).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** «4 min 12 s», «37 s», «1 h 05 min». */
export function formatTaskDuration(ms: number | null): string {
  if (ms === null) return '—';
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return s === 0 ? `${m} min` : `${m} min ${String(s).padStart(2, '0')} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

// ---------------------------------------------------------------------------
// Qué pasa al cerrar una tanda
// ---------------------------------------------------------------------------

/** Cómo terminó el turno de la tanda, visto desde el corredor. */
export type SegmentEnd =
  | 'finished' // el modelo cerró solo
  | 'out_of_time' // la tanda se quedó sin su tiempo y el trabajo sigue
  | 'error'
  | 'cancelled';

export interface AfterSegment {
  status: TaskStatus;
  /** Encolar otra tanda. */
  requeue: boolean;
  /** Por qué se cerró así, para la nota del resultado cuando hace falta. */
  reason: 'finished' | 'needs_you' | 'continues' | 'cap_reached' | 'error' | 'cancelled';
}

/**
 * La decisión al terminar una tanda. Con acciones esperando a la persona la
 * tarea queda «te necesita» aunque el modelo haya cerrado: lo que falta no se
 * puede dar por hecho.
 */
export function afterSegment(input: {
  end: SegmentEnd;
  pendingApprovals: number;
  capReached: boolean;
}): AfterSegment {
  if (input.end === 'cancelled')
    return { status: 'cancelled', requeue: false, reason: 'cancelled' };
  if (input.end === 'error') return { status: 'failed', requeue: false, reason: 'error' };
  if (input.pendingApprovals > 0) {
    return { status: 'needs_you', requeue: false, reason: 'needs_you' };
  }
  if (input.end === 'finished') return { status: 'done', requeue: false, reason: 'finished' };
  if (input.capReached) return { status: 'done', requeue: false, reason: 'cap_reached' };
  return { status: 'working', requeue: true, reason: 'continues' };
}

// ---------------------------------------------------------------------------
// Aprobaciones paradas
// ---------------------------------------------------------------------------

export interface TaskApproval {
  id: string;
  toolId: string;
  summary: string;
  decision?: 'approved' | 'declined';
  /** Si se aprobó: ¿la acción salió bien? */
  ok?: boolean;
  note?: string;
}

export function parseApprovals(value: unknown): TaskApproval[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    if (!v || typeof v !== 'object') return [];
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.toolId !== 'string') return [];
    return [
      {
        id: o.id,
        toolId: o.toolId,
        summary: typeof o.summary === 'string' ? o.summary : o.toolId,
        ...(o.decision === 'approved' || o.decision === 'declined' ? { decision: o.decision } : {}),
        ...(typeof o.ok === 'boolean' ? { ok: o.ok } : {}),
        ...(typeof o.note === 'string' ? { note: o.note } : {}),
      },
    ];
  });
}

export function openApprovals(list: readonly TaskApproval[]): TaskApproval[] {
  return list.filter((a) => !a.decision);
}

/** Todas las paradas ya tienen respuesta (y hay al menos una): la tarea puede seguir. */
export function readyToResume(list: readonly TaskApproval[]): boolean {
  return list.length > 0 && list.every((a) => Boolean(a.decision));
}

/** Lo que se le cuenta al modelo cuando la tarea sigue tras las respuestas de la persona. */
export function approvalsNote(list: readonly TaskApproval[]): string {
  const lines = list
    .filter((a) => a.decision)
    .map((a) => {
      if (a.decision === 'declined') return `- RECHAZADA por la persona (no se hizo): ${a.summary}`;
      return a.ok === false
        ? `- Aprobada pero NO salió bien${a.note ? ` (${a.note})` : ''}: ${a.summary}`
        : `- Aprobada y ejecutada: ${a.summary}`;
    });
  if (lines.length === 0) return '';
  return `Mientras esperabas, la persona respondió a las acciones que dejaste paradas:\n${lines.join('\n')}\nSigue desde ahí: no repitas lo ya hecho ni vuelvas a pedir lo rechazado.`;
}
