import { z } from 'zod';
import { registerTool } from '../index';

/**
 * `tasks.start_background`: CORTEX PROPONE SEGUIR EN SEGUNDO PLANO.
 *
 * Para trabajo largo —recorrer muchos documentos, preparar un informe con varias
 * fuentes, una cadena de pasos— Cortex puede proponer terminarlo fuera del chat:
 * la tarea corre en el servidor, la persona puede cerrar la pestaña, ve el
 * avance al volver a abrir la conversación y recibe un aviso al terminar.
 *
 * LA PERSONA DECIDE. `requiresConfirmation` es lo que convierte esto en una
 * propuesta y no en algo que se hace solo: el chat muestra la tarjeta «Seguir en
 * segundo plano» y la tarea sólo se encola si la aprueba. Lo que la tarea haga
 * después pasa por las mismas confirmaciones del chat.
 *
 * El motor (corredor, estados, avisos) vive en apps/web/lib/background-tasks; la
 * herramienta sólo escribe la fila y encola el trabajo, por eso no importa nada de
 * la app (el paquete no puede alcanzarla).
 */

const MAX_ACTIVE_PER_USER = 5;
const JOB_NAME = 'tasks/run';

export const tasksStartBackground = registerTool({
  id: 'tasks.start_background',
  description:
    'PROPOSE finishing a long job in the BACKGROUND so the person does not have to wait with the tab open: «hazlo en segundo plano», «avísame cuando termines», «déjalo corriendo», «sigue tú y me avisas», or when the work will clearly take many minutes (reading dozens of documents, a multi-source report, a long chain of steps). The person approves a card first; then the task keeps going on the server, the conversation shows its progress live from any device, anything that needs approval pauses it as «te necesita», and they get a notification when it finishes or needs them. Do NOT use it for something you can answer in this turn. After calling it, end your message with ONE short sentence saying it continues in the background and they will be notified — do not keep working on the same job in this turn. `request` must be a complete, self-contained instruction of what the task has to do and deliver.',
  inputSchema: z.object({
    request: z
      .string()
      .trim()
      .min(10)
      .max(4000)
      .describe(
        "What the background task must do and deliver, self-contained, in the person's language",
      ),
    title: z.string().trim().min(3).max(120).optional().describe('A short name for the task'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    taskId: z.string().nullable(),
    message: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 3 },
  handler: async (input, ctx) => {
    if (!ctx.conversationId) {
      return {
        ok: false,
        taskId: null,
        message: 'Una tarea en segundo plano necesita una conversación donde guardar su avance.',
      };
    }
    if (!ctx.enqueueJob) {
      return {
        ok: false,
        taskId: null,
        message: 'Aquí no se pueden encolar tareas en segundo plano.',
      };
    }
    const { count } = await ctx.db
      .from('background_tasks')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', ctx.userId)
      .in('status', ['queued', 'working', 'needs_you']);
    if ((count ?? 0) >= MAX_ACTIVE_PER_USER) {
      return {
        ok: false,
        taskId: null,
        message: `Ya hay ${MAX_ACTIVE_PER_USER} tareas en curso; espera a que termine alguna.`,
      };
    }
    const title = input.title ?? input.request.replace(/\s+/g, ' ').slice(0, 80);
    const { data, error } = await ctx.db
      .from('background_tasks')
      .insert({
        user_id: ctx.userId,
        conversation_id: ctx.conversationId,
        title,
        prompt: input.request,
        mode: 'continue',
      })
      .select('id')
      .single();
    if (error || !data) {
      return { ok: false, taskId: null, message: 'No pude crear la tarea.' };
    }
    const taskId = (data as { id: string }).id;
    const queued = await ctx.enqueueJob(JOB_NAME, {
      taskId,
      organizationId: ctx.organizationId,
    });
    if (!queued) {
      await ctx.db
        .from('background_tasks')
        .update({
          status: 'failed',
          error: 'No se pudo encolar la tarea.',
          finished_at: new Date().toISOString(),
        })
        .eq('id', taskId);
      return { ok: false, taskId, message: 'No pude encolar la tarea. Inténtalo de nuevo.' };
    }
    return {
      ok: true,
      taskId,
      message:
        'La tarea quedó en cola y sigue en segundo plano. Dile a la persona que puede cerrar la pestaña: verá el avance en esta conversación y en Tareas, y le aviso cuando termine.',
    };
  },
});
