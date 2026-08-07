/**
 * What a retrieval score means — decided once, in one file, PER EMBEDDING MODEL.
 *
 * THE PROBLEM THIS FIXES. Retrieval always answers. Ask about the rate card and
 * it returns the rate card; ask it for a recipe and it returns the rate card
 * too, a little lower down, and the model reads a list of chunks as evidence
 * that the brain knows something. "I have nothing on that" was not expressible,
 * so it was never said. Saying it is the whole difference between a search box
 * and somebody you trust.
 *
 * WHICH NUMBER TO THRESHOLD ON. `score` on a hit is the 0.7 semantic / 0.3
 * keyword blend the SQL sorts by. It is a good ORDER and a meaningless
 * MAGNITUDE: `ts_rank` is 0 for most rows and unbounded for the rest, so the
 * same relevance lands anywhere depending on whether the question happened to
 * share literal words with the passage. Every threshold ever set on it was set
 * on sand. `semanticScore` is the raw cosine similarity between question and
 * passage, it means the same thing from one query to the next, and it is what
 * these thresholds are on. Migration 0066 is what started returning it
 * separately.
 *
 * WHY THE THRESHOLDS ARE KEYED BY MODEL AND NOT CONSTANTS. Cosine similarity
 * has no absolute meaning across models: each one places questions and passages
 * on its own scale, and the SAME perfect hit scores differently under each.
 * Measured on one corpus, one day, both at 1024 dimensions: the passage that
 * answers "¿plan de arranque de cortex?" scores 0.530 under voyage-3-large and
 * 0.489 under voyage-4-lite, and a question with nothing to do with the corpus
 * scores 0.404 under the first and 0.216 under the second. The two models do
 * not merely shift, they have different DYNAMIC RANGE. A number calibrated for
 * one and applied to the other is not approximately right, it is unrelated —
 * which is why `CALIBRATIONS` is a map, `calibrationFor()` is the only way in,
 * and a model with no measurement is loud rather than silent.
 *
 * ---------------------------------------------------------------------------
 * THE MEASUREMENT — 2026-08-05, voyage-4-lite, 1024 dims, input_type
 * document/query, against the live API.
 * ---------------------------------------------------------------------------
 * An eleven-document corpus of the kind Brain Knowledge actually holds (a
 * client contract and its signed otrosí, the renegotiation call that produced
 * it, vacation and payroll policy, an insurance policy, a recruiting playbook,
 * onboarding, benefits, product notes, and the BBIC start-up plan from the
 * production failure below), CHUNKED BY THE REAL `chunkText` — 23 chunks,
 * median 359 tokens — then queried with 22 questions in three groups.
 * Top-1 cosine per query:
 *
 *   group                                     min    p25    med    max
 *   ------------------------------------------------------------------
 *   answered by the corpus       (11 queries) 0.489  0.538  0.554  0.633
 *   plausible but not in it       (5 queries) 0.394  0.443  0.448  0.507
 *   nothing to do with it         (6 queries) 0.160  0.160  0.216  0.548
 *
 * The same corpus and the same 22 questions under voyage-3-large, so that the
 * claim above about scale is a measurement and not an opinion:
 *
 *   answered by the corpus       (11 queries) 0.530  0.589  0.606  0.726
 *   plausible but not in it       (5 queries) 0.487  0.513  0.517  0.539
 *   nothing to do with it         (6 queries) 0.361  0.396  0.404  0.604
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASUREMENT REPLACES, AND WHY THE OLD ONE WAS WRONG
 * ---------------------------------------------------------------------------
 * A PDF titled "CÓRTEX · Plan de arranque para BBIC S.A.S." was uploaded, and
 * asked about with the words its owner actually typed: "¿plan de arranque de
 * cortex?". The right chunk — the first one, carrying the title — came back
 * top, scored 0.436, and was DISCARDED, because the floor was 0.45. The screen
 * said "No tiene nada de esto" over the one document that answered exactly that
 * question. Fourteen thousandths.
 *
 * The previous measurement in this file claimed the questions its corpus
 * ANSWERED bottomed out at 0.582. The first suspicion was that the default
 * model had moved (voyage-3-large → voyage-4-lite, migration 0074) and left the
 * thresholds orphaned. That is true and it is not the cause: measured on the
 * same corpus, the identical hit scores 0.530 under the OLD model — still far
 * below the 0.582 the old measurement declared as its worst case. The old
 * numbers did not describe production under either model.
 *
 * So the four candidate explanations were measured, one at a time, against the
 * same passage and the live API:
 *
 *   THE SHAPE OF THE QUESTION — the cause, and it is not close. Identical
 *     passage, identical model, only the wording changed:
 *
 *       0.489  ¿plan de arranque de cortex?
 *       0.491  plan de arranque cortex
 *       0.549  ¿cuál es el plan de arranque de Córtex?
 *       0.574  ¿cuál es el plan de arranque de Córtex para BBIC?
 *       0.652  ¿qué fases tiene el plan de arranque de Córtex para BBIC S.A.S.?
 *
 *     A well-formed question scores 0.163 higher than the four-word fragment a
 *     person actually types — twelve times the margin that lost the document.
 *     The old measurement was written with well-formed questions, so it
 *     measured a system nobody uses. Every group above was re-measured with the
 *     terse, unpunctuated, accent-dropping phrasing real people write, and that
 *     is the single biggest reason these numbers are lower than the old ones.
 *
 *   CHUNK LENGTH — real, small, and NOT the cause. Same content, grown:
 *
 *       0.446   11 tok  the title line alone
 *       0.522   71 tok
 *       0.500  279 tok
 *       0.490  400 tok  (the chunker's target)
 *       0.494  764 tok
 *
 *     Dilution costs about 0.03 from the peak — and note the title ALONE scores
 *     lowest of all, so "shorter chunks would fix it" is backwards. There is a
 *     sweet spot near 150 tokens worth perhaps 0.03; the 400-token target is
 *     not what lost this document.
 *
 *   INPUT TYPE — correct in production, and worth keeping correct:
 *
 *       0.488  query / document   ← what production does
 *       0.458  document / document
 *       0.406  query / query
 *
 *     The asymmetry `embedder.ts` insists on is worth 0.03 to 0.08. No bug
 *     here; this is the confirmation that there is none.
 *
 *   PDF FURNITURE — real, small. Running headers, a footer, soft line wraps and
 *     a cover page absorbed into chunk 0 together cost 0.017 (0.489 → 0.472).
 *
 * Stacked, those effects put a PERFECT hit anywhere between 0.44 and 0.50 —
 * straddling the old 0.45 floor, which is exactly what production did.
 *
 * SCORING THE BEST PASSAGE INSTEAD OF THE CHUNK WAS TRIED AND REJECTED. If long
 * chunks dilute, the obvious fix is to score each chunk by its best sentence.
 * Measured, it is worse in both directions: the failing query's best single
 * passage is 0.446 against 0.488 for the whole chunk, and across the corpus it
 * INVERTS the groups — questions the corpus answers bottom out at 0.446 while
 * plausible-but-absent ones bottom out at 0.490. Short passages score high on
 * anything vaguely on-topic, so the separation the thresholds depend on is
 * destroyed. It is written down here so it is not tried again.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE TWO CUTS GO, FOR voyage-4-lite
 * ---------------------------------------------------------------------------
 *   STRONG_MATCH = 0.46. Every question the corpus answers clears it, worst
 *     case 0.489 — including the real production question that started this,
 *     with 0.029 of margin instead of the fourteen thousandths that lost it.
 *     It sits in the gap between the plausible group's 0.448 and its 0.476.
 *     Two "not in it" questions clear it and that is the right behaviour, not a
 *     leak: "teletrabajo permanente desde el exterior" (0.507) pulls up the
 *     vacation policy, which IS the document to read and simply has no line for
 *     a permanent arrangement, and the model can say so.
 *
 *   WEAK_FLOOR = 0.34, and things below it are not offered as citations. Under
 *     this model the genuinely-unrelated group tops out at 0.247 and the
 *     plausible group bottoms out at 0.394, leaving a wide empty band with
 *     nothing measured in it at all. The floor goes at the LOW end of that
 *     band, deliberately: one dud arriving labelled "coincidencia débil" is a
 *     smaller failure than four half-relevant answers being swallowed. Erring
 *     the other way is how an assistant learns to say "no sé" to questions it
 *     could have answered, which is worse than the bug this file exists to fix
 *     — and which is precisely what shipped, so the margin is deliberate.
 *
 *     (The unrelated group's 0.548 outlier is "¿podemos traer mascotas a la
 *     oficina?" against the onboarding guide, which answers it outright: "no
 *     hay política de mascotas; el edificio no lo permite." It is a correct
 *     retrieval mislabelled by the group it was filed under, not a leak.)
 *
 * ---------------------------------------------------------------------------
 * RE-MEASURED 2026-08-07 ON A CORPUS THAT LIVES IN THE REPOSITORY — AND THE
 * CUTS DID NOT MOVE, WHICH IS THE FINDING
 * ---------------------------------------------------------------------------
 * Everything above was run once, by hand, and typed into this comment. That is
 * the same shape as the bug it was fixing: evidence nobody can re-run is
 * evidence that goes stale without a sound. So the evidence base moved into
 * `packages/agent-tools/src/evaluation` — eight documents of the length people
 * really upload, twenty-two questions in these same three groups, chunked by the
 * real `chunkText`, every cosine measured against the live API and committed.
 * It replays through THIS file on every `pnpm test`.
 *
 * Its first run reported that the strong cut had run out of margin: "¿plan de
 * arranque de cortex?" scored 0.458 against a cut of 0.46. Two thousandths — the
 * production incident, again, on a corpus of realistic length.
 *
 * SO THE CUT WAS SWEPT, AND MOVING IT DOWN IS NOT A FIX. Best cosine per
 * question, in the contested band, with the group each one belongs to:
 *
 *     0.426  answered   «dias de la casa cuantos son»
 *     0.429  ABSENT     «puedo trabajar permanentemente desde el exterior»
 *     0.441  answered   «por que le subimos el precio a nexa»
 *     0.446  ABSENT     «tarifa hora de un ingeniero de datos»
 *     0.456  ABSENT     «cual es la penalidad ... con bbic»
 *     0.456  ABSENT     «la poliza cubre un ataque de ransomware»
 *     0.458  answered   «¿plan de arranque de cortex?»   ← the one that started it
 *     0.459  ABSENT     «licencia de paternidad cuantas semanas da cortex»
 *     0.470  answered   «preaviso para terminar el contrato de nexa»
 *
 * THE GROUPS INTERLEAVE. A question the corpus does not answer outscores the
 * question it does, so no cut on the cosine admits the start-up plan and
 * excludes paternity leave. The whole trade, measured:
 *
 *     cut     questions answered   questions sold as answered that are not
 *     0.46      8 of 12              0      ← where it is, and where it stays
 *     0.458     9 of 12              1
 *     0.456     9 of 12              3
 *     0.44     10 of 12              4
 *     0.425    11 of 12              5      ← every absent question, "answered"
 *
 * 0.46 is on the frontier. Every thousandth of "margin" bought below it is paid
 * for immediately in the opposite failure, one for one or worse. The evaluation
 * counts the two separately — `missedByFloor` and `overclaimed` — precisely so
 * that trade cannot be passed off as an improvement, and it is written down here
 * so the next person handed "the cut is two thousandths too high" does not spend
 * a day rediscovering that lowering it is the other bug.
 *
 * THE WEAK FLOOR IS IN THE SAME POSITION. "cuanto dan para estudiar al año" is
 * discarded outright at 0.298 over a document that states the figure — and the
 * genuinely unrelated group reaches 0.319 ("a que hora juega la seleccion
 * colombia"), so every floor low enough to save that question also lets football
 * fixtures into Brain Knowledge's citations. It is left failing, counted, and on
 * the record, rather than traded for a leak nobody would notice.
 *
 * ---------------------------------------------------------------------------
 * WHAT DID MOVE: EVIDENCE THAT IS NOT A COSINE
 * ---------------------------------------------------------------------------
 * If no cut works, the score has to carry something the cosine does not. Two
 * candidates were measured and both failed, and they are recorded so they are
 * not tried again: the TOP-1 MARGIN (how far the best chunk beats the second)
 * does not separate the groups — 0.086 for the start-up plan against 0.104 for
 * the ransomware question — and neither does the margin over the best chunk of
 * any OTHER document (0.086 against 0.216). Both look like signal and are not.
 *
 * WHAT DOES SEPARATE THEM IS THE TITLE, and it separates them cleanly. See
 * `queryNamesDocument` below. Briefly: measured over every hit of all twenty-two
 * questions, the fraction of a question's content words that appear in the
 * TITLE of the document a hit came from reaches 1.00 exactly once — the start-up
 * plan — while the highest any question the corpus does not answer reaches is
 * 0.25. That is a margin of three quarters, against the two thousandths the cut
 * had. One hit is promoted, one verdict changes, nothing is sold as answered
 * that is not.
 *
 * It also fires precisely where the cosine is known to be weakest. The ladder at
 * the top of this file measures a terse fragment scoring 0.163 below the same
 * question well formed; a question short enough for EVERY one of its words to be
 * in a title is a question of exactly that shape. The rule does not raise the
 * bar or lower it — it adds the one piece of evidence the embedding cannot see,
 * for the one class of question that needs it.
 *
 * WHAT THE OLDEST NUMBERS WERE DOING. Before any of this, both thresholds were
 * on the BLEND, and on a corpus with no literal keyword overlap the blend never
 * exceeded 0.496 for any query, including the ones answered perfectly.
 * `kb.context` cut at 0.55 and the chat RAG block at 0.65 — so both were
 * discarding every correct result they were ever given. That is the failure
 * this replaces, and it is why these thresholds are stated on a measured axis
 * with the measurement written next to them, per model, with its date.
 */

