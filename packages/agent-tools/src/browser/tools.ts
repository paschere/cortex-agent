import { z } from 'zod';
import { registerTool } from '../index';
import { getCheckpoint, isLive, secondsLeft } from './checkpoint';
import { createHttpTransport } from './client';
import { producesDocument } from './download';
import { resumeFlow, runFlow } from './execute';
import { callerSlots } from './slots';
import { getFlowBySlug, listFlows } from './store';
import { consumesDocument } from './uploads';

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
    'Los datos que cambian entre una ejecución y otra, por nombre de variable: {"placa":"ABC123"}. ' +
      'Puedes traerlos de donde sea — de una hoja de Drive, de un documento, del resultado de otra ' +
      'herramienta — y no tienes que arreglarles el formato: el NIT con puntos y guion, la fecha en ' +
      'dd/mm/aaaa y la placa con espacios se normalizan solas al formato que pide el portal. ' +
      'Para una variable de tipo archivo pasa una referencia: "doc:<id del documento>" (el id que ' +
      'devuelve una descarga anterior en result.download.documentId, o el de un archivo del cerebro). ' +
      'Nunca contraseñas: esas van cifradas en la credencial del trámite, y nunca códigos de ' +
      'verificación: esos los pide el trámite en el momento.',
  );

/**
 * How a flow's slots are described to the planner.
 *
 * The type is included and it is not decoration: the model composing «lee el
 * NIT en el Drive y sácame el certificado» has to know that the thing it is
 * looking for is a NIT and not a name, and that the box for it takes a file
 * rather than text. It is the difference between a plan and a guess.
 */
function describeSlots(flow: import('./types').Flow) {
  return callerSlots(flow.variables, flow.steps).map((v) => ({
    name: v.name,
    label: v.label,
    example: v.example,
    type: v.type ?? 'text',
    required: v.required,
  }));
}

