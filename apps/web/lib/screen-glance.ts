import type { CoreMessage } from 'ai';
import { z } from 'zod';
import { MAX_MARKS, type ScreenMark, normalizeMarks } from './screen-marks';

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
 *
 * A fifth instruction was added with pointing: WHERE, NOT ONLY WHAT. It is
 * short because the tool's own description carries the format; what it has to
 * do here is make the model reach for the tool at all on the question this
 * feature was built for — «¿dónde le doy?» — instead of writing "arriba a la
 * derecha", which is the answer somebody already could not follow, in prose.
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
    '',
    'Si la pregunta es DÓNDE — dónde le da, dónde está ese campo, cuál de todos es — no lo',
    'describas con palabras como «arriba a la derecha»: usa screen_point_at para recuadrar el sitio',
    'sobre la misma imagen, y explica igual en la frase qué es lo que recuadraste. El recuadro se',
    'dibuja dentro del chat, sobre el cuadro que te llegó, no encima de su pantalla real.',
    '</pantalla>',
  ].join('\n');
}

// ===========================================================================
// SEÑALAR: where the model says the thing is
// ===========================================================================
/**
 * A TOOL, NOT A BLOCK OF STRUCTURED OUTPUT — and the four reasons in order.
 *
 * The alternative was real: ask for `<marcas>[{...}]</marcas>` inside the
 * answer and parse it out of the text on the client. It was rejected on all
 * four of the following, and the first two on their own would have been enough.
 *
 *   1. THE ANSWER IS STREAMED, SO A BLOCK IS PARSED HALF-WRITTEN. Text arrives
 *      a token at a time and is drawn as it arrives (see ChatMarkdown). A JSON
 *      block inside it is on screen as `[{"x1": 0.` for a second or two, every
 *      time, and every partial parse either flickers a rectangle into the wrong
 *      place or shows the person raw JSON in the middle of a sentence. There is
 *      no ordering trick that fixes this: the block has to be complete to mean
 *      anything, and the text has to be visible before it is complete.
 *
 *   2. THE TRANSPORT ALREADY EXISTS AND ALREADY SURVIVES A RELOAD. Tool calls
 *      come down the same data stream as the answer, arrive on the client
 *      already parsed as `toolInvocations`, get written to `messages
 *      .tool_results` by the route's onFinish, and are rebuilt from that row by
 *      `toToolInvocations` when a conversation is reopened. MessageBubble
 *      already sorts invocations into cards and steps. So the marks reach the
 *      screen, and reach it again next week, through machinery that is already
 *      built, already tested and already understood — while a text block would
 *      need a parser, a persistence path and a re-parse on load, three new
 *      places for the same value to go wrong.
 *
 *   3. THE SHAPE IS ENFORCED BY THE PROVIDER, NOT BY A REGEX. `x1` arrives as a
 *      number because the schema says it is one. A block in prose arrives as
 *      whatever the model felt like, including 0,42 with a comma, "42%" and a
 *      trailing comma before the closing bracket.
 *
 *   4. IT CAN BE WITHHELD. This tool is declared ONLY on turns that carry a
 *      frame (see the chat route). A tool that is not offered cannot be called;
 *      an output-format instruction that is not present can still be imitated
 *      from three turns ago, and a mark drawn over a picture nobody sent is the
 *      most confusing failure this feature has available to it.
 *
 * IT IS ALSO DELIBERATELY NOT A REGISTRY TOOL. Everything in packages/agent-
 * tools goes through `runTool` for audit, rate limiting, confirmation and risk,
 * and gets a semantic vector so the ranker can offer it. This one touches
 * nothing, reads nothing and returns its own input made safe — there is no
 * action to audit — and a vector would let the ranker offer it on turns with no
 * picture, which is exactly what point 4 exists to prevent.
 */
export const POINT_AT_TOOL_ID = 'screen.point_at';

/** The AI SDK name. Same substitution the route makes for registry ids. */
export const POINT_AT_TOOL_NAME = 'screen_point_at';

