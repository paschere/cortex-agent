/**
 * EL REGISTRO: nombre de trabajo → handler que lo ejecuta.
 *
 * Este es el espejo de `services/jobs/src/manifest.ts`. El worker de pg-boss
 * sólo conoce nombres; cuando un trabajo vence llama a `/api/jobs/run` con
 * `{ name, data }` y ese puente busca aquí. Cada nombre del manifiesto DEBE
 * tener una entrada, y ninguna entrada puede nombrar algo que el manifiesto no
 * conozca — `jobs-registry.test.ts` falla si las dos listas divergen, y ese
 * test es la única razón por la que se puede confiar en que no lo hagan.
 *
 * SOBRE LOS NOMBRES NUEVOS DE LOS CRON. En Inngest un cron no tenía nombre de
 * evento: la función se disparaba sola. pg-boss necesita una cola con nombre
 * por cron, así que el manifiesto les dio uno ('errand/sweep',
 * 'drive/sync', …). Los trabajos que ya llegaban por evento conservan su
 * nombre original intacto, porque ese nombre es el contrato con todos los
 * call sites que hoy encolan.
 *
 * SÓLO SERVIDOR. Lo importa únicamente la API route del puente; los handlers
 * arrastran supabase service-role, el SDK de IA y node:dns vía
 * @cortex/agent-tools, nada de lo cual puede acercarse a un bundle de cliente.
 */

import {
  actionsSweepDispatchJob,
  actionsSweepWorkspaceJob,
} from '@/inngest/functions/actions-sweep';
import {
  commitmentsWatchDispatchJob,
  commitmentsWatchWorkspaceJob,
} from '@/inngest/functions/commitments-watch';
import { devTaskIntakeJob } from '@/inngest/functions/dev-task-intake';
import { devTaskRunJob } from '@/inngest/functions/dev-task-run';
import { devTaskStatusJob } from '@/inngest/functions/dev-task-status';
import { driveSyncJob } from '@/inngest/functions/drive-sync';
import { errandRunJob } from '@/inngest/functions/errand-run';
import { errandSweepJob } from '@/inngest/functions/errand-sweep';
import { goalsWatchDispatchJob, goalsWatchWorkspaceJob } from '@/inngest/functions/goals-watch';
import { ingestDocumentJob } from '@/inngest/functions/ingest-document';
import {
  learningPassDispatchJob,
  learningPassWorkspaceJob,
} from '@/inngest/functions/learning-pass';
import { meetingImportSweepJob } from '@/inngest/functions/meeting-import';
import { memoryDeriveDispatchJob, memoryDeriveUserJob } from '@/inngest/functions/memory-derive';
import { orchestratorRunJob } from '@/inngest/functions/orchestrator-run';
import { orchestratorSweepJob } from '@/inngest/functions/orchestrator-sweep';
import { reindexEmbeddingsJob } from '@/inngest/functions/reindex-embeddings';
import { scheduleDispatchJob } from '@/inngest/functions/schedule-dispatch';
import { scheduleRunJob } from '@/inngest/functions/schedule-run';
import { turnContextPurgeJob, turnLatencyPurgeJob } from '@/inngest/functions/turn-context-purge';
import {
  weeklyReportDispatchJob,
  weeklyReportWorkspaceJob,
} from '@/inngest/functions/weekly-report';
import type { JobHandler } from '@/lib/jobs';

export const JOB_HANDLERS: Record<string, JobHandler> = {
  // --- Cron puros: nombre nuevo del manifiesto → función que era sólo cron --
  'errand/sweep': errandSweepJob,
  'schedule/dispatch': scheduleDispatchJob,
  'orchestrator/sweep': orchestratorSweepJob,
  'drive/sync': driveSyncJob,
  'meetings/import': meetingImportSweepJob,
  'memory/derive.dispatch': memoryDeriveDispatchJob,
  'commitments/watch.dispatch': commitmentsWatchDispatchJob,
  'actions/sweep.dispatch': actionsSweepDispatchJob,
  'goals/watch.dispatch': goalsWatchDispatchJob,
  'reports/weekly.dispatch': weeklyReportDispatchJob,

  // --- Por evento: el nombre de siempre, intacto --------------------------
  'errand/advance': errandRunJob,
  'orchestrator/run.started': orchestratorRunJob,
  'scheduled/job.run': scheduleRunJob,
  'kb/document.ingest': ingestDocumentJob,
  // Cron Y evento a la vez, con el mismo nombre desde siempre.
  'kb/embeddings.reindex': reindexEmbeddingsJob,
  'turn-context/purge': turnContextPurgeJob,
  'turn-latency/purge': turnLatencyPurgeJob,
  'learning/pass.dispatch': learningPassDispatchJob,
  'learning/pass.workspace': learningPassWorkspaceJob,
  'actions/sweep.workspace': actionsSweepWorkspaceJob,
  'commitments/watch.workspace': commitmentsWatchWorkspaceJob,
  'goals/watch.workspace': goalsWatchWorkspaceJob,
  'memory/derive.user': memoryDeriveUserJob,
  'reports/weekly.workspace': weeklyReportWorkspaceJob,
  'dev/task.intake': devTaskIntakeJob,
  'dev/task.queued': devTaskRunJob,
  'dev/task.status': devTaskStatusJob,
};
