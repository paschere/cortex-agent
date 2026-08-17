import type { Logger } from '@cortex/core';
import { generateText } from 'ai';
import { z } from 'zod';
import { utilityModel } from '../model';
import { addSpend, spendOf } from './cost';
import { enforceSecrets, pauseForOneTimeCodes } from './redact';
import { auditSlots } from './slots';
import { type Step, type Variable, stepSchema, variableSchema } from './types';
import { EMPTY_SPEND, type ModelSpend } from './types';

/**
 * Reading an errand off a screen recording.
 *
 * ---------------------------------------------------------------------------
 * WHAT ARRIVES HERE, AND WHAT DOES NOT
 * ---------------------------------------------------------------------------
 * Key frames, in a request body, once. The person's browser samples the shared
 * tab locally, keeps only the frames where something visibly changed, and posts
 * them. There is no video file: the tab capture never leaves the browser as a
 * video, no frame is written to disk, to object storage or to Postgres, and
 * when this function returns the images are garbage. What survives the whole
 * teaching session is a step list, a frame count and a dollar figure.
 *
 * That is a stronger guarantee than a retention policy, and it is available
 * only because extraction is one synchronous call. A queue would need somewhere
 * to put the frames, and "somewhere" is a copy of somebody's screen that has to
 * be defended, audited and eventually deleted by a job that will one day not
 * run. The cheapest way not to leak a recording is not to have one.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS EXTRACTED
 * ---------------------------------------------------------------------------
 * Not pixels and not coordinates: the sequence of ACTIONS, each with the
 * SEMANTIC LOCATORS a picture can actually support -- the words on the button,
 * the label beside the field, the role of the control, the heading on the page.
 * Those are what `getByRole`, `getByLabel` and `getByText` need, and they are
 * more durable than the CSS path a DOM recorder would have captured.
 *
 * Plus the thing that turns a recording into a procedure: WHICH TYPED VALUES
 * VARY. The model is asked to mark a plate, a NIT, a date or a document number
 * as a variable and everything else as fixed, and its guesses are shown to the
 * person for correction before anything is saved.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PRODUCES IS A HYPOTHESIS
 * ---------------------------------------------------------------------------
 * Nothing here is trusted. The caller creates the flow as `draft`, replays it
 * against the real site immediately, and only a clean end-to-end run makes it
 * `ready`. See `apps/web/app/api/browser/flows/route.ts`.
 */

/**
 * One sampled frame. `atMs` is milliseconds since the recording started.
 *
 * `phase` is set only when the recorder sampled in PAIRS: `antes` is the frame
 * from just before something was pressed -- with the pointer resting on it --
 * and `despues` is the page that resulted. A lone `despues` frame says what
 * happened; it does not say what was pressed to make it happen, and on a page
 * where the thing that was pressed is now gone that difference is the whole
 * step. Frames with no `phase` are read as plain "after" frames, which is what
 * they were before pairing existed.
 */
export interface Frame {
  base64: string;
  mimeType: string;
  atMs: number;
  phase?: 'antes' | 'despues';
}

/**
 * Caps, and they are cost caps as much as anything.
 *
 * A frame at 1280px is roughly 1,600 input tokens, so twenty of them is about
 * 32k tokens -- ten cents of reading, once, to learn an errand that then runs
 * for free forever. Forty frames would buy very little more: the frames that
 * matter are the ones where the page changed, and the sampler already keeps
 * only those.
 */
export const MAX_FRAMES = 20;
export const MAX_FRAME_BYTES = 400 * 1024;

const proposalSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(600).default(''),
  startUrl: z.string().min(1).max(2000),
  effect: z.enum(['read', 'write']),
  variables: z.array(variableSchema).max(12).default([]),
  steps: z.array(stepSchema).min(1).max(60),
  notes: z.array(z.string().max(300)).max(10).default([]),
});

export type Proposal = z.infer<typeof proposalSchema>;

export interface ExtractionResult {
  proposal: Proposal;
  spend: ModelSpend;
  /** Things a person should look at before trusting the proposal. */
  warnings: string[];
}

