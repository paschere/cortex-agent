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
    'List the trámites this workspace has taught Cortex to do on other people\'s portals — sacar un certificado, consultar un estado, descargar un paz y salvo, radicar una solicitud — with what each one does, which site it runs on (RUNT, SIMIT, DIAN, Cámara de Comercio, a customer\'s supplier portal), what data it needs, and whether it consults or submits. Call this FIRST whenever the request means going into an external website: «sácame el certificado de tradición», «consúltame eso en el portal», «descárgame el paz y salvo», «radica la solicitud». Only trámites proven to reproduce are listed.',
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
    'Do a learned trámite that only CONSULTS or DOWNLOADS from somebody else\'s portal — sacar un certificado, descargar un paz y salvo o un extracto, consultar un estado, un radicado o una placa. This is the tool for «sácame el certificado», «consulta eso en el portal», «bájame el documento de la página» once browser.list_flows shows a trámite that matches. Replays the saved steps in a real browser with no model in the loop, so it takes seconds and costs nothing. Refuses any trámite that submits something to the third party; use browser.submit_flow for those.',
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
    "Do a learned trámite that WRITES on somebody else's portal — radicar una solicitud, presentar o declarar algo ante la DIAN, enviar un formulario, aceptar o pagar. This is the tool for «radica el trámite», «presenta la solicitud en el portal», «manda el formulario». It acts with the company's identity on a system nobody here controls, so it always requires a human approval before it runs. For lookups and downloads use browser.run_flow instead.",
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