import {
  DEFAULT_EMBEDDING_PROVIDER,
  EMBEDDING_PROVIDERS,
  qualifyModel,
} from './embedding-providers';

/**
 * Two cuts and the evidence for them, for exactly one embedding model.
 *
 * `measured` is the field that matters. Everything else can be guessed; whether
 * anybody actually ran the queries cannot, and a guess that does not admit to
 * being one is how a full brain answers "no tengo nada de esto".
 */
export interface RelevanceCalibration {
  /** Provider-qualified, exactly as `kb_chunks.embedding_model` stores it. */
  modelId: string;
  /** A passage at or above this answers the question. */
  strongMatch: number;
  /** Below this a passage is not offered as a citation at all. */
  weakFloor: number;
  /**
   * Top of the bench's rail. Not a threshold — a drawing decision, and it is
   * per-model for the same reason the cuts are: a rail drawn to 1.0 squeezes
   * every real result into its bottom half. Sits just above the best score the
   * measurement ever saw.
   */
  railCeiling: number;
  /** False when nobody has run the corpus against this model. */
  measured: boolean;
  /** ISO date of the measurement, or null when there is none. */
  measuredOn: string | null;
  /** One line, in Colombian Spanish, for anyone reading the bench. */
  note: string;
}

/**
 * Every model whose thresholds come from running the corpus. Adding a model
 * here without measuring it is the bug this whole file is about, so
 * `relevance-calibration.test.ts` fails the build when a provider's default
 * model has no entry.
 */