export const browserListFlows = registerTool({
  id: 'browser.list_flows',
  description:
    "List the trámites this workspace has taught Cortex to do on other people's portals — sacar un certificado, consultar un estado, descargar un paz y salvo, subir un documento a un portal, radicar una solicitud — with what each one does, which site it runs on (RUNT, SIMIT, DIAN, Cámara de Comercio, a customer's supplier portal), WHAT DATA EACH ONE NEEDS AND OF WHAT KIND (a NIT, a plate, a date, a FILE), whether it brings a file back, whether it puts one in, and whether it consults or submits. Call this FIRST whenever the request means going into an external website: «sácame el certificado de tradición», «consúltame eso en el portal», «descárgame el paz y salvo», «súbele el certificado al portal del cliente», «radica la solicitud». It is also the tool that tells you HOW TO CHAIN TWO OF THEM: a trámite that downloads returns a document id, and a trámite whose slot is of type `file` takes that id, so «baja el certificado en la DIAN y súbelo al portal del cliente» is two calls and not an impossibility. Only trámites proven to reproduce are listed — and when NONE of them covers what was asked, the answer is browser.open_page (a live tab the person watches in the chat), never a refusal.",
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
        variables: z.array(
          z.object({
            name: z.string(),
            label: z.string(),
            example: z.string(),
            type: z.string(),
            required: z.boolean(),
          }),
        ),
        /** Brings a file back and files it in Brain Knowledge. */
        producesFile: z.boolean(),
        /** Puts a file into the site. One of its slots is of type `file`. */
        needsFile: z.boolean(),
        /** Will stop mid-way and ask a person for a code, or for a captcha. */
        asksForAHuman: z.boolean(),
        lastRunAt: z.string().nullable(),
        lastRunStatus: z.string().nullable(),
      }),
    ),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (_input, ctx) => {
    const ready = (await listFlows(ctx.db)).filter((f) => f.status === 'ready');
    // Unattended, the catalogue shows only what may actually be run there.
    // Listing a trámite a leg is not allowed to touch would have the planner
    // build a plan around it and discover the refusal three steps later, having
    // spent a leg on it — and «no puedo» from a tool that was just advertised
    // reads as a bug rather than as a permission.
    const flows = ctx.surface === 'schedule' ? ready.filter((f) => f.errandAllowed) : ready;
    // La rama de schedule es la única sin salida a la pestaña viva, y es a
    // propósito: browser.open_page existe para que LA PERSONA mire en vivo y
    // pueda tomar el volante, y en una rutina desatendida no hay nadie al otro
    // lado de la tarjeta. En las demás superficies, la guidance nunca deja al
    // modelo en «no hay trámite» sin decir cuál es el otro camino.
    const openPageExit =
      ctx.surface === 'schedule'
        ? ''
        : ' Y si NINGUNO de estos trámites cubre lo pedido, no digas que no puedes: abre el sitio con browser.open_page — la persona lo ve en vivo en el chat — y hazlo paso a paso.';
    const emptyGuidance =
      ctx.surface === 'schedule'
        ? ready.length > 0
          ? 'Hay trámites aprendidos, pero ninguno está habilitado para correr sin nadie mirando. Dilo así y sigue con lo que sí puedas hacer; un administrador los habilita desde Trámites.'
          : 'Todavía no hay trámites web aprendidos y probados. Se enseñan en Trámites web, grabando la pestaña una vez.'
        : 'Todavía no hay trámites web aprendidos y probados (se enseñan en Trámites web, grabando la pestaña una vez), pero eso no te deja sin salida: abre el sitio con browser.open_page — una pestaña viva que la persona ve en el chat — y haz la diligencia tú mismo, paso a paso.';
    return {
      flows: flows.map((f) => ({
        slug: f.slug,
        name: f.name,
        description: f.description,
        site: f.host,
        effect: f.effect,
        needsApproval: f.effect === 'write',
        variables: describeSlots(f),
        producesFile: producesDocument(f.steps),
        needsFile: consumesDocument(f.steps),
        asksForAHuman: f.steps.some((s) => s.action === 'pause'),
        lastRunAt: f.lastRunAt,
        lastRunStatus: f.lastRunStatus,
      })),
      guidance:
        flows.length === 0
          ? emptyGuidance
          : `Usa browser.run_flow para los de tipo read y browser.submit_flow para los de tipo write (esos piden aprobación). Para encadenar: corre primero el que trae el archivo, toma el result.download.documentId que devuelve, y pásalo como "doc:<ese id>" en la variable de tipo file del segundo. Si un trámite dice asksForAHuman, en algún punto se va a detener a pedir un código o una verificación; eso no es una falla y se retoma con browser.resume_flow.${openPageExit}`,
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
  /**
   * The trámite is parked mid-way waiting for a person, and this is where to
   * come back to. Null on every other outcome.
   *
   * Handed to the model rather than kept internal because the model is the one
   * holding the conversation in which the person is about to say «me llegó
   * 483920», and it needs something to attach that to.
   */
  pausedAt: z.string().nullable(),
  /** What the person has to supply, verbatim, when `pausedAt` is set. */
  asks: z.string().nullable(),
});

/**
 * Everything a paused run needs to say, assembled once.
 *
 * A pause reaches the model through three different tools (run, submit,
 * resume), and a person who is told three different things about the same
 * captcha concludes there are three problems.
 */
function pausedFields(outcome: {
  checkpoint?: { id: string; ask: string; reason: string; fills: string | null };
}): { pausedAt: string | null; asks: string | null } {
  const cp = outcome.checkpoint;
  if (!cp) return { pausedAt: null, asks: null };
  return { pausedAt: cp.id, asks: cp.ask };
}

