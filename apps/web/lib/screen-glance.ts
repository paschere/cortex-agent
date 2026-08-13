import type { CoreMessage } from 'ai';
import { z } from 'zod';

/**
 * One frame of the tab somebody is sharing, on its way into a turn.
 *
 * ===========================================================================
 * WHY THIS IS A MODULE AND NOT FOUR HELPERS INSIDE THE CHAT ROUTE
 * ===========================================================================
 * Two reasons, and the second is the real one. The route is contested — several
 * people edit it at once — so anything that can be argued and tested somewhere
 * else should be. And these four things are exactly the parts of a screen
 * question that can go wrong silently: a frame accepted that should have been
 * refused, a cost written down wrong, a prompt block that forgets the citation
 * rule, and an image attached to the wrong message. All four are pure functions
 * of their input, so all four are tested in screen-glance.test.ts with plain
 * objects and no model, no browser and no database.
 *
 * The route keeps only the decisions that need the request: whether a frame
 * came, and what to write on the message row.
 */

/**
 * What the composer is allowed to post.
 *
 * The size cap is the one line here doing security work rather than typing.
 * ~1,4 MB of base64 is a 1 MB JPEG — comfortably above a 1280px frame at
 * quality 0.85 (250–400 KB in practice) and low enough that a client that has
 * been tampered with cannot post a film one part at a time.
 */
export const ScreenGlanceSchema = z.object({
  base64: z.string().min(1).max(1_400_000),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  takenAt: z.string().datetime(),
});

export type ScreenGlanceInput = z.infer<typeof ScreenGlanceSchema>;

/**
 * What one frame costs the model, in input tokens.
 *
 * ===========================================================================
 * ESTIMATED, NOT MEASURED — AND IT IS AN ESTIMATE THAT CANNOT DRIFT MUCH
 * ===========================================================================
 * `width × height / 750` is Anthropic's own published formula, and the property
 * that makes it trustworthy here is that it is a function of the frame's SIZE
 * and of nothing else: the same monitor costs the same whether it is showing a
 * spreadsheet or a photograph, and the JPEG quality — which changes the bytes
 * on the wire by a factor of three — does not move it by one token.
 *
 * It has NOT been checked against a live `count_tokens` call. It should be,
 * once, when there is credit on the account; until then every figure derived
 * from it (see the note in lib/tab-recorder.ts) is arithmetic on a documented
 * rate rather than an observation, and is labelled that way everywhere it
 * appears. A frame at 1280×720 works out at 1 229 tokens.
 *
 * The number goes onto the message row because the dimensions come from the
 * person's own display and are gone with the image — see migration 0092 — so
 * this is the only moment the cost of a glance can be known at all. Once there
 * are real rows, `sum(screen_glance_tokens)` against the provider's invoice is
 * the check that closes this loop without a single test call.
 */
export function glanceTokens(width: number, height: number): number {
  return Math.max(1, Math.round((width * height) / 750));
}

/**
 * What the model is told about the picture it has been handed.
 *
 * ===========================================================================
 * THE PART THAT MAKES THIS CORTEX AND NOT A CAMERA
 * ===========================================================================
 * An assistant that can see a screen answers questions about the screen. This
 * one is attached to a company's memory, its tools and its provenance rules, so
 * the questions worth asking are the ones that cross the two: «este contrato en
 * pantalla, ¿dice lo mismo que el que firmamos en marzo?». Nothing about the
 * turn had to change for that to be possible — retrieval still runs, the tool
 * ranker still ranks, and `kb` is on offer on every turn (BASE_FAMILIES in
 * tool-selection) even when the question is four words long. So this block's
 * job is only to make sure the model KNOWS the crossing is available, and that
 * the citation rules did not go away because the question arrived as an image.
 *
 * The four instructions are each here because of a specific way this goes
 * wrong:
 *
 *   IT IS NOT MEMORY. A frame is not a document, nobody else can open it, and
 *   it will not exist in a minute. A model that treats it as a source produces
 *   a citation the reader cannot follow, which is the exact failure this
 *   product exists to prevent. Same argument, same wording as an ephemeral
 *   attachment — see lib/chat-attachments.ts.
 *
 *   CROSS IT, AND CITE. Without this the model answers from the picture alone,
 *   because the picture is right there and searching is work. An answer that
 *   compares a screen to "what we agreed" without saying which document said so
 *   is the confident, unfalsifiable kind, and it is worse than no answer.
 *
 *   SAY WHAT YOU CANNOT SEE. A frame is a viewport: the rest of the page is
 *   below the fold, the small print is small, a column is cut off. A model that
 *   quietly fills in the part it cannot read produces a precise answer about a
 *   field that was never on screen, and the reader has no way to tell. Said out
 *   loud, the person scrolls and asks again — which is the second frame this
 *   design would otherwise have had to guess it needed.
 *
 *   DO NOT READ SECRETS ALOUD. The capture contract promises that passwords are
 *   not transcribed. Password fields render as dots, but a revealed field, a
 *   password manager, an API key on a config screen or a one-time code do not —
 *   so the promise is enforced here as well as trusted to the browser.
 */