export const POINT_AT_DESCRIPTION =
  'Draw a numbered box on the frame of the screen you were just given, to point at something on it. ' +
  'Use it whenever the question is WHERE — where do I click, which field is it, which of these is the one — ' +
  'and keep explaining in words as well: the box is drawn beside your answer, it does not replace it. ' +
  'COORDINATES ARE FRACTIONS OF THE FRAME, from 0 to 1: x1/x2 are fractions of its width measured from the ' +
  'left edge, y1/y2 fractions of its height measured from the top. The top-left corner is (0, 0) and the ' +
  'bottom-right is (1, 1); the centre of the frame is (0.5, 0.5). NEVER give pixels — the frame was resized ' +
  'before it reached you and is drawn again at a different width, so a pixel points somewhere else. ' +
  `Keep the box tight around the thing itself. At most ${MAX_MARKS} boxes, in the order the person should ` +
  'follow them. Each label is one short phrase IN SPANISH naming what is inside the box («el botón Radicar»), ' +
  'because it is also what a screen reader announces to somebody who cannot see the picture.';

/**
 * The tool's parameters — and why the ranges are NOT declared here.
 *
 * zod could say `.min(0).max(1)` on every coordinate, and it deliberately does
 * not. A schema violation makes the call fail before `execute` ever runs, so a
 * model that answered 1.03 because it rounded at the edge of the screen would
 * lose the whole mark, and the person would get "no pude señalarlo" for an
 * answer that was essentially right. Ranges are handled one layer down by
 * `normalizeMarks`, which can tell the difference between a rounding error (
 * clamp it) and a rectangle that is nowhere near the picture (drop it) — and
 * which runs again in the browser on the way to the screen.
 */
export const PointAtSchema = z.object({
  marks: z
    .array(
      z.object({
        x1: z.number().describe('Left edge, fraction of the frame width (0–1).'),
        y1: z.number().describe('Top edge, fraction of the frame height (0–1).'),
        x2: z.number().describe('Right edge, fraction of the frame width (0–1).'),
        y2: z.number().describe('Bottom edge, fraction of the frame height (0–1).'),
        label: z.string().describe('One short phrase in Spanish naming what is inside the box.'),
      }),
    )
    .min(1)
    .max(8)
    .describe('The boxes to draw, in the order the person should follow them.'),
});

export interface PointAtResult {
  marks: ScreenMark[];
  /** How many the model asked for that could not be drawn. Zero, normally. */
  ignored: number;
  /** Said to the MODEL, in its own turn, so it can correct itself. */
  note?: string;
}

/**
 * What the tool gives back: the marks that can actually be drawn, and — when
 * some could not — a sentence telling the model so.
 *
 * The note is the part worth arguing for. A tool that silently discarded a bad
 * rectangle would leave the model believing it had pointed at something, and it
 * would then write «como ves en el recuadro» over a picture with no recuadro on
 * it. Told plainly that the coordinates were out of range, it has eleven more
 * steps available (maxSteps in the route) to try again with fractions, or to
 * answer in words — either of which is an answer the person can use.
 *
 * `.max(8)` above and `MAX_MARKS` here are different numbers on purpose: asking
 * for nine is a schema error the model must fix, while asking for five is a
 * judgement call, and the fifth box is simply not drawn.
 */
export function pointAtResult(input: { marks: unknown }): PointAtResult {
  const asked = Array.isArray(input.marks) ? input.marks.length : 0;
  const marks = normalizeMarks(input.marks);
  const ignored = Math.max(0, asked - marks.length);

  if (marks.length === 0) {
    return {
      marks: [],
      ignored,
      note:
        'No pude dibujar ninguna marca: las coordenadas quedaron fuera del cuadro. ' +
        'Van de 0 a 1 como fracción del ancho y del alto de la imagen que te pasé, nunca en píxeles ' +
        '(esquina superior izquierda 0,0; inferior derecha 1,1). Vuelve a intentarlo así, o si no ' +
        'estás seguro de dónde está, dilo con palabras y no señales nada.',
    };
  }

  if (ignored > 0) {
    return {
      marks,
      ignored,
      note:
        `Dibujé ${marks.length} de las ${asked} marcas que pediste. El resto quedaba fuera del cuadro ` +
        'o venía sin texto. Cuenta sólo las que se dibujaron cuando te refieras a ellas.',
    };
  }

  return { marks, ignored: 0 };
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
