/**
 * The pure half of tool selection: no database, no network, no clock.
 *
 * Everything here is a function of (candidate list, query vector, stored
 * vectors). That separation exists so the interesting decisions — how many
 * families survive, what happens to a tool nobody has embedded yet — are
 * testable without a Supabase double or an HTTP mock.
 */

import {
  DEFAULT_EMBEDDING_PROVIDER,
  EMBEDDING_PROVIDERS,
  qualifyModel,
} from '../kb/embedding-providers';
import { familyOf } from '../security/policy';

/**
 * The minimum a caller has to say about a tool for it to be rankable.
 *
 * `family` is optional because for registry tools it is simply the part of the
 * id before the dot. It is a real field because external MCP tools have no dot
 * in their name and their natural grouping is the SERVER they came from — one
 * connected server is one family, exactly like `hubspot` is one family.
 */
export interface SelectableTool {
  id: string;
  description: string;
  family?: string;
}

export function toolFamily(tool: SelectableTool): string {
  return tool.family ?? familyOf(tool.id);
}

/**
 * The text that actually gets embedded.
 *
 * Descriptions alone are not enough. Some are two words ("Send an email"), some
 * are a paragraph, and MCP servers we do not control write whatever they like.
 * Folding in the family and the action words from the id gives even the worst
 * description something to match on: `vehicles.lookup_plate` contributes
 * "vehicles lookup plate" whether or not its author wrote a sentence. The id is
 * included verbatim too, so a user who literally names a tool still hits it.
 *
 * Capped because a runaway description from a third-party server should cost
 * one truncated embedding, not a rejected batch.
 */
const MAX_EMBED_CHARS = 4_000;

export function toolEmbedText(tool: SelectableTool): string {
  const family = toolFamily(tool);
  const dot = tool.id.indexOf('.');
  const action = (dot === -1 ? tool.id : tool.id.slice(dot + 1)).replaceAll(/[._-]/g, ' ');
  const words = `${family} ${action}`.trim();
  return `${words} (${tool.id}): ${tool.description}`.slice(0, MAX_EMBED_CHARS);
}

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/**
 * Below this many candidates there is nothing to gain: the model handles a few
 * dozen declarations fine, and skipping selection here is what keeps the added
 * embedding round-trip off small deployments entirely. Same number the old
 * regex filter used, kept so this change alters behaviour for exactly the
 * deployments the old one was already filtering.
 */
export const SELECTION_THRESHOLD = 40;

/* ---------------------------------------------------------------------------
 * THE TWO CUTS, PER EMBEDDING MODEL — and why they cannot be constants.
 *
 * WHAT WENT WRONG. `MIN_FAMILY_SCORE` was a bare `0.3`, justified in a comment
 * with "Voyage query/document pairs land around 0.2–0.35 for unrelated text and
 * 0.45+ for a real match, so this sits just above the noise". Both figures were
 * measured against `voyage-3-large`. Migration 0074 moved the default model to
 * `voyage-4-lite` and nothing here noticed, because nothing here NAMED a model —
 * the same orphaning that `kb/relevance.ts` was recalibrated for, in the other
 * module of this system that also thresholds a cosine.
 *
 * WHAT IT COST, MEASURED. The continuous evaluation
 * (`packages/agent-tools/src/evaluation`, fixture of 2026-08-07) embedded the
 * whole catalogue and five real requests against voyage-4-lite: 635 tool/query
 * cosines. Nothing in the entire set reaches 0.45. The distribution:
 *
 *     min     p25     median  p75     p90     p99     max
 *    -0.066   0.053   0.101   0.152   0.213   0.323   0.416
 *
 * The maximum, 0.416, is a licence-plate lookup against `vehicles.get` — as
 * unambiguous a match as the catalogue contains. So a floor written to sit above
 * the noise was sitting INSIDE the signal, and it showed:
 *
 *   · "mandale un correo a daniela con el resumen de la reunion" scored `gmail`
 *     0.291 and `outlook` 0.292 against a floor of 0.30, so NO mail family
 *     reached the model on a request that says "send an email". That is exactly
 *     the "no puedo ayudarte con eso" failure, in production, today.
 *   · "que soat se me vence este mes" kept only `commitments`, dropping the
 *     second family at 0.265.
 *
 * WHERE THE FLOOR GOES NOW, AND WHY THAT NUMBER. Between the two things that
 * were actually measured: the top of the noise (p90 = 0.213 over those 635
 * pairs) and the lowest family the suite names as a correct answer (`gmail` at
 * 0.291). 0.25 sits between them with ~0.04 of margin on each side.
 *
 * The margin is the point, and it is the lesson of the relevance cut written
 * down here so it is not repeated: a threshold placed to just clear today's
 * failing case — 0.28 would have cleared `gmail` by 0.011 — is a threshold that
 * fails again the next time anything moves. The relevance cut was set with 0.029
 * of margin against an effect worth 0.03, and it broke on the first corpus of
 * realistic length. So the floor is placed at the middle of the measured gap,
 * not at the edge of the case that hurts.
 *
 * WHICH DIRECTION TO ERR, WHEN IN DOUBT. Low. A floor set too high makes a
 * capability VANISH and produces a confident "I don't have access to that" — the
 * vehicles incident, and the reason this module exists. A floor set too low
 * costs a handful of extra tool declarations on a turn that did not need them.
 * Those are not comparable risks, and `uncalibratedSelection` below is built on
 * that asymmetry.
 *
 * WHAT IS DELIBERATELY NOT FIXED HERE. "cual es el correo de daniela rios" still
 * does not reach `people`: `people.search` scores 0.177 while `clients.register`
 * scores 0.233 and five other families sit between them. No floor rescues that —
 * the family is seventh of twenty-five on a flat distribution, and it is
 * `MAX_FAMILIES` that stops it, correctly, because a flat distribution means
 * nothing matched well and the answer to that is not to send more tools. That is
 * a tool DESCRIPTION defect, not a threshold defect, and moving a cut until it
 * passes would hide it. It is left failing in the evaluation, on the record.
 * ------------------------------------------------------------------------- */

