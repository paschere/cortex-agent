import 'server-only';
import { type AnyTool, NO_THINKING, chatModel } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { generateObject } from 'ai';
import { z } from 'zod';
import { normalizeDependencies } from './graph';

/**
 * The planner: one objective in, a small task DAG out.
 *
 * Exactly one model call. Planning is the step that decides how expensive and
 * how parallel the whole run is, so it gets a structured schema rather than
 * free text — a plan that has to be parsed out of prose is a plan that fails
 * half the time, and each failure costs a full run.
 */

/** Hard ceiling. More than this and the run stops being reviewable by a human. */
export const MAX_TASKS = 8;
/** What the prompt asks for as a floor. Not enforced: see `planObjective`. */
export const MIN_TASKS = 2;

/** How much of each tool description the planner gets to see. */
const DESCRIPTION_CHARS = 130;

const PlanSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z.string().describe('Three to seven words naming the deliverable.'),
        agentLabel: z
          .string()
          .describe('One or two words naming the specialist doing it, e.g. "Researcher".'),
        instruction: z
          .string()
          .describe(
            'The full brief for this sub-agent: what to do, what to produce, how much detail.',
          ),
        dependsOn: z
          .array(z.number().int())
          .describe('1-based positions of earlier tasks whose output this one needs. [] if none.'),
        allowedTools: z
          .array(z.string())
          .describe('Tool ids copied verbatim from the catalogue. [] if this task needs none.'),
      }),
    )
    .min(1)
    .max(MAX_TASKS),
});

export interface PlannedTask {
  title: string;
  agentLabel: string;
  instruction: string;
  dependsOn: number[];
  allowedTools: string[];
}

export interface PlanResult {
  tasks: PlannedTask[];
  tokens: number;
}

/** First sentence of a tool description, capped — the planner needs the gist, not the manual. */
function shortDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, ' ').trim();
  const stop = oneLine.indexOf('. ');
  const head = stop > 30 ? oneLine.slice(0, stop + 1) : oneLine;
  return head.length > DESCRIPTION_CHARS ? `${head.slice(0, DESCRIPTION_CHARS)}…` : head;
}

function catalogue(tools: AnyTool[]): string {
  return tools
    .map(
      (t) =>
        `- ${t.id}${t.requiresConfirmation ? ' [needs human approval]' : ''}: ${shortDescription(t.description)}`,
    )
    .join('\n');
}

const SYSTEM = `You are the planning head of a multi-agent system. You break one objective into a short plan of independent sub-agent tasks, then hand it off. You never do the work yourself.

Rules, all of them hard:
1. Produce between ${MIN_TASKS} and ${MAX_TASKS} tasks. Fewer, larger tasks beat many trivial ones — every task costs a full model round trip.
2. "dependsOn" may only reference tasks EARLIER in the list (1-based). Anything else is dropped. Order the list so that genuinely independent work sits next to itself: tasks with no unmet dependency run in PARALLEL, and that is the point of this system. Only add a dependency when a task literally cannot start without another's output.
3. "allowedTools" must contain tool ids copied character-for-character from the catalogue. A "family.*" wildcard is allowed when a task needs a whole family. Give each task the narrowest set that can do its job; unknown ids are dropped silently.
4. Sub-agents run UNATTENDED: nobody is there to answer a question or approve anything. Tools marked [needs human approval] are SKIPPED at run time, so only reach for one when the objective explicitly asked for that side effect, and expect it not to happen.
5. Each "instruction" is a self-contained brief. The sub-agent sees the overall objective and the output of its dependencies, and nothing else — no chat history, no other task's brief.
6. The last task should normally be analysis or synthesis over earlier results rather than another data pull. A separate final report is written for you afterwards, so do not add a task whose only job is "write the report".`;

/**
 * Plans `objective` into tasks the executor can walk.
 *
 * @param tools the catalogue this workspace's user may actually call — already
 *   narrowed by the agent's grants and the team deny-list, so the planner can
 *   never propose a tool the executor would then refuse.
 */
