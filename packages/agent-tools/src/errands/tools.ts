import { z } from 'zod';
import { registerTool } from '../index';
import { ERRAND_BOUNDARY_NOTICE } from './boundary';
import { MAX_LIVE_ERRANDS } from './budget';
import { ERRAND_KIND_SPECS, MONITOR_CADENCES } from './kinds';
import { ERRAND_KINDS } from './shape';
import { answerFromChat, commissionErrand, listErrandsForChat } from './store';

/**
 * THE THREE TOOLS THAT LET SOMEBODY HAND OVER A JOB WITHOUT LEAVING THE CHAT.
 *
 * ===========================================================================
 * WHY THE WORDING OF A DESCRIPTION IS THE FEATURE
 * ===========================================================================
 * Tool selection here is SEMANTIC, not a list (packages/agent-tools/src/
 * tool-selection). Each turn the person's sentence is embedded and compared
 * against `toolEmbedText(tool)` — which is `family action (id): description` —
 * and families below the measured floor never reach the model at all. A tool
 * the model never sees is a tool that does not exist, and the model then
 * truthfully says it cannot do the thing it was granted.
 *
 * That failure has already been paid for twice in this codebase. `vehicles`
 * shipped registered, granted, and matched by no hand-written regex, so Cortex
 * answered that it had no access to the RUNT. Then the floor was found to be
 * sitting inside the signal: "mandale un correo a daniela" scored `gmail` at
 * 0.291 against a floor of 0.300, so NO mail family reached the model on a
 * request that says "send an email". The numbers are in rank.ts and they are
 * MEASURED — nothing here touches a threshold. The only lever this module has
 * is what the descriptions say.
 *
 * So these descriptions are written against the sentence somebody actually
 * types, not against the noun we chose in the code. Nobody says "encargo" and
 * nobody says "errand". They say:
 *
 *     «investígame quién maneja carga refrigerada en Buenaventura»
 *     «compárame los tres operadores y hazme un cuadro»
 *     «averíguame qué tarifas están cobrando»
 *     «reúneme todo lo que tengamos de Coltrans»
 *     «avísame si cambia el precio del flete»
 *     «¿en qué va lo que te pedí?»
 *
 * Every one of those phrasings is seeded verbatim below. The family word
 * (`errands`) and the id are folded into the embedded text automatically, so
 * they cost nothing and buy nothing; the Spanish is what has to carry it.
 *
 * ===========================================================================
 * WHY `errands.start` IS NOT IN THE ERRAND TOOLSET
 * ===========================================================================
 * `ERRAND_TOOLS` in ./boundary.ts — the read-only list an errand's own
 * sub-agents are handed — deliberately does not contain any of these three. An
 * errand cannot commission another errand, cannot read the queue and cannot
 * answer its own question. Without that, one ambiguous request could fan out
 * into a tree of autonomous work that nobody authorised and the per-workspace
 * cap could be walked past from inside. The boundary test asserts it.
 *
 * ===========================================================================
 * AND THE LINE STILL HOLDS, HARDER
 * ===========================================================================
 * A chat makes it far easier to ask for something over the line — "consígueme
 * un vuelo" is one sentence. `commissionErrand` in ./store.ts calls
 * `assertProposalOnly` before a row exists, over the same exact-id list the
 * screen uses, so an errand started by talking is exactly as restricted as one
 * started by clicking. Being invokable in natural language does not make
 * anything more permissive, and the descriptions below say so out loud, so the
 * model declines the booking half instead of promising it.
 */

const kindField = z
  .enum(ERRAND_KINDS)
  .describe(
    'research_compare: investigar un tema por fuera y devolver un cuadro comparativo («investígame», «compárame», «averíguame cuál conviene»). ' +
      'gather_sources: reunir lo que hay sobre algo dentro y fuera de la empresa («reúneme todo lo de», «recopílame», «qué tenemos de»). ' +
      'monitor_change: volver a mirar cada tanto y avisar cuando cambie («avísame si sube», «vigila», «estate pendiente de»).',
  );