export const CALIBRATIONS: Readonly<Record<string, RelevanceCalibration>> = {
  'voyage:voyage-4-lite': {
    modelId: 'voyage:voyage-4-lite',
    strongMatch: 0.46,
    weakFloor: 0.34,
    railCeiling: 0.75,
    measured: true,
    measuredOn: '2026-08-07',
    note: 'Medido el 5 de agosto de 2026 y vuelto a medir el 7 con la evaluación continua, sobre documentos del largo que la gente sube de verdad y con la redacción corta que escribe de verdad. Los dos cortes se barrieron: moverlos hacia abajo cambia una falla por la otra, así que se quedaron donde estaban.',
  },
  /**
   * The previous default. Kept because a deployment whose reindex has not
   * finished is still answering from these vectors, and because the contrast is
   * the argument: its groups OVERLAP — the questions the corpus answers bottom
   * out at 0.530 while the plausible-but-absent ones reach 0.539 — so it
   * separates worse than the cheaper model that replaced it. Same corpus, same
   * questions, same day.
   */
  'voyage:voyage-3-large': {
    modelId: 'voyage:voyage-3-large',
    strongMatch: 0.53,
    weakFloor: 0.48,
    railCeiling: 0.85,
    measured: true,
    measuredOn: '2026-08-05',
    note: 'Modelo anterior. Medido el mismo día y sobre el mismo corpus: separa peor que voyage-4-lite y además no tiene tokens gratis.',
  },
};