/**
 * The two scale-dependent numbers of family selection, for exactly one embedding
 * model. `maxFamilies` is not here on purpose: it is a count of declarations the
 * chat model can handle, which no embedding model changes.
 */
export interface SelectionCalibration {
  /** Provider-qualified, exactly as `embeddingModelId()` returns it. */
  modelId: string;
  /**
   * A floor for families 2..N only — see `selectFamilies` for why the top family
   * is exempt. Below this a score is indistinguishable from noise on this
   * model's scale.
   */
  minFamilyScore: number;
  /**
   * How far below the best-matching family a family may score and still be sent.
   * A band rather than a fixed K: "email the three people on the Acme deal and
   * put it on the calendar" legitimately wants three families, "what's on my
   * calendar" wants one, and a constant would be wrong for both. It is a cosine
   * DISTANCE, so it is as model-dependent as the floor: 0.06 of a scale that
   * tops out at 0.42 is not 0.06 of one that tops out at 0.63.
   */
  familyBand: number;
  /** False when nobody has run the evaluation against this model. */
  measured: boolean;
  /** ISO date of the measurement, or null when there is none. */
  measuredOn: string | null;
  /** One line, in Colombian Spanish, for whoever is reading a selection log. */
  note: string;
}

/**
 * Every model whose selection cuts come from running the evaluation suite.
 * Adding a model here without measuring it is the bug this block is about, so
 * `__tests__/selection-calibration.test.ts` fails the build when a provider's
 * default model appears in neither this map nor `AWAITING_SELECTION_MEASUREMENT`.
 */
export const SELECTION_CALIBRATIONS: Readonly<Record<string, SelectionCalibration>> = {
  'voyage:voyage-4-lite': {
    modelId: 'voyage:voyage-4-lite',
    minFamilyScore: 0.25,
    familyBand: 0.06,
    measured: true,
    measuredOn: '2026-08-07',
    note: 'Medido el 7 de agosto de 2026 con la evaluación continua: 635 cosenos herramienta/consulta contra la API real. El ruido llega hasta 0,213 y la familia correcta más baja que la suite exige es gmail en 0,291; el piso queda en la mitad de esa franja.',
  },
};

/**
 * Models this deployment can be switched to with one environment variable and
 * whose selection cuts NOBODY HAS MEASURED.
 *
 * `voyage-3-large` is on this list and that deserves a sentence, because the
 * retired `0.3` came from it. It was never measured against a corpus: it was a
 * remembered range in a comment, which is precisely how it survived a model
 * change without anybody noticing. Restating it here as a measurement would
 * launder a guess into evidence, so it is listed as unmeasured like the rest —
 * even though it is the one model the old number was at least aimed at.
 */