export const browserRunFlow = registerTool({
  id: 'browser.run_flow',
  description:
    "Do a learned trámite that only CONSULTS or DOWNLOADS from somebody else's portal — sacar un certificado, descargar un paz y salvo o un extracto, consultar un estado, un radicado o una placa. This is the tool for «sácame el certificado», «consulta eso en el portal», «bájame el documento de la página» once browser.list_flows shows a trámite that matches. Feed its slots from ANYWHERE — a NIT read out of a Drive sheet with gdrive.read_doc, a plate from vehicles.list, a figure another tool just returned — without reformatting them: a NIT with dots and a check digit, a date in dd/mm/aaaa and a plate with a space all arrive at the portal in the shape its box wants. When it downloads something, the file is filed in Brain Knowledge and its id comes back in result.download.documentId, which is exactly what a second trámite's `file` slot takes — that is how «baja el certificado y súbelo al portal del cliente» is done. Replays the saved steps in a real browser with no model in the loop, so it takes seconds and costs nothing. If the portal stops to ask for a code or a captcha the run does not die: it parks, returns `pausedAt`, and you put the question to the person and come back with browser.resume_flow. Refuses any trámite that submits something to the third party; use browser.submit_flow for those.",
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
        pausedAt: null,
        asks: null,
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
        pausedAt: null,
        asks: null,
      };
    }

    // -----------------------------------------------------------------------
    // THE PER-FLOW ADMISSION, APPLIED WHERE THE FLOW IS FINALLY KNOWN.
    //
    // `boundary.ts` says the correct way to let an errand near this tool is to
    // admit flows one by one rather than the family. The allow-list can only
    // name TOOL ids, so the second half of that rule has to be enforced here —
    // the only place that has both the surface and the row.
    //
    // `surface: 'schedule'` is what the whole product means by "nobody is
    // watching": an errand's legs run under it, and so does a routine. A
    // trámite nobody has admitted does not run there, however read-only it
    // looks, because "read-only" is a property of the recording and the
    // recording was made by a person who was not thinking about this.
    // -----------------------------------------------------------------------
    if (ctx.surface === 'schedule' && !flow.errandAllowed) {
      return {
        ok: false,
        flow: flow.slug,
        result: {},
        seconds: 0,
        message:
          `«${flow.name}» no está habilitado para correr solo, sin nadie mirando. Corre bien ` +
          'cuando alguien lo pide en el chat o desde Trámites.',
        guidance:
          'No lo reintentes: es un permiso, no una falla. Dile a la persona que un administrador ' +
          'puede habilitarlo para trabajos desatendidos desde la pantalla de Trámites, y sigue con ' +
          'lo que sí puedas hacer.',
        pausedAt: null,
        asks: null,
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
        ? documentGuidance(outcome.output)
        : failureGuidance(outcome.failureKind, outcome.checkpoint?.id),
      ...pausedFields(outcome),
    };
  },
});

export const browserSubmitFlow = registerTool({
  id: 'browser.submit_flow',
  description:
    "Do a learned trámite that WRITES on somebody else's portal — radicar una solicitud, presentar o declarar algo ante la DIAN, SUBIR UN ARCHIVO a a customer's supplier portal, enviar un formulario, aceptar o pagar. This is the tool for «radica el trámite», «presenta la solicitud en el portal», «súbele el certificado al portal del cliente», «adjunta el RUT y manda el formulario». When the trámite has a slot of type `file`, pass it the id of a document as \"doc:<id>\" — the id a previous browser.run_flow returned in result.download.documentId, or the id of anything already in Brain Knowledge, which is what a file imported from Drive or generated as a report already is. It acts with the company's identity on a system nobody here controls, so it always requires a human approval before it runs, and it will not run at all in an unattended job. For lookups and downloads use browser.run_flow instead.",
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
        pausedAt: null,
        asks: null,
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
        : failureGuidance(outcome.failureKind, outcome.checkpoint?.id),
      ...pausedFields(outcome),
    };
  },
});

export const browserResumeFlow = registerTool({
  id: 'browser.resume_flow',
  description:
    'Give a trámite that stopped mid-way the one thing it was waiting for, so it carries on in the SAME browser session without repeating anything. Use it the moment the person answers a question a trámite asked — «me llegó 483920», «el código es 77341», «ya resolví el captcha», «listo, ya lo desbloqueé» — after browser.run_flow or browser.submit_flow came back with `pausedAt`. This is what makes a portal with two-factor authentication or a captcha doable at all: the session, the cookies and the half-filled form are still open on the other side, and this hands over the code and lets it finish. It expires in minutes, so use it as soon as the person answers; if it has expired, say so plainly and offer to start the trámite again.',
  inputSchema: z.object({
    pausedAt: z
      .string()
      .uuid()
      .describe('El identificador que devolvió el trámite en pausedAt cuando se detuvo.'),
    answer: z
      .string()
      .trim()
      .max(300)
      .default('')
      .describe(
        'Lo que dijo la persona: el código que le llegó, tal cual. Déjalo vacío sólo cuando la pausa era una verificación de «no soy un robot» que alguien resolvió en la pantalla.',
      ),
  }),
  outputSchema: runOutput,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const checkpoint = await getCheckpoint(ctx.db, input.pausedAt);
    if (!checkpoint) {
      return {
        ok: false,
        flow: '',
        result: {},
        seconds: 0,
        message: 'Ese trámite en pausa ya no existe.',
        guidance: 'Ofrécele volver a arrancar el trámite desde el principio.',
        pausedAt: null,
        asks: null,
      };
    }
    if (!isLive(checkpoint)) {
      return {
        ok: false,
        flow: '',
        result: {},
        seconds: 0,
        message:
          'Se venció la sesión: el navegador sólo puede sostener la pestaña abierta unos minutos ' +
          'y ya la cerró.',
        guidance:
          'Dile eso mismo sin adornarlo y ofrécele arrancar el trámite otra vez; son unos segundos ' +
          'y esta vez conviene que esté pendiente del código.',
        pausedAt: null,
        asks: null,
      };
    }

    const outcome = await resumeFlow({
      db: ctx.db,
      organizationId: ctx.organizationId,
      actor: { id: ctx.userId, role: 'member' },
      checkpointId: input.pausedAt,
      answer: input.answer ?? '',
      transport: createHttpTransport(ctx.logger, ctx.signal),
      logger: ctx.logger,
    });

    return {
      ok: outcome.ok,
      flow: '',
      result: outcome.output,
      seconds: Math.round(outcome.durationMs / 100) / 10,
      message: outcome.message,
      guidance: outcome.ok
        ? documentGuidance(outcome.output)
        : `${failureGuidance(outcome.failureKind, outcome.checkpoint?.id)} Quedaban ${secondsLeft(checkpoint)} segundos de sesión cuando lo intenté.`,
      ...pausedFields(outcome),
    };
  },
});