/**
 * Models this deployment can be switched to with one environment variable and
 * which NOBODY HAS MEASURED. Every entry is a promise to run the corpus before
 * that switch is made in anger.
 *
 * WHY THIS LIST EXISTS RATHER THAN A SILENT ABSENCE. `relevance-calibration.test.ts`
 * requires every provider's default model to appear either here or in
 * `CALIBRATIONS` — so adding a fifth provider, or changing a fourth one's
 * default, cannot be done without someone writing down which of the two it is.
 * The list makes the gap a decision on the record instead of a blank space that
 * reads exactly like a measured one. It is not permission: a model listed here
 * still runs on the deliberately-wide `uncalibrated()` margins and still says
 * out loud, in every verdict, that its thresholds are guesses.
 *
 * Voyage is the only provider this deployment holds a key for, which is why it
 * is the only one measured. The other three cannot be measured until somebody
 * has an account, and inventing numbers for them would be worse than admitting
 * there are none.
 */
export const AWAITING_MEASUREMENT: Readonly<Record<string, string>> = {
  'openai:text-embedding-3-small':
    'No hay clave de OpenAI en este despliegue, así que no se pudo correr el corpus. Mídelo antes de mover EMBEDDING_PROVIDER a openai.',
  'google:gemini-embedding-001':
    'La clave de Google sí existe, pero es la salida de emergencia y no la hemos medido. Si hay que usarla de verdad, córrele el corpus primero.',
  'cohere:embed-multilingual-v3.0':
    'No hay clave de Cohere en este despliegue. Mídelo antes de mover EMBEDDING_PROVIDER a cohere.',
};