export const AWAITING_SELECTION_MEASUREMENT: Readonly<Record<string, string>> = {
  'voyage:voyage-3-large':
    'El piso viejo de 0,30 venía de este modelo, pero nunca se midió contra un corpus: era un rango recordado en un comentario. Si hay que volver a él, córrele la evaluación (EVAL_MEASURE=1) y anota el resultado acá.',
  'openai:text-embedding-3-small':
    'No hay clave de OpenAI en este despliegue, así que no se pudo medir. Mídelo antes de mover EMBEDDING_PROVIDER a openai.',
  'google:gemini-embedding-001':
    'La clave de Google existe, pero es la salida de emergencia y no la hemos medido. Si hay que usarla de verdad, córrele la evaluación primero.',
  'cohere:embed-multilingual-v3.0':
    'No hay clave de Cohere en este despliegue. Mídelo antes de mover EMBEDDING_PROVIDER a cohere.',
};

/**
 * What to do about a model nobody has measured.
 *
 * IT LEANS PERMISSIVE, DELIBERATELY, AND FURTHER THAN ANY MEASURED FLOOR. The
 * two ways to be wrong are not symmetric: a floor too high on an unknown scale
 * makes granted capabilities disappear and the model report that it cannot do
 * them — silent, untraceable, and the exact incident this module was built
 * after. A floor too low costs a few extra declarations on one turn. So an
 * unmeasured model gets a floor below every measured one, and `measured: false`
 * so a selection log can say the cut is a guess.
 */
export function uncalibratedSelection(modelId: string): SelectionCalibration {
  return {
    modelId,
    minFamilyScore: 0.15,
    familyBand: 0.06,
    measured: false,
    measuredOn: null,
    note: `Nadie ha medido los cortes de selección de herramientas para «${modelId}». El piso que se está usando es deliberadamente bajo —es preferible ofrecer familias de más que esconder una que sí servía— pero es un margen provisional. Hay que correr la evaluación continua y añadir el modelo a SELECTION_CALIBRATIONS en tool-selection/rank.ts.`,
  };
}

/** The model this deployment embeds with when nothing overrides it. */
export const DEFAULT_SELECTION_MODEL_ID = qualifyModel(
  DEFAULT_EMBEDDING_PROVIDER,
  EMBEDDING_PROVIDERS[DEFAULT_EMBEDDING_PROVIDER].defaultModel,
);

/**
 * The only way to get a pair of selection cuts. Never returns null and never
 * falls back to another model's numbers: a cosine from one model read against
 * another's cuts is not approximately right, it is unrelated.
 */
export function selectionCalibrationFor(modelId: string | null | undefined): SelectionCalibration {
  if (!modelId)
    return (
      SELECTION_CALIBRATIONS[DEFAULT_SELECTION_MODEL_ID] ??
      uncalibratedSelection(DEFAULT_SELECTION_MODEL_ID)
    );
  return SELECTION_CALIBRATIONS[modelId] ?? uncalibratedSelection(modelId);
}

/** The calibration of the model this deployment is configured to use. */
export const DEFAULT_SELECTION_CALIBRATION: SelectionCalibration = selectionCalibrationFor(
  DEFAULT_SELECTION_MODEL_ID,
);

/** Ceiling on situational families, so a vague request cannot re-expand to everything. */
const MAX_FAMILIES = 6;

/**
 * If selection ever produced fewer tools than this, something is wrong with the
 * catalogue rather than with the request, and a near-empty toolset is the one
 * outcome that must not reach the model. Inherited from the old `scopeTools`.
 */
const MIN_TOOLS = 10;

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Voyage returns unit vectors and the embedder re-normalises defensively, so a
 * dot product IS the cosine. Guarded anyway: a vector read back from Postgres
 * has been through a text round-trip, and a wrong-length row must score as "no
 * information" rather than throw mid-turn.
 */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return dot;
}

export interface RankInput<T extends SelectableTool> {
  tools: T[];
  queryVector: readonly number[];
  /** Vector per tool id. A tool missing from this map has never been embedded. */
  vectors: ReadonlyMap<string, readonly number[]>;
  /** Families sent on every turn, whatever the request is about. */
  alwaysFamilies: ReadonlySet<string>;
  /**
   * The cuts to apply, which belong to the model that produced BOTH vectors
   * above. Optional so that a caller which has not thought about it still gets
   * the configured model's measured cuts rather than a constant — but pass it
   * when you know, which `selectToolsForTurn` does.
   */
  calibration?: SelectionCalibration;
}

