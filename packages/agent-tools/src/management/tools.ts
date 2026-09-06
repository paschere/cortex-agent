import { z } from 'zod';
import { bogotaToday } from '../commitments/shape';
import { registerTool } from '../registry';
import {
  managementCaseSchema,
  managementDailyReport,
  managementPriority,
  managementSourceConflicts,
} from './shape';
import {
  getManagementCase,
  readManagement,
  readManagementEvents,
  readManagementSignals,
  saveManagementCase,
} from './store';
import {
  advanceCollectionWorkflow,
  cancelCollectionWorkflow,
  readCollectionWorkflow,
  readWorkflowHistory,
  startCollectionWorkflow,
} from './workflow';
import { workflowStartSchema } from './workflow-shape';

export const managementBrief = registerTool({
  id: 'management.brief',
  description:
    'Mesa de gerencia: alcance de esta empresa, manuales de procesos, asuntos priorizados con razones, responsables, bloqueos, seguimiento y señales de compromisos/metas/aprobaciones/encargos. Distingue señales de asuntos aceptados. Un cierre verificado es revisión humana, no prueba automática. No implica permisos externos ni envía notificaciones. Consultar al preparar el resumen diario o decidir prioridades.',
  inputSchema: z.object({}),
  outputSchema: z.object({ overview: z.unknown() }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => {
    const [board, sources] = await Promise.all([
      readManagement(ctx.db),
      readManagementSignals(ctx.db, ctx.userId),
    ]);
    const today = bogotaToday();
    return {
      overview: {
        ...board,
        ...sources,
        sourceConflicts: managementSourceConflicts(sources.signals, board.cases),
        today,
        cases: board.cases
          .map((c) => ({ ...c, priority: managementPriority(c, today, board.cases) }))
          .sort((a, b) => b.priority.score - a.priority.score),
        guidance:
          'Los asuntos son compartidos con la empresa. No copies Feed, perfiles o datos privados sin indicación de compartir. El seguimiento se calcula al consultar; no prometas alertas ni acciones futuras sin programarlas con herramientas existentes. Los manuales son contexto, no autorización.',
      },
    };
  },
});
export const managementInspect = registerTool({
  id: 'management.inspect',
  description:
    'Consulta un asunto de gerencia y sus últimas 100 revisiones, con quién cambió qué y cuándo.',
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: z.object({ item: z.unknown(), history: z.unknown() }),
  rateLimit: { perMinute: 30 },
  handler: async ({ id }, ctx) => ({
    item: await getManagementCase(ctx.db, id),
    history: await readManagementEvents(ctx.db, id),
  }),
});
export const managementRecord = registerTool({
  id: 'management.record',
  description:
    'Registra o actualiza un asunto COMPARTIDO con la empresa, por petición del usuario: objetivo, responsable, plazo, criterio de éxito, próxima revisión, dependencia, bloqueo y evidencia propuesta. Consulta management.brief primero. No envía, no ejecuta trámites, no modifica mandatos. No puede verificar su propio resultado: prepara estado review y un administrador cierra en /management. Usa la revisión actual para evitar sobreescrituras. No copies información privada sin indicación del usuario.',
  inputSchema: z.object({
    id: z.string().uuid().optional(),
    revision: z.number().int().nonnegative().optional(),
    data: managementCaseSchema,
  }),
  outputSchema: z.object({ item: z.unknown() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async ({ id, revision, data }, ctx) => ({
    item: await saveManagementCase(ctx.db, ctx.userId, data, { id, revision, humanReview: false }),
  }),
});

export const managementDailyBrief = registerTool({
  id: 'management.daily_brief',
  description:
    'Parte diario determinista de asuntos compartidos: vencimientos, bloqueos, revisiones pendientes y responsables. Solo lectura; no incluye aprobaciones o encargos privados, no envía mensajes ni ejecuta acciones. Se puede programar como llamada fija.',
  inputSchema: z.object({}),
  outputSchema: z.object({ report: z.string() }),
  rateLimit: { perMinute: 10 },
  handler: async (_input, ctx) => {
    const board = await readManagement(ctx.db);
    return {
      report: managementDailyReport(
        board.cases,
        board.people,
        board.profile.data,
        bogotaToday(),
        board.truncated,
      ),
    };
  },
});

export const managementCollectionStatus = registerTool({
  id: 'management.collection_status',
  description:
    'Consulta el proceso de cobro de un asunto compartido y su historial. La evidencia es una consulta fechada de pagos confirmados, no una consulta bancaria en vivo.',
  inputSchema: z.object({ caseId: z.string().uuid() }),
  outputSchema: z.object({ run: z.unknown(), history: z.unknown() }),
  handler: async ({ caseId }, ctx) => {
    const run = await readCollectionWorkflow(ctx.db, caseId);
    return { run, history: run ? await readWorkflowHistory(ctx.db, run.id) : [] };
  },
});
export const managementStartCollection = registerTool({
  id: 'management.start_collection',
  description:
    'Por petición expresa, inicia seguimiento de cobro sobre una factura confirmada y un destinatario especificado. Prepara un borrador y consulta saldo/respuesta cada 15 minutos. El envío requiere aprobación separada en Acciones. El proceso es visible para la empresa.',
  inputSchema: workflowStartSchema,
  outputSchema: z.object({ run: z.unknown() }),
  requiresConfirmation: true,
  handler: async (input, ctx) => {
    const run = await startCollectionWorkflow(ctx.db, ctx.userId, input);
    return { run: (await advanceCollectionWorkflow(ctx.db, run.id)) ?? run };
  },
});
export const managementAdvanceCollection = registerTool({
  id: 'management.advance_collection',
  description:
    'Revisa ahora o detiene un proceso iniciado por el usuario actual. Reanudar consulta las fuentes y puede preparar el primer borrador; nunca envía ni repite un envío.',
  inputSchema: z.object({ caseId: z.string().uuid(), cancel: z.boolean().default(false) }),
  outputSchema: z.object({ run: z.unknown() }),
  requiresConfirmation: true,
  handler: async ({ caseId, cancel }, ctx) => {
    const run = await readCollectionWorkflow(ctx.db, caseId);
    if (!run || run.user_id !== ctx.userId)
      throw new Error('Solo quien inició el proceso puede continuarlo o detenerlo.');
    if (cancel) await cancelCollectionWorkflow(ctx.db, ctx.userId, run.id);
    else await advanceCollectionWorkflow(ctx.db, run.id);
    return { run: await readCollectionWorkflow(ctx.db, caseId) };
  },
});