/**
 * What to do about a model nobody has measured.
 *
 * IT LEANS PERMISSIVE ON PURPOSE. The two ways to be wrong here are not
 * symmetric. Thresholds set too high on an unknown scale produce "no hay nada
 * en Brain Knowledge" over a full brain — silent, untraceable, and indis-
 * tinguishable from an empty index. Thresholds set too low produce material
 * labelled "coincidencia débil", which a reader can see and dismiss. So an
 * unmeasured model gets a floor low enough that nothing plausible is swallowed,
 * a strong cut high enough that nothing is dressed up as an answer, and — the
 * part that actually fixes it — `measured: false`, which every summary repeats
 * out loud until somebody runs the corpus.
 */
export function uncalibrated(modelId: string): RelevanceCalibration {
  return {
    modelId,
    strongMatch: 0.6,
    weakFloor: 0.25,
    railCeiling: 0.85,
    measured: false,
    measuredOn: null,
    note: `Nadie ha medido los umbrales de recuperación para «${modelId}». Los que se están usando son un margen amplio provisional: puede aparecer material poco relacionado y casi nada se marcará como respuesta directa. Hay que correr la medición del corpus y añadir el modelo a CALIBRATIONS en relevance.ts.`,
  };
}

/** The model this deployment embeds with when nothing overrides it. */
export const DEFAULT_MODEL_ID = qualifyModel(
  DEFAULT_EMBEDDING_PROVIDER,
  EMBEDDING_PROVIDERS[DEFAULT_EMBEDDING_PROVIDER].defaultModel,
);

/**
 * The only way to get a pair of thresholds. Never returns null: a search that
 * ran has to be judged somehow, and the honest answer to "we have not measured
 * this" is a wide margin plus a sentence saying so, not a crash and not silence.
 *
 * A null model means the semantic arm did not run at all (keyword-only), where
 * there is no cosine to threshold — the default calibration is returned so the
 * rail still has a scale to draw, and `rateHit` never consults the numbers.
 */
export function calibrationFor(modelId: string | null | undefined): RelevanceCalibration {
  if (!modelId) return CALIBRATIONS[DEFAULT_MODEL_ID] ?? uncalibrated(DEFAULT_MODEL_ID);
  return CALIBRATIONS[modelId] ?? uncalibrated(modelId);
}

/** The calibration of the model this deployment is configured to use. */
export const DEFAULT_CALIBRATION: RelevanceCalibration = calibrationFor(DEFAULT_MODEL_ID);

/**
 * The default model's two cuts, restated as constants because the browser needs
 * them (see `apps/web/lib/kb-relevance-shape.ts`, which may not import this
 * package at all) and because the tests pin them. DERIVED, never authored: edit
 * `CALIBRATIONS`, not these.
 */