export interface RankResult<T> {
  tools: T[];
  /** Situational families that made the cut, best first. Logged, never shown. */
  selectedFamilies: string[];
  /** Families included only because nothing has embedded them yet. */
  unrankedFamilies: string[];
  /**
   * Every family that was scored, and what it scored — the losers included.
   *
   * This was already being computed and thrown away. It is now returned because
   * "why was this tool offered, and what nearly was" is unanswerable afterwards
   * in principle: the query vector is not kept, and a tool's vector is
   * re-embedded the moment somebody edits its description. Reconstructing the
   * ranking later would produce today's ranking for yesterday's question.
   *
   * Best first. Purely informational — nothing in selection reads it back.
   */
  familyScores: Array<{ family: string; score: number }>;
}

/**
 * Rank tools, then promote whole families.
 *
 * WHY FAMILIES AND NOT TOOLS. Scoring is per tool because that is where the
 * descriptions are, but shipping `hubspot.get_deal` without
 * `hubspot.update_deal` is worse than shipping neither: the model sees it can
 * read a deal, tries to change one, finds nothing, and tells the user the CRM
 * is read-only. A family is the unit a person thinks in ("can it do HubSpot?"),
 * so it is the unit that travels.
 */
export function rankTools<T extends SelectableTool>(input: RankInput<T>): RankResult<T> {
  const { tools, queryVector, vectors, alwaysFamilies } = input;
  const calibration = input.calibration ?? DEFAULT_SELECTION_CALIBRATION;

  const scoreByFamily = new Map<string, number>();
  const unranked = new Set<string>();

  for (const tool of tools) {
    const family = toolFamily(tool);
    if (alwaysFamilies.has(family)) continue;
    const vector = vectors.get(tool.id);
    if (!vector) {
      // THE WHOLE POINT OF THIS MODULE. A tool nobody has embedded yet — a
      // family that shipped an hour ago, an MCP server connected this
      // afternoon — is INCLUDED, not dropped. Being unrankable is a fact about
      // our index, never a statement about the user's request, and the failure
      // it would otherwise cause is invisible: the model simply reports it
      // cannot do the thing. The backfill makes this state last one turn.
      unranked.add(family);
      continue;
    }
    const score = cosine(queryVector, vector);
    const best = scoreByFamily.get(family);
    // Max, not mean: one tool that clearly answers the request makes the whole
    // family relevant, and averaging lets a large family hide its best member.
    if (best === undefined || score > best) scoreByFamily.set(family, score);
  }

  const selected = selectFamilies(scoreByFamily, calibration);
  const keep = new Set<string>([...alwaysFamilies, ...unranked, ...selected]);
  const scoped = tools.filter((t) => keep.has(toolFamily(t)));

  return {
    tools: scoped.length >= MIN_TOOLS ? scoped : tools,
    selectedFamilies: selected,
    unrankedFamilies: [...unranked],
    familyScores: [...scoreByFamily.entries()]
      .map(([family, score]) => ({ family, score }))
      .sort((a, b) => b.score - a.score),
  };
}

/**
 * Turn family scores into the families that travel.
 *
 * The top family is taken UNCONDITIONALLY, even when it scores below the floor.
 * That is deliberate and it is the lesson of the vehicles incident: a threshold
 * that is slightly too high does not degrade gracefully, it makes a capability
 * vanish and produces a confident "I don't have access to that". The cost of
 * being wrong the other way is one extra family — a handful of declarations —
 * on a turn that did not need it. Those are not comparable risks.
 *
 * Everything after the first has to clear both the floor and the band, which is
 * what keeps "hola" from dragging in six families on noise.
 *
 * Both of those are cosine distances on a scale the embedding model chooses for
 * itself, so they arrive as a calibration rather than as constants — see the
 * block above `SelectionCalibration` for the turn on which that mattered.
 */
function selectFamilies(
  scores: ReadonlyMap<string, number>,
  calibration: SelectionCalibration,
): string[] {
  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const top = ordered[0];
  if (!top) return [];
  const cutoff = Math.max(calibration.minFamilyScore, top[1] - calibration.familyBand);
  const picked = [top[0]];
  for (const [family, score] of ordered.slice(1)) {
    if (picked.length >= MAX_FAMILIES) break;
    if (score < cutoff) break;
    picked.push(family);
  }
  return picked;
}