const SYSTEM = `Eres un analista que mira la grabación de una persona haciendo un trámite en un portal web y escribe los pasos para que un robot lo repita.

CÓMO SE IDENTIFICAN LOS ELEMENTOS
Un robot con Playwright encuentra las cosas por lo que SE VE y por lo que el elemento ES, no por su posición:
- role: el tipo de control más su nombre visible. Ej: {"kind":"role","value":"button","name":"Consultar"}
- label: el rótulo impreso al lado de un campo. Ej: {"kind":"label","value":"Número de placa"}
- placeholder: el texto gris dentro de un campo vacío
- text: las palabras de un enlace o un botón
Da SIEMPRE varias formas por paso, de la más confiable a la menos, en "targets". Nunca inventes selectores CSS ni identificadores internos: en un video no se ven, y si te los imaginas el trámite se rompe.

QUÉ CAMBIA Y QUÉ NO — esto es lo más importante
Un trámite grabado que sólo sepa repetir exactamente lo mismo no sirve para nada. Por cada dato que la persona escribió, decide si:
- es un DATO QUE CAMBIA cada vez (una placa, un NIT, una cédula, un mes, un número de radicado, un rango de fechas). Declaralo en "variables" y en el paso pon {"kind":"template","text":"{{placa}}"}.
- es FIJO (una opción de un desplegable, un tipo de consulta que siempre es el mismo). Pon {"kind":"literal","text":"..."}.
En la duda, márcalo como variable: una variable de más se corrige en un segundo; una constante equivocada obliga a volver a enseñar el trámite.

CONTRASEÑAS
Si ves un campo que se muestra con puntos o asteriscos, o cuyo rótulo habla de contraseña, clave, usuario, PIN o token: NO transcribas lo que se escribió. Pon {"kind":"secret","field":"clave"} con un nombre corto para el campo. Nunca escribas los caracteres, ni siquiera parcialmente, ni siquiera si se alcanzan a leer.

CÓDIGOS DE UN SOLO USO — no son contraseñas
Un campo cuyo rótulo hable de código de verificación, código de seguridad, OTP, doble factor o «el código que te llegó al celular» NO es una credencial: cambia cada vez y no se puede guardar. Trátalo como un DATO QUE CAMBIA — {"kind":"template","text":"{{codigo_de_verificacion}}"} — y declara la variable con "type":"code". Cortex se encarga de parar el trámite ahí y pedírselo a una persona en el momento. Tampoco transcribas los dígitos que se vean.

ARCHIVOS QUE SE ADJUNTAN
Si la persona sube un archivo (un botón «Examinar», «Adjuntar», «Seleccionar archivo», o un recuadro donde se arrastra), el paso es {"action":"upload"} y su valor es {"kind":"file","from":"{{documento}}"} con un nombre que describa QUÉ documento es — {{certificado}}, {{rut}}, {{factura}} — y la variable declarada con "type":"file". Nunca pongas el nombre del archivo que se ve en la grabación: ése era el de ese día, y el trámite existe para repetirse con otro.

DE QUÉ ES CADA DATO
Toda variable lleva "type", y no es decoración: es lo que convierte lo que salga de otra parte en lo que la casilla acepta. Usa "nit" para un NIT (se manda sin el dígito de verificación), "plate" para una placa, "date" para una fecha, "money" para un monto, "number" para un número, "email" para un correo, "code" para un código de un solo uso, "file" para un archivo, y "text" para todo lo demás.

LECTURA Y ESCRITURA
"effect" es "read" si el trámite sólo consulta o descarga algo, y "write" si envía, radica, paga, acepta o modifica algo en el sistema del tercero. Ante la duda, "write".

REFERENCIAS DE PÁGINA
En cada paso, "landmarks" son 2 o 3 textos fijos de la página en ese momento (un encabezado, el nombre del portal). Sirven para saber después si seguimos en la página correcta. No son para encontrar nada.

RESPONDE SÓLO CON JSON, sin explicación alrededor.`;

/**
 * How the frames are introduced, which changes when they arrive in pairs.
 *
 * A paired recording is not the same evidence as a single-sampled one and must
 * not be described as though it were: the model has to know that two adjacent
 * pictures are the two sides of ONE action rather than two consecutive actions,
 * or it will read every pair as a step that did not happen.
 */
function framingNote(frames: Frame[]): string {
  const paired = frames.some((f) => f.phase === 'antes');
  if (!paired) {
    return `Aquí van ${frames.length} cuadros de la grabación, en orden cronológico. Entre un cuadro y el siguiente la persona hizo algo: dedúcelo del cambio en pantalla.`;
  }
  return `Aquí van ${frames.length} cuadros de la grabación, en orden cronológico y ROTULADOS. Cada cuadro viene precedido de una línea que dice si es un ANTES o un DESPUÉS.

Un cuadro ANTES es el instante justo antes de que la persona pulsara algo, y el puntero del mouse está encima de lo que va a pulsar: eso es lo que te dice CUÁL elemento se usó, incluso cuando en el cuadro siguiente ese elemento ya no existe (un menú que se cerró, una página que cambió). El DESPUÉS que le sigue es el resultado de esa misma acción, no una acción distinta.

Un par ANTES+DESPUÉS es UN SOLO PASO. No lo cuentes dos veces. Un cuadro DESPUÉS suelto, sin su ANTES, también es un paso.`;
}

