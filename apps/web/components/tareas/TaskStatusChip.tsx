import {
  TASK_STATUS_LABEL,
  TASK_STATUS_TONE,
  type TaskStatus,
} from '@/lib/background-tasks/status';
import { chipClass } from '@/lib/status-chip';
import { Loader2 } from 'lucide-react';

/** El estado de una tarea con la cápsula de siempre. «Trabajando» lleva su rueda. */
export function TaskStatusChip({ status }: { status: TaskStatus }) {
  return (
    <span className={chipClass(TASK_STATUS_TONE[status])}>
      {status === 'working' && (
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
      )}
      {TASK_STATUS_LABEL[status]}
    </span>
  );
}
