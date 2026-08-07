/**
 * The measurement, frozen: every cosine the suite needs, taken from the live
 * API on a stated day and committed to the repository.
 *
 * WHY A FIXTURE EXISTS AT ALL. The three failures this package was written
 * after were all invisible to typecheck, to the tests and to the build, and all
 * three were changes somebody made in an afternoon. An evaluation that only
 * runs when someone remembers to run it, with a key, against a paid API, would
 * have been just as invisible. So the expensive half — turning text into
 * vectors — is done once and stored, and the cheap half — ordering, cutting,
 * judging coverage, ranking families — is replayed from the stored numbers on
 * every `pnpm test`, for free, in about a second.
 *
 * WHAT THAT BUYS, PRECISELY. Everything downstream of the vectors is under
 * continuous test: move `STRONG_MATCH`, change `assessCoverage`, change how a
 * verdict becomes a sentence, retune `FAMILY_BAND`, rewrite a tool description,
 * and the number moves in CI before the change is merged. That is exactly the
 * surface the threshold bug lived on.
 *
 * WHAT IT DOES NOT BUY, AND THIS MUST NOT BE FUDGED. A stored cosine cannot
 * notice that the embedding model changed, because it IS the old model. So the
 * fixture is keyed by the provider-qualified model id, and a deployment whose
 * `embeddingModelId()` has no fixture does not fall back and does not warn — it
 * FAILS, loudly, the same way `relevance-calibration.test.ts` fails a model
 * with no measured thresholds. The whole class of bug here is a number
 * calibrated against one model still being applied after somebody swapped the
 * model, and a fixture that shrugged would be one more instance of it.
 *
 * WHY COSINES AND NOT VECTORS. A 1024-float vector per chunk and per query
 * would be about two megabytes of JSON in git for information the replay never
 * uses: nothing downstream of retrieval needs the coordinates, only the
 * similarity. Storing the similarity is also what makes the fixture readable —
 * a person can open it and see that "receta de ajiaco" tops out at 0.19.
 *
 * WHAT THE REPLAY IS NOT. It is semantic-only. The production SQL ranks on a
 * 0.7/0.3 blend with `ts_rank`, which cannot be recomputed outside Postgres.
 * That is a smaller loss than it sounds: `kb/relevance.ts` establishes that the
 * blend is a good ORDER and a meaningless MAGNITUDE, and every threshold in
 * this system is on the cosine. The blend affects which of two documents comes
 * back first, not whether anything survives the floor — and it is what the live
 * tier and `search-model-isolation.test.ts` cover. Said out loud here so that
 * nobody reads `grounding: 1.00` as a claim about the SQL.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One chunk of the corpus, as the real `chunkText` produced it. */
export interface FixtureChunk {
  documentId: string;
  chunkIndex: number;
  tokens: number;
  /** First words of the chunk, so the file can be read by a person. */
  preview: string;
}

export interface FixtureTool {
  /**
   * Hash of `toolEmbedText(tool)` on the day of the measurement. A tool whose
   * description has since been edited is STALE: its stored cosine describes a
   * sentence that is no longer in the catalogue. The grader reports those
   * rather than silently scoring them.
   */
  textHash: string;
  family: string;
  /** Cosine against each suite query, keyed by the query string. */
  scores: Record<string, number>;
}

export interface VectorFixture {
  /** Provider-qualified, exactly as `embeddingModelId()` returns it. */
  modelId: string;
  /** ISO date the live API was called. */
  measuredOn: string;
  /** `suiteDigest()` at measurement time. A mismatch means the questions moved. */
  suiteDigest: string;
  /** Tokens the provider charged for, and what that cost in USD. */
  usage: { tokens: number; usd: number };
  chunks: FixtureChunk[];
  /** Per query: one cosine per entry of `chunks`, in the same order. */
  queries: Record<string, number[]>;
  tools: Record<string, FixtureTool>;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where a model's measurement lives. One file per model, named after it. */
export function fixturePath(modelId: string): string {
  return join(HERE, 'fixtures', `${modelId.replaceAll(/[^a-z0-9.-]/gi, '-')}.json`);
}

export class UnmeasuredModelError extends Error {
  constructor(readonly modelId: string) {
    super(
      `No hay medición de evaluación para el modelo de embeddings «${modelId}». ` +
        `La evaluación continua compara contra cosenos medidos contra la API real, y los de otro modelo no son comparables — son coordenadas de otro espacio. ` +
        `Corre la medición con EVAL_MEASURE=1 (necesita la llave del proveedor) y súbela en ${fixturePath(modelId)}.`,
    );
    this.name = 'UnmeasuredModelError';
  }
}

/**
 * Read the measurement for a model, or refuse.
 *
 * Deliberately synchronous and deliberately without a cache: it is one small
 * file read at the top of a test run, and a cache here would be one more place
 * where a stale measurement outlives the thing it measured.
 */
export function loadFixture(modelId: string): VectorFixture {
  let raw: string;
  try {
    raw = readFileSync(fixturePath(modelId), 'utf8');
  } catch {
    throw new UnmeasuredModelError(modelId);
  }
  const fixture = JSON.parse(raw) as VectorFixture;
  if (fixture.modelId !== modelId) {
    throw new Error(
      `El archivo de medición ${fixturePath(modelId)} dice ser de «${fixture.modelId}» y se pidió «${modelId}». Alguien renombró el archivo en vez de volver a medir.`,
    );
  }
  return fixture;
}

/**
 * Whether a fixture still describes the questions being asked.
 *
 * Returned as a sentence rather than a boolean because the only useful thing to
 * do with a stale fixture is tell somebody which half moved — the corpus, the
 * questions, or the tool catalogue — and `false` says none of that.
 */
export function fixtureDrift(fixture: VectorFixture, digest: string, queries: string[]): string[] {
  const drift: string[] = [];
  if (fixture.suiteDigest !== digest) {
    drift.push(
      `El conjunto de preguntas o el corpus cambiaron desde la medición del ${fixture.measuredOn} (huella ${fixture.suiteDigest} contra ${digest}). Vuelve a medir con EVAL_MEASURE=1.`,
    );
  }
  const missing = queries.filter((q) => !fixture.queries[q]);
  if (missing.length > 0) {
    drift.push(
      `${missing.length} pregunta(s) no están en la medición y no se pueden calificar sin volver a medir: ${missing.slice(0, 3).map((q) => `«${q}»`).join(', ')}${missing.length > 3 ? '…' : ''}.`,
    );
  }
  return drift;
}