const requestField = z
  .string()
  .trim()
  .min(10)
  .max(4000)
  .describe(
    "What to go and find out, in the person's own words and as specific as they made it. Include the subject, the place and any constraint they mentioned. Do NOT summarise it down to a noun — the errand reads this to decide whether it needs to ask a clarifying question first.",
  );

const cadenceField = z
  .number()
  .int()
  .optional()
  .describe(
    `Only for monitor_change: minutes between looks. Use one of ${MONITOR_CADENCES.map((c) => c.minutes).join(', ')} (${MONITOR_CADENCES.map((c) => c.label.toLowerCase()).join(', ')}). Defaults to once a day.`,
  );

const startOutput = z.object({
  ok: z.boolean(),
  errandId: z.string().nullable(),
  kind: z.string(),
  state: z.string(),
  message: z.string(),
  /** What the model should tell the person next. Always populated. */
  guidance: z.string(),
});

export const errandsStart = registerTool({
  id: 'errands.start',
  description:
    'Hand a long job over to Cortex so it goes off and does it on its own, over minutes or hours, and comes back with the answer and its sources. This is the tool for «investígame…», «investiga quién…», «averíguame…», «averigua qué…», «compárame estas opciones», «hazme un cuadro comparativo», «búscame proveedores / operadores / competidores y compáralos», «reúneme todo lo que tengamos sobre este cliente», «recopílame la información de…», «vigila esto y avísame cuando cambie», «estate pendiente del precio y me avisas», «monitorea las tarifas». Use it when the answer needs real research across many sources rather than one lookup — the person can close the browser and it keeps going, it asks a clarifying question instead of guessing if the request is ambiguous, and it reports back here. Do NOT use it for something you can answer in this turn: a single search, one page, one figure from Brain Knowledge or one record is faster with the ordinary tools. It only READS: it never buys, books, reserves, signs, orders or sends anything to anybody, so for «resérvame», «cómprame» or «mándale un correo» say plainly that it can find and compare the options but a person has to do the committing part.',
  inputSchema: z.object({
    kind: kindField,
    request: requestField,
    checkIntervalMinutes: cadenceField,
  }),
  outputSchema: startOutput,
  // Deliberately low. An errand is the most expensive single thing the model
  // can start, and five in a minute is not a use case — it is a loop.
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const spec = ERRAND_KIND_SPECS[input.kind];
    const outcome = await commissionErrand(ctx, {
      kind: input.kind,
      request: input.request,
      checkIntervalMinutes: input.checkIntervalMinutes ?? null,
      // This is what lets the question come back HERE. See notify.ts in
      // apps/web/lib/errands: an errand that blocks writes its question into
      // the conversation it was born in.
      conversationId: ctx.conversationId ?? null,
    });

    if (!outcome.ok) {
      return {
        ok: false,
        errandId: null,
        kind: input.kind,
        state: 'refused',
        message: outcome.message,
        guidance:
          outcome.reason === 'too_many_live'
            ? `El máximo son ${MAX_LIVE_ERRANDS} encargos a la vez. Dile a la persona cuáles hay andando (errands.status) y ofrécele detener uno.`
            : 'Explícale el motivo tal cual y no vuelvas a intentarlo en este turno.',
      };
    }

    return {
      ok: true,
      errandId: outcome.errand.id,
      kind: input.kind,
      state: outcome.errand.state,
      message:
        `Listo, quedó encargado: ${spec.label.toLowerCase()}. Arranca en menos de un minuto y ` +
        'trabaja solo; puedes cerrar esto y seguir en otra cosa.',
      guidance:
        'Dile que ya quedó andando y que no tiene que esperar ahí. Si el encargo necesita que le ' +
        'aclaren algo, la pregunta le va a llegar a esta misma conversación. Puede ver el avance ' +
        `en Encargos, o preguntarte «¿en qué va?». ${ERRAND_BOUNDARY_NOTICE}`,
    };
  },
});

const statusOutput = z.object({
  errands: z.array(
    z.object({
      errandId: z.string(),
      kind: z.string(),
      what: z.string(),
      state: z.string(),
      progress: z.string(),
      waitingOnYou: z
        .object({ question: z.string(), why: z.string(), options: z.array(z.string()) })
        .nullable(),
      result: z.string().nullable(),
    }),
  ),
  summary: z.string(),
  guidance: z.string(),
});