/**
 * What to say when the errand came back with a file.
 *
 * The bytes are deliberately not here -- see browser/download.ts. What the
 * model gets is the name and the id of a document that is, by the time it reads
 * this, being parsed and indexed like any other. So the useful thing to tell a
 * person is not "here is a blob" but "the certificate is in, ask me about it".
 */
function documentGuidance(output: Record<string, unknown>): string {
  const download = output.download as
    | { filename?: string; documentId?: string; refused?: string }
    | undefined;
  if (download?.refused) {
    return `Dile a la persona qué se obtuvo, y que el archivo no se pudo traer: ${download.refused}. El trámite en sí sí funcionó.`;
  }
  if (download?.documentId) {
    return (
      `Dile a la persona qué se obtuvo y que el archivo «${download.filename}» quedó guardado en su ` +
      'espacio personal de Brain Knowledge, listo para consultarlo o citarlo. No pegues el contenido ' +
      `del archivo. Si lo que sigue es llevarlo a otro portal, ese archivo se pasa como "doc:${download.documentId}" ` +
      'en la variable de tipo file del trámite que lo sube.'
    );
  }
  return 'Dile a la persona qué se obtuvo. Si hay una descarga, está en result.download.';
}

function failureGuidance(kind: string | undefined, pausedAt?: string): string {
  // A parked trámite is answered before it is explained. This branch is first
  // because `needs-human` covers both "somebody has to do this bit" and "this
  // site refuses robots", and only one of them has a way forward.
  if (pausedAt) {
    return (
      'El trámite NO falló: se detuvo a pedir algo que sólo una persona tiene en este momento, y la ' +
      'sesión sigue abierta con todo lo que ya llevaba hecho. Pídeselo AHORA, con las palabras que ' +
      'trae `asks`, y en cuanto conteste llama a browser.resume_flow con ese pausedAt y lo que dijo. ' +
      'No vuelvas a correr el trámite desde cero: eso pierde lo andado y va a parar en el mismo sitio. ' +
      'Dura pocos minutos, así que no lo dejes para después del siguiente tema.'
    );
  }
  if (kind === 'needs-login') {
    return 'No falló: falta la cuenta con la que se entra a ese portal. Dile a la persona exactamente eso y que se vincula desde Trámites; no lo reintentes, la respuesta va a ser la misma.';
  }
  if (kind === 'legitimate') {
    return 'El portal respondió y rechazó el trámite. Repítele a la persona lo que dijo el portal; no vale la pena reintentar sin cambiar el dato.';
  }
  if (kind === 'transient') {
    return 'Fue un problema del sitio, no del trámite. Se puede reintentar en unos minutos.';
  }
  if (kind === 'needs-human') {
    return 'El portal se detuvo a comprobar que no es un robot. El trámite está bien; dile a la persona que ese sitio pide una verificación y que hace falta que alguien la resuelva. No lo reintentes solo: va a volver a pasar.';
  }
  if (kind === 'site-changed') {
    return 'El portal cambió. Si Cortex no logró repararlo solo, alguien tiene que volver a enseñar ese trámite desde Trámites web.';
  }
  return 'Explícale a la persona qué pasó sin adornarlo.';
}