export async function planObjective(opts: {
  objective: string;
  tools: AnyTool[];
  model?: string | null;
}): Promise<PlanResult> {
  const prompt = `OBJECTIVE\n${opts.objective}\n\nTOOL CATALOGUE (${opts.tools.length} tools)\n${catalogue(opts.tools)}\n\nPlan it.`;

  /**
   * PLANIFICAR, Y SI SALE MAL, VOLVER A INTENTARLO UNA VEZ Y CONTAR QUÉ PASÓ.
   *
   * ===========================================================================
   * EL FALLO QUE ESTO ATIENDE
   * ===========================================================================
   * En producción, un objetivo real terminó así después de veintidós segundos:
   *
   *     «No object generated: response did not match schema.»
   *
   * Cero subagentes, cero herramientas, y esa frase —en inglés, de la SDK— es
   * literalmente todo lo que vio la persona. En un producto en español, sobre
   * una espera de veintidós segundos, eso no es un mensaje de error: es un
   * callejón. No dice si fue culpa del objetivo, de un tope de tokens o de un
   * mal día del modelo, así que no hay ninguna acción que tomar después.
   *
   * ===========================================================================
   * TRES COSAS, Y LA TERCERA ES LA QUE MÁS VALE
   * ===========================================================================
   * UN REINTENTO. `generateObject` obliga al modelo a una forma exacta y
   * fallar una vez es un suceso ordinario — a veces contesta en prosa, a veces
   * corta el JSON. Reintentar es lo primero que haría una persona y hasta hoy
   * no lo hacía nadie: el turno moría al primer intento.
   *
   * MÁS TECHO. 4.096 tokens para hasta ocho tareas con su brief completo, sus
   * dependencias y su lista de herramientas es justo, y un JSON cortado a la
   * mitad falla EXACTAMENTE con este mensaje. Subirlo no arregla la causa si es
   * otra, pero descarta la más barata de descartar.
   *
   * Y SOBRE TODO: SE GUARDA LO QUE EL MODELO ESCRIBIÓ DE VERDAD.
   * `NoObjectGeneratedError` trae `text`, `finishReason` y `usage`, y hasta hoy
   * se tiraban los tres. Sin poder reproducir el fallo —cada intento cuesta
   * dinero— eso era quedarse a ciegas. Ahora la próxima vez que pase, el
   * registro dice si el JSON venía cortado (`finishReason: 'length'`), si el
   * modelo contestó en prosa, o si es otra cosa. Un fallo que no se puede
   * reproducir tiene que explicarse solo.
   */
  const attempt = async () =>
    generateObject({
      model: chatModel(opts.model),
      schema: PlanSchema,
      system: SYSTEM,
      prompt,
      // Shape-constrained call with an explicit schema: extended thinking buys
      // little here and its tokens count against maxTokens, which would truncate
      // the plan itself. See NO_THINKING in packages/agent-tools/src/model.ts.
      experimental_providerMetadata: NO_THINKING,
      maxTokens: 8192,
    });

  let object: Awaited<ReturnType<typeof attempt>>['object'];
  let usage: Awaited<ReturnType<typeof attempt>>['usage'];
  try {
    ({ object, usage } = await attempt());
  } catch (first) {
    describeFailure(first, 'primer intento');
    try {
      ({ object, usage } = await attempt());
    } catch (second) {
      throw new Error(describeFailure(second, 'segundo intento'));
    }
  }

  const raw = object.tasks.slice(0, MAX_TASKS);
  const deps = normalizeDependencies(raw.map((t) => t.dependsOn ?? []));
  const known = new Set(opts.tools.map((t) => t.id));

  const tasks: PlannedTask[] = raw.map((task, index) => ({
    title: task.title.trim().slice(0, 120) || `Task ${index + 1}`,
    agentLabel: task.agentLabel.trim().slice(0, 40) || 'Agent',
    instruction: task.instruction.trim(),
    dependsOn: deps[index] ?? [],
    allowedTools: sanitizeTools(task.allowedTools ?? [], known),
  }));

  // A single-task plan is left alone rather than padded. The prompt asks for
  // two or more, but an objective that genuinely is one job should not be split
  // into make-work just to satisfy a floor.
  return { tasks, tokens: usage?.totalTokens ?? 0 };
}

/**
 * Keeps only ids the registry actually knows, plus family wildcards that match
 * at least one of them. A hallucinated id would otherwise sit in the UI looking
 * like a capability the sub-agent had.
 */
function sanitizeTools(requested: string[], known: Set<string>): string[] {
  const out = new Set<string>();
  for (const raw of requested) {
    const id = raw.trim();
    if (!id) continue;
    if (known.has(id)) {
      out.add(id);
      continue;
    }
    if (id.endsWith('.*')) {
      const prefix = id.slice(0, -1);
      if ([...known].some((k) => k.startsWith(prefix))) out.add(id);
    }
  }
  return [...out];
}

/**
 * QUÉ PASÓ DE VERDAD CUANDO EL PLAN NO SALIÓ.
 *
 * `NoObjectGeneratedError` de la SDK trae tres cosas que su mensaje no dice y
 * que son justo las que distinguen las causas posibles:
 *
 *   `finishReason: 'length'`  el JSON venía CORTADO por el tope de tokens. Es
 *                             la causa más probable de «did not match schema»
 *                             en un esquema grande, y la única que se arregla
 *                             subiendo un número.
 *   `text`                    lo que el modelo escribió de verdad. Si es prosa
 *                             —«necesito saber quiénes son tus competidores»—
 *                             el problema es el objetivo, no el esquema.
 *   `usage`                   cuánto llegó a gastar antes de morir.
 *
 * Se registran los tres y se devuelve una frase que una persona pueda leer. La
 * de la SDK, «No object generated: response did not match schema», es correcta
 * y no le sirve a nadie: está en inglés, nombra un concepto interno y no dice
 * qué hacer después.
 */
function describeFailure(err: unknown, which: string): string {
  const e = err as {
    text?: unknown;
    finishReason?: unknown;
    usage?: unknown;
    message?: unknown;
  };
  const finishReason = typeof e.finishReason === 'string' ? e.finishReason : null;
  const text = typeof e.text === 'string' ? e.text : null;

  logger.warn('El planificador del orquestador no devolvió un plan', {
    which,
    finishReason,
    usage: e.usage,
    message: typeof e.message === 'string' ? e.message : String(err),
    // Recortado: esto va a un registro, no a un archivo. Con el principio y el
    // final se distingue un JSON cortado de una respuesta en prosa, que es la
    // única pregunta que este registro tiene que contestar.
    textHead: text?.slice(0, 400) ?? null,
    textTail: text && text.length > 400 ? text.slice(-200) : null,
  });

  if (finishReason === 'length') {
    return (
      'El plan se cortó por lo largo antes de terminar de escribirse. ' +
      'Prueba con un objetivo más acotado, o divídelo en dos.'
    );
  }
  if (text && text.trim().length > 0) {
    return (
      'No pude convertir esto en un plan: el modelo contestó con una explicación ' +
      'en vez de con tareas. Suele pasar cuando al objetivo le falta un dato para ' +
      'poder empezar. Reescríbelo diciendo con qué contamos.'
    );
  }
  return 'No pude armar un plan para este objetivo. Vuelve a intentarlo, o reescríbelo más concreto.';
}