export const STRONG_MATCH = DEFAULT_CALIBRATION.strongMatch;
export const WEAK_FLOOR = DEFAULT_CALIBRATION.weakFloor;

export type HitRelevance =
  /** Answers the question; quote it. */
  | 'strong'
  /** Related, might not answer it; offer it as a lead, not as an answer. */
  | 'weak';

export type Coverage =
  /** At least one passage actually answers the question. */
  | 'answered'
  /** Something related came back, but nothing that answers it. */
  | 'thin'
  /** The brain holds nothing on this. A real answer, not an error. */
  | 'nothing'
  /**
   * The query could not be embedded, so only literal keyword matching ran.
   * Distinct from `nothing` on purpose: "I found nothing" and "I could only
   * look for these exact words" lead to different sentences.
   */
  | 'keyword-only';

/**
 * Words that carry no evidence about WHICH document is being asked for. Kept
 * deliberately short: this is not a linguistic stopword list, it is the set of
 * words whose presence or absence in a title says nothing, and every word added
 * to it makes `queryNamesDocument` easier to satisfy. Erring towards leaving a
 * word IN is the safe direction.
 */
const NAMING_STOPWORDS: ReadonlySet<string> = new Set([
  'de',
  'del',
  'la',
  'el',
  'los',
  'las',
  'un',
  'una',
  'unos',
  'unas',
  'y',
  'o',
  'u',
  'a',
  'al',
  'en',
  'con',
  'por',
  'para',
  'que',
  'cual',
  'cuales',
  'cuanto',
  'cuanta',
  'cuantos',
  'cuantas',
  'como',
  'cuando',
  'donde',
  'quien',
  'es',
  'son',
  'ser',
  'esta',
  'este',
  'estos',
  'estas',
  'ese',
  'esa',
  'eso',
  'se',
  'si',
  'no',
  'lo',
  'le',
  'les',
  'me',
  'mi',
  'mis',
  'su',
  'sus',
  'nos',
  'hay',
  'ha',
  'han',
  'he',
  'tiene',
  'tienen',
  'da',
  'dan',
  'dar',
  'hace',
  'hacer',
  'mas',
  'muy',
  'ya',
  'pero',
  'sobre',
  'desde',
  'hasta',
  'entre',
  'tambien',
  'nuestro',
  'nuestra',
]);

/**
 * A question has to say at least this much before naming a document counts.
 * One word is not naming anything: "cortex" appears in half these titles, and a
 * single-word query matching one of them would promote every chunk of it.
 */
const MIN_NAMING_WORDS = 2;

/**
 * The combining marks that `normalize('NFD')` splits an accented letter into.
 * Stripping them is what makes "cortex" match "CÓRTEX" — people do not type
 * accents into a search box and a title is not going to stop carrying them.
 */
const COMBINING_FIRST = 0x0300;
const COMBINING_LAST = 0x036f;

/**
 * Written as a loop rather than a regex on purpose: a character class holding
 * combining marks is exactly the construct that silently matches the wrong
 * thing, and the linter says so. Only ever runs over a question and a title.
 */
function stripAccents(text: string): string {
  let out = '';
  for (const character of text.normalize('NFD')) {
    const code = character.codePointAt(0) ?? 0;
    if (code >= COMBINING_FIRST && code <= COMBINING_LAST) continue;
    out += character;
  }
  return out;
}

/** Lowercase, unaccented, punctuation-free content words. */
function contentWords(text: string): string[] {
  return stripAccents(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !NAMING_STOPWORDS.has(word));
}

