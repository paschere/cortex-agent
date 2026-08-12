import { z } from 'zod';
import { registerTool } from '../index';
import { createHttpTransport } from './client';
import { runFlow } from './execute';
import { getFlowBySlug, listFlows } from './store';

/**
 * The three tools that let somebody say "sácame el certificado de tradición de
 * esta matrícula" in the chat.
 *
 * ---------------------------------------------------------------------------
 * WHY RUNNING AND SUBMITTING ARE TWO TOOLS AND NOT ONE WITH A FLAG
 * ---------------------------------------------------------------------------
 * Whether a tool needs approval is a static property of the tool -- `runTool`
 * reads `requiresConfirmation` off the definition before it has looked at the
 * input, and that ordering is deliberate: the gate must not depend on parsing
 * an argument correctly. So a single `browser.run_flow` that consulted the
 * flow's `effect` at runtime could not be gated by the mechanism that already
 * exists, and would have to grow its own.
 *
 * Two tools instead. `browser.run_flow` executes CONSULTAS and refuses
 * anything that writes. `browser.submit_flow` executes the ones that write and
 * carries `requiresConfirmation: true`, so it goes through the same approval
 * card as sending an email -- and, like that card, it is approved by a person
 * who can read what is about to happen before it happens.
 *
 * The refusal in `run_flow` is the interesting half: without it the model would
 * simply reach for the read tool to do a write, and the boundary would be one
 * hallucination deep.
 *
 * ---------------------------------------------------------------------------
 * DRAFTS ARE INVISIBLE HERE
 * ---------------------------------------------------------------------------
 * Only `ready` flows are listed or runnable. A flow read out of a recording and
 * never reproduced is a guess, and the chat is exactly where a guess would be
 * treated as an answer. Somebody can still run a draft by hand, from the screen,
 * where the word PROPUESTO is next to the button.
 */

const flowRef = z
  .string()
  .min(1)
  .max(80)
  .describe('El identificador corto del trámite, tal como lo devuelve browser.list_flows');

const inputsField = z
  .record(z.string().max(300))
  .default({})
  .describe(
    'Los datos que cambian entre una ejecución y otra, por nombre de variable: {"placa":"ABC123"}. Nunca contraseñas: esas van cifradas en la credencial del trámite.',
  );

export const browserListFlows = registerTool({
  id: 'browser.list_flows',
  description:
    'List the web procedures ("trámites") this workspace has taught Cortex to perform on third-party portals — what each one does, which site it runs on, what data it needs, and whether it consults or submits. Call this first when the user asks for something that would mean going to an external website. Only flows that have been proven to reproduce are listed.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    flows: z.array(
      z.object({
        slug: z.string(),
        name: z.string(),
        description: z.string(),
        site: z.string(),
        effect: z.enum(['read', 'write']),
        needsApproval: z.boolean(),
        variables: z.array(z.object({ name: z.string(), label: z.string(), example: z.string() })),
        lastRunAt: z.string().nullable(),
        lastRunStatus: z.string().nullable(),
      }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (_input, ctx) => {
    const flows = (await listFlows(ctx.db)).filter((f) => f.status === 'ready');
    return {
      flows: flows.map((f) => ({
        slug: f.slug,
        name: f.name,
        description: f.description,
        site: f.host,
        effect: f.effect,
        needsApproval: f.effect === 'write',
        variables: f.variables.map((v) => ({ name: v.name, label: v.label, example: v.example })),
        lastRunAt: f.lastRunAt,
        lastRunStatus: f.lastRunStatus,
      })),
      guidance:
        flows.length === 0
          ? 'Todavía no hay trámites web aprendidos y probados. Se enseñan en Trámites web, grabando la pestaña una vez.'
          : 'Usa browser.run_flow para los de tipo read y browser.submit_flow para los de tipo write (esos piden aprobación).',
    };
  },
});

const runOutput = z.object({
  ok: z.boolean(),
  flow: z.string(),
  result: z.record(z.unknown()),
  /** Seconds, so the model can say how long it took without doing arithmetic. */
  seconds: z.number(),
  message: z.string(),
  guidance: z.string(),
});

export const browserRunFlow = registerTool({
  id: 'browser.run_flow',
  description:
    'Run a learned web procedure that only CONSULTS or DOWNLOADS — a certificate, a status lookup, a statement. Executes the saved steps in a real browser with no model in the loop, so it takes seconds and costs nothing. Refuses any flow that submits something to the third party; use browser.submit_flow for those.',
  inputSchema: z.object({ flow: flowRef, inputs: inputsField }),
  outputSchema: runOutput,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const flow = await getFlowBySlug(ctx.db, input.flow);
    if (!flow || flow.status !== 'ready') {
      return {
        ok: false,
        flow: input.flow,
        result: {},
        seconds: 0,
        message: `No tengo un trámite probado que se llame «${input.flow}».`,
        guidance: 'Llama a browser.list_flows para ver cuáles hay.',
      };
    }
    if (flow.effect === 'write') {
      return {
        ok: false,
        flow: flow.slug,
        result: {},
        seconds: 0,
        message: `«${flow.name}» no es una consulta: radica o envía algo en ${flow.host}.`,
        guidance:
          'Usa browser.submit_flow, que pide aprobación de una persona antes de escribir en un sitio ajeno.',
      };
    }

    const outcome = await runFlow({
      db: ctx.db,
      organizationId: ctx.organizationId,
      actor: { id: ctx.userId, role: 'member' },
      flow,
      inputs: input.inputs ?? {},
      transport: createHttpTransport(ctx.logger, ctx.signal),
      logger: ctx.logger,
      trigger: 'chat',
    });

    return {
      ok: outcome.ok,
      flow: flow.slug,
      result: outcome.output,
      seconds: Math.round(outcome.durationMs / 100) / 10,
      message: outcome.message,
      guidance: outcome.ok
        ? 'Dile a la persona qué se obtuvo. Si hay una descarga, está en result.download.'
        : failureGuidance(outcome.failureKind),
    };
  },
});

