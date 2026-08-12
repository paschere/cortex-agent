import type { Logger } from '@cortex/core';
import { generateText } from 'ai';
import { z } from 'zod';
import { utilityModel } from '../model';
import { addSpend, spendOf } from './cost';
import { enforceSecrets } from './redact';
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

/** One sampled frame. `atMs` is milliseconds since the recording started. */
export interface Frame {
  base64: string;
  mimeType: string;
  atMs: number;
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
Si ves un campo que se muestra con puntos o asteriscos, o cuyo rótulo habla de contraseña, clave, usuario, PIN, token o código de verificación: NO transcribas lo que se escribió. Pon {"kind":"secret","field":"clave"} con un nombre corto para el campo. Nunca escribas los caracteres, ni siquiera parcialmente, ni siquiera si se alcanzan a leer.

LECTURA Y ESCRITURA
"effect" es "read" si el trámite sólo consulta o descarga algo, y "write" si envía, radica, paga, acepta o modifica algo en el sistema del tercero. Ante la duda, "write".

REFERENCIAS DE PÁGINA
En cada paso, "landmarks" son 2 o 3 textos fijos de la página en ese momento (un encabezado, el nombre del portal). Sirven para saber después si seguimos en la página correcta. No son para encontrar nada.

RESPONDE SÓLO CON JSON, sin explicación alrededor.`;

function userPrompt(hint: string, frameCount: number): string {
  return `Aquí van ${frameCount} cuadros de la grabación, en orden cronológico. Entre un cuadro y el siguiente la persona hizo algo: dedúcelo del cambio en pantalla.

${hint ? `La persona describió el trámite así: "${hint}"\n\n` : ''}Devuelve este JSON:
{
  "name": "nombre corto del trámite, en español",
  "description": "una frase de qué consigue",
  "startUrl": "la URL donde empieza, tal como se ve en la barra de direcciones del primer cuadro",
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
  const declared = new Set(proposal.variables.map((v) => v.name));
  const used = new Set<string>();

  for (const step of proposal.steps) {
    if (step.value?.kind === 'template') {
      for (const match of step.value.text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) {
        if (match[1]) used.add(match[1]);
      }
    }
    if (step.action !== 'goto' && step.action !== 'wait_for' && step.targets.length === 0) {
      warnings.push(`El paso «${step.label}» no tiene ninguna forma de encontrar su elemento.`);
    }
    if (step.targets.length === 1 && step.action !== 'goto') {
      warnings.push(
        `«${step.label}» tiene una sola forma de encontrarse; si el portal cambia, ese paso se rompe primero.`,
      );
    }
  }

  for (const name of used) {
    if (!declared.has(name))
      warnings.push(`El paso usa {{${name}}} pero esa variable no está declarada.`);
  }
  for (const name of declared) {
    if (!used.has(name))
      warnings.push(`La variable «${name}» está declarada pero ningún paso la usa.`);
  }
  if (proposal.variables.length === 0) {
    warnings.push(
      'No encontré ningún dato que cambie entre una ejecución y otra, así que este trámite sólo sabe repetirse igual. Revisa si algo de lo que se escribió debería ser variable.',
    );
  }
  return warnings;
}

export async function extractFlowFromRecording(input: {
  frames: Frame[];
  /** What the person said they were doing. Optional and only a hint. */
  hint?: string;
  logger: Logger;
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
    const result = await generateText({
      model: utilityModel(),
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt(input.hint ?? '', frames.length) },
            ...frames.map((frame) => ({
              type: 'image' as const,
              image: frame.base64,
              mimeType: frame.mimeType,
            })),
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
  const proposal: Proposal = { ...parsed.data, steps: guarded.steps };

  const warnings = audit(proposal);
  if (guarded.redacted > 0) {
    warnings.push(
      `Detecté ${guarded.redacted} campo(s) de credencial en la grabación. No guardé lo que se tecleó: hay que vincular una credencial cifrada para que el trámite pueda ejecutarse.`,
    );
  }

  return {
    ok: true,
    result: { proposal, spend, warnings: [...warnings, ...proposal.notes] },
  };
}

/** Re-exported so the API route can validate an edited proposal the same way. */
export { proposalSchema };
export type { Variable };