/**
 * Did the person name this document rather than ask about its contents?
 *
 * WHY THIS EXISTS. The cosine cannot get "¿plan de arranque de cortex?" over the
 * strong cut without also promoting four questions the corpus does not answer —
 * the sweep is in the header, and the groups genuinely interleave. So this is
 * the second kind of evidence: not "how close is this passage to the question"
 * but "is this passage from the document the question NAMED".
 *
 * THE RULE IS ALL-OR-NOTHING, AND THAT IS WHAT MAKES IT SAFE. Every content word
 * of the question has to appear in the title. Measured across every hit of all
 * twenty-two evaluation questions on 2026-08-07: exactly one pair reaches 1.00
 * (the question above against "CÓRTEX · Plan de arranque para BBIC S.A.S."), and
 * the best any question the corpus does NOT answer manages is 0.25 —
 * "penalidad/terminar/contrato/bbic" finding the word "contrato" in a Nexa
 * contract, which is one word out of four and nowhere near. A partial-credit
 * version of this rule would have promoted all of those; requiring all of them
 * is the difference between evidence and a coincidence.
 *
 * IT CANNOT INVENT A HIT, only re-read one. `rateHit` consults it exclusively
 * for passages that already cleared the weak floor — so the worst it can do is
 * promote something that was going to be shown anyway from "related" to
 * "answers this", and it can never resurrect a passage the floor discarded.
 *
 * The failure mode it accepts is a false negative: one extra word in the
 * question ("plan de arranque de cortex para bbic sas" would still pass, "cuando
 * arranca el plan de cortex" would not) and the rule simply does not fire,
 * leaving the cosine to decide exactly as before. Failing closed is the right
 * direction for a promotion.
 */
export function queryNamesDocument(query: string, title: string | null | undefined): boolean {
  if (!title) return false;
  const asked = [...new Set(contentWords(query))];
  if (asked.length < MIN_NAMING_WORDS) return false;
  const named = new Set(contentWords(title));
  return asked.every((word) => named.has(word));
}

export interface ScoredHit {
  /** Raw cosine similarity. Null when the semantic arm did not run. */
  semanticScore: number | null;
  /** ts_rank of the literal-word match. Zero for most rows. */
  keywordScore: number;
  /**
   * The title of the document this passage came from, when the caller has it.
   * Read only by `queryNamesDocument`. Optional because a hand-built hit in a
   * test has no document; every real hit carries one, and `SpaceHit` already
   * did before this field existed.
   */
  documentTitle?: string | null;
  /**
   * The provider-qualified model that produced BOTH the query vector and the
   * chunk vector this score came from — they are always the same model, because
   * `kb_search_scoped` refuses to rank across them (migration 0074). Null when
   * the semantic arm did not run. Optional only so that a caller constructing a
   * hit by hand in a test is not forced to invent one; every real hit has it.
   */
  embeddingModel?: string | null;
}

/**
 * How much a single hit is worth. `null` means "do not show this at all" —
 * it is below the floor and offering it would be the original bug.
 *
 * The calibration is a REQUIRED argument. It used to be two module constants,
 * and that is exactly how thresholds measured against one embedding model went
 * on being applied after the deployment moved to another one. Making it
 * impossible to rate a hit without naming the scale is the point.
 *
 * In keyword-only mode there is no cosine to judge, so anything the full-text
 * arm matched at all counts as weak: it literally contains the words asked
 * about, which is evidence, just not graded evidence.
 *
 * `query` is optional and is the second kind of evidence: a passage from a
 * document the question NAMED is an answer even when its cosine is a couple of
 * thousandths short, which is the production incident in one sentence. Callers
 * that omit it get exactly the behaviour this function had before the argument
 * existed — which is what `apps/web/lib/kb-relevance-shape.ts` mirrors for the
 * browser, where no title is at hand.
 */
export function rateHit(
  hit: ScoredHit,
  calibration: RelevanceCalibration,
  query?: string,
): HitRelevance | null {
  if (hit.semanticScore === null) return hit.keywordScore > 0 ? 'weak' : null;
  if (hit.semanticScore >= calibration.strongMatch) return 'strong';
  if (hit.semanticScore >= calibration.weakFloor) {
    // Only ever an upgrade, and only for a passage that was already going to be
    // shown. See `queryNamesDocument` for why it is all-or-nothing.
    return query && queryNamesDocument(query, hit.documentTitle) ? 'strong' : 'weak';
  }
  return null;
}

export interface CoverageVerdict<T> {
  coverage: Coverage;
  /**
   * The sentence to hand the model, in Colombian Spanish. It is prose rather
   * than a flag because the thing being prevented is a model looking at an
   * empty array and guessing whether that meant "nothing indexed", "search
   * broke" or "I should make something up".
   */
  summary: string;
  /** Hits worth citing, in the order they came, with their rating attached. */
  kept: Array<{ hit: T; relevance: HitRelevance }>;
  /** How many hits came back below the floor and were dropped. */
  discarded: number;
  /** Best cosine seen, floor or no floor. Null when nothing was scored. */
  bestScore: number | null;
  /**
   * Which scale this verdict was reached on. Carried out so the bench can draw
   * its rail at the cuts that were really applied, and so "these thresholds
   * were never measured for this model" is visible rather than inferred.
   */
  calibration: RelevanceCalibration;
}