export function screenBlock(takenAt: string): string {
  return [
    '<pantalla>',
    'La persona está compartiendo UNA pestaña de su navegador y esta pregunta trae UN cuadro de',
    `esa pestaña, tomado en el momento exacto en que la envió (${takenAt}). Es lo que tiene al`,
    'frente ahora mismo.',
    '',
    'NO es un documento ni parte de la memoria de la empresa: no está indexado, nadie más lo puede',
    'abrir y deja de existir cuando termines de responder. Úsalo con toda libertad para responder,',
    'pero refiérete a él como «lo que tienes en pantalla», nunca como algo que estuviera guardado.',
    '',
    'Si la pregunta compara lo que se ve con lo que la empresa sabe — un contrato, una tarifa, un',
    'cliente, un compromiso, lo que se acordó antes — BÚSCALO con tus herramientas y cita la fuente',
    'como en cualquier otra respuesta. Esa es la parte que vale: leer la pantalla lo hace cualquiera,',
    'cruzarla con lo que ya sabemos lo haces tú. Una comparación sin fuente no sirve.',
    '',
    'Di qué NO alcanzas a ver. Un cuadro es sólo la parte visible de la página: si la respuesta',
    'depende de algo que quedó cortado, borroso o más abajo, dilo y pídele que lo muestre, en vez de',
    'suponerlo.',
    '',
    'Si en la imagen se alcanza a ver una contraseña, una clave, un token o un código de',
    'verificación, no lo transcribas ni completo ni en parte, y avísale que quedó a la vista.',
    '</pantalla>',
  ].join('\n');
}

/**
 * Put the frame on the question it was taken for.
 *
 * THE LAST USER MESSAGE, NOT A MESSAGE OF ITS OWN. The picture is part of the
 * question — a model handed it as a separate turn has to guess which question
 * it belongs to, and on a thread with three screen questions in a row it will
 * eventually guess wrong. The image goes FIRST inside the content array so the
 * text that refers to it («¿qué significa este error?») is read after the thing
 * it refers to.
 *
 * Returns a new array. The caller has already weighed the turn by the length of
 * the strings it sent (see `recorder.part` in the chat route), and mutating a
 * string content into an array of parts underneath that measurement would turn
 * a measured number into `[object Object]`.
 */
export function attachScreenFrame(
  messages: readonly CoreMessage[],
  glance: Pick<ScreenGlanceInput, 'base64' | 'mimeType'>,
): CoreMessage[] {
  const next = [...messages];
  const at = next.map((m) => m.role).lastIndexOf('user');
  const target = at >= 0 ? next[at] : undefined;
  // No user message to attach to should be impossible — the route refuses a
  // body without one — but dropping the frame is the right failure: an image
  // hung off an assistant turn is a question nobody asked.
  if (!target) return next;

  next[at] = {
    role: 'user',
    content: [
      { type: 'image', image: glance.base64, mimeType: glance.mimeType },
      { type: 'text', text: String(target.content) },
    ],
  };
  return next;
}