function userPrompt(hint: string, frames: Frame[]): string {
  return `${framingNote(frames)}

${hint ? `La persona describió el trámite así: "${hint}"\n\n` : ''}Devuelve este JSON:
{
  "name": "nombre corto del trámite, en español",
  "description": "una frase de qué consigue",
  "startUrl": "la dirección donde empieza. OJO: la grabación es sólo el contenido de la pestaña y NO incluye la barra de direcciones, así que casi nunca la puedes leer. Pon la que se deduzca del portal y dilo en notes; una persona la confirma antes de guardar",
  "effect": "read" | "write",
  "variables": [{"name":"placa","label":"Placa del vehículo","example":"ABC123","required":true}],
  "steps": [
    {
      "action": "goto|click|fill|select|check|press|wait_for|extract|download",
      "label": "qué hace este paso, en español",
      "targets": [{"kind":"role|label|placeholder|text","value":"...","name":"..."}],
      "value": {"kind":"literal|template|secret","text":"...","field":"..."},
      "url": "sólo para goto",
      "expect": "un texto que debe aparecer cuando el paso funcionó",
      "landmarks": ["...", "..."],
      "extractAs": "sólo para extract: el nombre del dato que se lee"
    }
  ],
  "notes": ["cualquier cosa que no hayas podido deducir con seguridad"]
}

No inventes URLs dentro de los pasos: sólo el PRIMER paso puede ser un "goto", y Cortex lo apunta a la dirección que confirme la persona. Un "goto" a media grabación, con una URL que no se ve en ninguna parte, rompe el trámite.

Si en la grabación hay un paso que no se puede reproducir a ciegas — un menú que sólo aparece al pasar el mouse, un archivo que se sube desde el computador, un código que llega por celular — inclúyelo igual con la acción que más se acerque y DILO en "notes".`;
}