export const browserSubmitFlow = registerTool({
  id: 'browser.submit_flow',
  description:
    "Run a learned web procedure that WRITES on a third-party site — files a return, submits a form, accepts or pays something. Acts with the company's identity on a system nobody here controls, so it always requires a human approval before it runs. For lookups and downloads use browser.run_flow instead.",
  inputSchema: z.object({ flow: flowRef, inputs: inputsField }),
  outputSchema: runOutput,
  // The gate. Read before the input is even looked at -- see the header note.
  requiresConfirmation: true,
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const flow = await getFlowBySlug(ctx.db, input.flow);
    if (!flow || flow.status !== 'ready') {
      return {
        ok: false,
        flow: input.flow,
        result: {},
        seconds: 0,
        message: `No tengo un trámite probado que se llame «${input.flow}».`,
        guidance: 'Llama a browser.list_flows para ver cuáles hay.',
      };
    }

    const outcome = await runFlow({
      db: ctx.db,
      organizationId: ctx.organizationId,
      actor: { id: ctx.userId, role: 'member' },
      flow,
      inputs: input.inputs ?? {},
      transport: createHttpTransport(ctx.logger, ctx.signal),
      logger: ctx.logger,
      trigger: 'chat',
    });

    return {
      ok: outcome.ok,
      flow: flow.slug,
      result: outcome.output,
      seconds: Math.round(outcome.durationMs / 100) / 10,
      message: outcome.message,
      guidance: outcome.ok
        ? `Quedó radicado en ${flow.host}. Dile a la persona exactamente qué se envió y con qué número, si el portal dio uno.`
        : failureGuidance(outcome.failureKind),
    };
  },
});

function failureGuidance(kind: string | undefined): string {
  if (kind === 'legitimate') {
    return 'El portal respondió y rechazó el trámite. Repítele a la persona lo que dijo el portal; no vale la pena reintentar sin cambiar el dato.';
  }
  if (kind === 'transient') {
    return 'Fue un problema del sitio, no del trámite. Se puede reintentar en unos minutos.';
  }
  if (kind === 'site-changed') {
    return 'El portal cambió. Si Cortex no logró repararlo solo, alguien tiene que volver a enseñar ese trámite desde Trámites web.';
  }
  return 'Explícale a la persona qué pasó sin adornarlo.';
}