export const errandsStatus = registerTool({
  id: 'errands.status',
  description:
    'Check what Cortex is off doing on its own and what it found. This is the tool for «¿en qué va lo que te encargué?», «¿cómo va la investigación?», «¿ya averiguaste lo de los operadores?», «¿ya quedó?», «¿qué te pedí que investigaras?», «pásame el resultado de lo que te encargué», «¿qué estás haciendo?». Also the tool to call whenever a long job might be STUCK WAITING ON THE PERSON: it returns the clarifying question an errand stopped to ask, with the options, so you can put the question to them right here. Returns each job in flight with how far along it is and how much of its budget it has spent, plus anything that finished recently with its answer.',
  inputSchema: z.object({
    includeFinished: z
      .boolean()
      .default(true)
      .describe(
        'Include recently finished jobs and their answers. Leave true unless asked only for what is still running.',
      ),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  outputSchema: statusOutput,
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const rows = await listErrandsForChat(ctx.db, {
      includeFinished: input.includeFinished,
      limit: input.limit,
    });

    const waiting = rows.filter((r) => r.question);
    const running = rows.filter((r) => r.state === 'working' || r.state === 'queued');

    return {
      errands: rows.map((r) => ({
        errandId: r.id,
        kind: r.kindLabel,
        what: r.request,
        state: r.state,
        progress:
          r.state === 'delivered' || r.state === 'failed' || r.state === 'exhausted'
            ? (r.closingNote ?? 'Terminado.')
            : `Vuelta ${Math.max(1, r.legsUsed)} de ${r.legCeiling}, ${r.spentPercent}% del tope de consumo.`,
        waitingOnYou: r.question
          ? { question: r.question.question, why: r.question.why, options: r.question.options }
          : null,
        result: r.deliverable,
      })),
      summary:
        rows.length === 0
          ? 'No hay encargos.'
          : `${running.length} andando, ${waiting.length} esperando respuesta, ${rows.length - running.length - waiting.length} cerrados.`,
      guidance:
        waiting.length > 0
          ? 'Hay al menos un encargo detenido esperando que le aclaren algo. Hazle la pregunta a la persona AHORA, con las opciones tal cual, y cuando conteste usa errands.answer. Mientras no conteste, ese encargo no avanza.'
          : 'Cuéntale en qué va cada uno. Si alguno ya entregó, léele el resultado en vez de mandarlo a otra pantalla.',
    };
  },
});

export const errandsAnswer = registerTool({
  id: 'errands.answer',
  description:
    'Give a long job the clarification it stopped to ask for, so it picks up where it left off. Use this the moment the person answers a question that came from an errand — «que sea marítima», «la primera opción», «sí, incluye los de Cartagena», «hazlo con los tres» — after errands.status showed something waiting on them. Everything the job already found is kept: answering resumes it, it does not start it over. If more than one job is waiting, this refuses rather than guess, and you must ask which one.',
  inputSchema: z.object({
    answer: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe('What the person said, in their own words. Do not reword it into an instruction.'),
    errandId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Which job they are answering. Required only when more than one is waiting; errands.status returns the ids.',
      ),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    errandId: z.string().nullable(),
    message: z.string(),
    guidance: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const outcome = await answerFromChat(ctx.db, {
      errandId: input.errandId ?? null,
      answer: input.answer,
      userId: ctx.userId,
    });

    if (!outcome.ok) {
      return {
        ok: false,
        errandId: null,
        message: outcome.message,
        guidance:
          outcome.reason === 'ambiguous'
            ? 'Usa errands.status, léele las preguntas abiertas y pídele que diga a cuál contesta.'
            : 'Dile el motivo tal cual; no reintentes.',
      };
    }

    return {
      ok: true,
      errandId: outcome.errandId,
      message: `Le pasé tu respuesta a «${outcome.question}». El encargo sigue desde donde iba.`,
      guidance:
        'Confírmale que ya siguió y que no perdió nada de lo que llevaba. Va a volver a esta ' +
        'conversación cuando tenga el resultado o si necesita otra aclaración.',
    };
  },
});