function parseJson(raw: string): unknown {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Consistency checks the model cannot be relied on to do for itself, run before
 * a person ever sees the proposal.
 */
function audit(proposal: Proposal): string[] {
  const warnings: string[] = [];

  for (const step of proposal.steps) {
    // `pause` acts on nobody: it stops and asks a person. Demanding a locator
    // for it would flag every trámite with a code as broken.
    if (
      step.action !== 'goto' &&
      step.action !== 'wait_for' &&
      step.action !== 'pause' &&
      step.targets.length === 0
    ) {
      warnings.push(`El paso «${step.label}» no tiene ninguna forma de encontrar su elemento.`);
    }
    if (step.targets.length === 1 && step.action !== 'goto' && step.action !== 'pause') {
      warnings.push(
        `«${step.label}» tiene una sola forma de encontrarse; si el portal cambia, ese paso se rompe primero.`,
      );
    }
  }

  // A URL cannot be photographed: a shared tab is the page, not the browser
  // around it. The first `goto` is aligned to the address the person confirms on
  // the review screen (`alignFirstGoto`); any other one is the model writing
  // down something it never saw.
  for (const [index, step] of proposal.steps.entries()) {
    if (step.action === 'goto' && index > 0) {
      warnings.push(
        `El paso «${step.label}» navega a una dirección que en la grabación no se ve (la barra de direcciones no se graba). Revísala o cámbialo por el clic que llevaba a esa página.`,
      );
    }
  }

  // Los huecos contra lo declarado, en la misma función que lo comprueba en
  // todos los demás sitios: `auditSlots` sabe de plantillas, de referencias de
  // archivo y de los slots que llena una parada, y este archivo tenía una copia
  // que sólo sabía de la primera.
  const slots = auditSlots(proposal.variables, proposal.steps);
  for (const name of slots.undeclared) {
    warnings.push(`El paso usa {{${name}}} pero esa variable no está declarada.`);
  }
  for (const name of slots.unused) {
    warnings.push(`La variable «${name}» está declarada pero ningún paso la usa.`);
  }
  if (proposal.variables.length === 0) {
    warnings.push(
      'No encontré ningún dato que cambie entre una ejecución y otra, así que este trámite sólo sabe repetirse igual. Revisa si algo de lo que se escribió debería ser variable.',
    );
  }
  return warnings;
}

/**
 * The address bar is not in the picture, so the first `goto` gets the address
 * the person confirms instead of the one the model imagined.
 *
 * A tab capture is the page and nothing around it: no URL bar, no tabs, no
 * back button. Whatever the model wrote into `startUrl` is a guess from a
 * portal's own branding, and the review screen exists partly to correct it. The
 * first step is almost always a `goto` to that same guess, so aligning the two
 * means the person's correction lands on BOTH -- otherwise they fix the address
 * at the top of the screen and the flow still navigates to the invented one.
 */
export function alignFirstGoto(proposal: Proposal): Proposal {
  const first = proposal.steps[0];
  if (!first || first.action !== 'goto') return proposal;
  return {
    ...proposal,
    steps: [{ ...first, url: proposal.startUrl }, ...proposal.steps.slice(1)],
  };
}

/**
 * Pass one of two: how many steps there are and of what kind, before anything
 * is asked about any of them.
 *
 * ---------------------------------------------------------------------------
 * THE ARGUMENT FOR IT, AND WHY IT IS STILL OFF
 * ---------------------------------------------------------------------------
 * The argument is that segmentation is upstream of everything: a step the model
 * never noticed cannot have its locators fixed later, and two steps merged into
 * one produce a flow that is wrong in a way no verification pass can repair.
 * Doing that job alone, with nothing else competing for attention in the same
 * completion, ought to be worth something.
 *
 * The cost is not small. The frames are the expensive part of the request and
 * this sends them TWICE -- double the input tokens and the best part of double
 * the latency, on a call that already takes most of a minute while a person
 * waits. So it has to earn that, and it is measured rather than assumed:
 * `pnpm browser:cases --two-pass` against the same three errands as everything
 * else. Read the numbers in docs/operations/browser.md before turning it on.
 */
async function segmentRecording(
  frames: Frame[],
  hint: string,
): Promise<{ outline: string; spend: ModelSpend }> {
  const result = await generateText({
    model: utilityModel(),
    system:
      'Miras la grabación de una persona haciendo un trámite en un portal web y dices ÚNICAMENTE en cuántos pasos se divide y de qué tipo es cada uno. No describas cómo encontrar los elementos: eso es de otro paso del proceso.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${framingNote(frames)}

${hint ? `La persona describió el trámite así: "${hint}"\n\n` : ''}Devuelve SÓLO una lista numerada, un renglón por paso, con esta forma:
1. [accion] descripción corta en español

donde accion es una de: goto, click, fill, select, check, uncheck, press, wait_for, extract, download.

Reglas:
- Escribir en un campo y pulsar el botón que envía el formulario son DOS pasos.
- Llenar tres campos son TRES pasos, uno por campo.
- Elegir en un desplegable es "select", no "click".
- Leer un dato de la pantalla final es "extract", y va al final.
- No inventes pasos que no se ven; no fusiones dos que sí.`,
          },
          ...frameContent(frames),
        ],
      },
    ],
    maxTokens: 1200,
  });
  return { outline: result.text.trim().slice(0, 4000), spend: spendOf(result.usage) };
}

/**
 * The frames, as message content, each one announced when they came in pairs.
 *
 * Interleaving a line of text before every image is what makes `phase` mean
 * anything: the images themselves carry no order and no rôle, and a model told
 * "some of these are befores" without being told WHICH would do worse than one
 * never told at all.
 */
function frameContent(
  frames: Frame[],
): ({ type: 'text'; text: string } | { type: 'image'; image: string; mimeType: string })[] {
  const paired = frames.some((f) => f.phase === 'antes');
  const content: ReturnType<typeof frameContent> = [];
  for (const [index, frame] of frames.entries()) {
    if (paired) {
      content.push({
        type: 'text',
        text: `Cuadro ${index + 1} — ${frame.phase === 'antes' ? 'ANTES (el puntero está sobre lo que se va a pulsar)' : 'DESPUÉS'}`,
      });
    }
    content.push({ type: 'image', image: frame.base64, mimeType: frame.mimeType });
  }
  return content;
}

export async function extractFlowFromRecording(input: {
  frames: Frame[];
  /** What the person said they were doing. Optional and only a hint. */
  hint?: string;
  logger: Logger;
  /**
   * Segment first, then read each step in detail. Measured in
   * `scripts/browser-cases` and OFF by default -- see the note on
   * `segmentRecording`.
   */
  twoPass?: boolean;
}): Promise<{ ok: true; result: ExtractionResult } | { ok: false; reason: string }> {
  const frames = input.frames.slice(0, MAX_FRAMES);
  if (frames.length === 0) {
    return { ok: false, reason: 'No llegó ningún cuadro de la grabación.' };
  }
  if (frames.some((f) => f.base64.length > MAX_FRAME_BYTES * 1.4)) {
    return { ok: false, reason: 'Alguno de los cuadros es demasiado grande.' };
  }

  let spend = EMPTY_SPEND;
  let text: string;
  try {
    let outline = '';
    if (input.twoPass) {
      const segmented = await segmentRecording(frames, input.hint ?? '');
      spend = addSpend(spend, segmented.spend);
      outline = segmented.outline;
    }
    const result = await generateText({
      model: utilityModel(),
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt(input.hint ?? '', frames) },
            ...(outline
              ? [
                  {
                    type: 'text' as const,
                    text: `\nYa segmentamos la grabación en estos pasos. Respeta el número y el orden; tu trabajo ahora es el detalle de cada uno:\n${outline}`,
                  },
                ]
              : []),
            ...frameContent(frames),
          ],
        },
      ],
      maxTokens: 8000,
    });
    spend = addSpend(spend, spendOf(result.usage));
    text = result.text;
  } catch (err) {
    // The frames are in the request that just failed and are not retried from
    // anywhere: there is nowhere they are being held.
    input.logger.error({ err: (err as Error).message }, 'browser flow extraction failed');
    return { ok: false, reason: 'No pude leer la grabación. Vuelve a intentarlo.' };
  }

  const parsed = proposalSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'Leí la grabación pero no logré sacar una secuencia de pasos coherente.',
    };
  }

  // The last line of defence on credentials, applied before the proposal is
  // returned to the browser, let alone stored. See redact.ts.
  const guarded = enforceSecrets(parsed.data.steps as Step[]);
  // A code the bank sends is not a credential and cannot be stored, so the step
  // that types it gets the pause that asks for it — inserted here rather than
  // left as a note on the review screen, because a person who has just recorded
  // a bank login has no reason to know what a `pause` step is. See redact.ts.
  const paused = pauseForOneTimeCodes(guarded.steps);
  const proposal: Proposal = alignFirstGoto({
    ...parsed.data,
    steps: paused.steps,
    // The slot the pause fills has to be declared, or the flow types the
    // literal `{{codigo}}` into the portal. `type: 'code'` is what keeps it out
    // of every row this run writes.
    variables: withCodeSlots(parsed.data.variables as Variable[], paused.added, paused.steps),
  });

  const warnings = audit(proposal);
  if (paused.added.length > 0) {
    warnings.push(
      'Este trámite pide un código de verificación. Lo dejé como una parada: cuando lo corras, Cortex se detiene ahí y te lo pregunta —en el chat o en esta pantalla— y sigue solo apenas contestes. Ese código no se guarda en ninguna parte, porque sirve una sola vez.',
    );
  }
  if (guarded.redacted > 0) {
    warnings.push(
      `Detecté ${guarded.redacted} campo(s) de credencial en la grabación. No guardé lo que se tecleó: hay que vincular una credencial cifrada para que el trámite pueda ejecutarse.`,
    );
  } else if (proposal.steps.some((s) => s.value?.kind === 'secret')) {
    // Said while the person is still on the review screen and still remembers
    // which account they used. The same question asked by a run that failed at
    // 3am is a support ticket.
    warnings.push(
      'Este trámite inicia sesión, así que necesita una credencial vinculada para poder ejecutarse. Vincúlala ahora: la clave se guarda cifrada y no se muestra en ninguna parte.',
    );
  }

  return {
    ok: true,
    result: { proposal, spend, warnings: [...warnings, ...proposal.notes] },
  };
}

/**
 * Declare the slots the inserted pauses fill, without touching the ones the
 * model already found.
 *
 * A pause that fills an undeclared slot is worse than no pause: the run stops,
 * somebody types the code, and the `fill` step after it types the literal
 * `{{codigo_de_verificacion}}` into the portal because nothing ever declared
 * that hole. `auditSlots` would catch it on the review screen as a warning; a
 * warning about a field the person cannot fix is a warning they learn to skip.
 */
function withCodeSlots(existing: Variable[], added: string[], steps: Step[]): Variable[] {
  if (added.length === 0) return existing;
  const known = new Set(existing.map((v) => v.name));
  const labelOf = (name: string) =>
    steps.find((s) => s.action === 'pause' && s.extractAs === name)?.label ?? name;

  const fresh: Variable[] = added
    .filter((name) => !known.has(name))
    .map((name) => ({
      name,
      label: labelOf(name),
      example: '',
      required: true,
      type: 'code' as const,
    }));

  // And any the model happened to declare itself get the type corrected: it
  // read a picture and had no way to know this one is single-use.
  return [
    ...existing.map((v) => (added.includes(v.name) ? { ...v, type: 'code' as const } : v)),
    ...fresh,
  ];
}

/** Re-exported so the API route can validate an edited proposal the same way. */
export { proposalSchema };
export type { Variable };