export interface AssessOptions {
  /** What the person asked, quoted back in the summary. */
  query: string;
  /** Set when the query could not be embedded and only keywords ran. */
  degraded?: boolean;
  /** Where it looked, when it was narrowed to one space. */
  spaceName?: string;
  /**
   * The model that produced these scores. Omitting it falls back to the
   * deployment's configured model, which is right for callers that ran the
   * standard search and wrong for nobody — but pass it when you have it, which
   * `searchSpaces` always does.
   */
  embeddingModel?: string | null;
}

/**
 * Turn a raw result set into a verdict about what the brain knows.
 *
 * Deliberately returns the ratings rather than the hits themselves: callers
 * hold hits of different shapes (the tool's, the RAG block's, the briefing's)
 * and this stays the one place that decides, without owning their types.
 */
export function assessCoverage<T extends ScoredHit>(
  hits: T[],
  { query, degraded = false, spaceName, embeddingModel }: AssessOptions,
): CoverageVerdict<T> {
  const calibration = calibrationFor(
    embeddingModel ?? hits.find((h) => h.embeddingModel)?.embeddingModel ?? null,
  );
  const rated = hits.map((hit) => ({ hit, relevance: rateHit(hit, calibration, query) }));
  const kept = rated.filter((r): r is { hit: T; relevance: HitRelevance } => r.relevance !== null);
  const discarded = rated.length - kept.length;
  const scored = hits
    .map((h) => h.semanticScore)
    .filter((s): s is number => s !== null && Number.isFinite(s));
  const bestScore = scored.length > 0 ? Math.max(...scored) : null;

  const where = spaceName ? `en el espacio «${spaceName}»` : 'en Brain Knowledge';

  // Appended to every verdict reached on a scale nobody has measured. It is
  // deliberately said to the MODEL, not only logged: the failure being guarded
  // against is an assistant stating that the company knows nothing about a
  // subject, and it should be able to hedge that claim when the instrument it
  // used has never been checked.
  const caveat =
    calibration.measured || degraded
      ? ''
      : ` (Ojo: los umbrales de relevancia no están medidos para el modelo de embeddings que está corriendo, «${calibration.modelId}», así que este juicio sobre qué es relevante y qué no es poco de fiar. No afirmes con seguridad que no hay nada.)`;

  if (degraded) {
    return {
      coverage: 'keyword-only',
      summary:
        kept.length > 0
          ? `Ojo: no pude buscar por significado (el servicio de embeddings no respondió), así que esto es solo coincidencia literal de palabras ${where}. Puede haber material relevante que no aparezca aquí.`
          : `No pude buscar por significado (el servicio de embeddings no respondió) y la búsqueda por palabras exactas no encontró nada ${where}. Esto NO quiere decir que no haya nada guardado: dilo así y no des por hecho que el tema no está.`,
      kept,
      discarded,
      bestScore,
      calibration,
    };
  }

  const strong = kept.filter((k) => k.relevance === 'strong').length;
  if (strong > 0) {
    return {
      coverage: 'answered',
      summary: `Encontré material que responde a esto ${where}. Cita solo lo que aparece abajo.${caveat}`,
      kept,
      discarded,
      bestScore,
      calibration,
    };
  }

  if (kept.length > 0) {
    return {
      coverage: 'thin',
      summary: `No hay nada ${where} que responda directamente a "${query}". Lo que sigue es material apenas relacionado: dilo con esas palabras — que tienes algo tangencial y que quien pregunta mire a ver si le sirve — y no lo presentes como la respuesta.${caveat}`,
      kept,
      discarded,
      bestScore,
      calibration,
    };
  }

  return {
    coverage: 'nothing',
    summary: `No hay nada ${where} sobre "${query}". Dilo tal cual: que en Brain Knowledge no hay nada guardado sobre eso. Es una respuesta legítima y útil — mucho mejor que responder con lo más parecido que había. Si sabes la respuesta por fuera del conocimiento de la empresa, puedes darla, pero aclara que no viene de Brain Knowledge.${caveat}`,
    kept,
    discarded,
    bestScore,
    calibration,
  };
}
