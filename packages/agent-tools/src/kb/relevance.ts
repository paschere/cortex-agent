/**
 * What a retrieval score means — decided once, in one file.
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
 * on sand — see the measurement below for what that cost. `semanticScore` is
 * the raw cosine similarity between question and passage, it means the same
 * thing from one query to the next, and it is what these thresholds are on.
 * Migration 0066 is what started returning it separately.
 *
 * THE MEASUREMENT. A ten-document corpus of the kind Brain Knowledge actually
 * holds (a client contract and its signed copy, a renegotiation call, vacation
 * and payroll policy, an insurance policy, a recruiting playbook, onboarding,
 * benefits, product notes) was indexed against the production embedder
 * (voyage-3-large, 1024 dims, input_type document), then queried with 21
 * questions in three groups. Top-1 cosine per query:
 *
 *   group                                     min    p25    med    max
 *   ------------------------------------------------------------------
 *   answered by the corpus       (10 queries) 0.582  0.605  0.652  0.694
 *   plausible but not in it       (5 queries) 0.409  0.458  0.475  0.578
 *   nothing to do with it         (6 queries) 0.317  0.349  0.382  0.455
 *
 * The two thresholds fall out of the gaps:
 *
 *   STRONG = 0.55. Every question the corpus answers clears it (worst: 0.582).
 *     Exactly one "not in it" question clears it — "tarifas de un ingeniero de
 *     datos senior" at 0.578, which pulls up the rate card. That is the right
 *     behaviour, not a leak: the rate card IS the document to look at, it
 *     simply has no line for that role, and the model can say so.
 *
 *   WEAK_FLOOR = 0.45, and things below it are not offered as citations. The
 *     unrelated group tops out at 0.455 ("¿podemos traer mascotas a la
 *     oficina?" → the onboarding guide) and the plausible group bottoms out at
 *     0.409, so the two do overlap and no cut is clean. The floor sits at the
 *     low end of that overlap on purpose: one dud arriving labelled "coincidencia
 *     débil" is a smaller failure than four half-relevant answers being
 *     swallowed. Erring the other way is how an assistant learns to say "no sé"
 *     to questions it could have answered, which is worse than the bug this
 *     file exists to fix.
 *
 * WHAT THE OLD NUMBERS WERE DOING. Both thresholds that existed before were on
 * the blend, and on this corpus the blend never exceeded 0.496 for ANY query,
 * including the ten the corpus answers perfectly. `kb.context` cut at 0.55 and
 * the chat route's RAG block cut at 0.65 — so on a corpus with no literal
 * keyword overlap, both were discarding every correct result they were ever
 * given. The KB looked empty. That is the failure this replaces, and it is the
 * reason these thresholds are stated on a measured axis with the measurement
 * written next to them.
 */

/** A passage that answers the question. See the measurement above. */
export const STRONG_MATCH = 0.55;

/** Below this a passage is not offered as a citation at all. */
export const WEAK_FLOOR = 0.45;

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

export interface ScoredHit {
  /** Raw cosine similarity. Null when the semantic arm did not run. */
  semanticScore: number | null;
  /** ts_rank of the literal-word match. Zero for most rows. */
  keywordScore: number;
}

/**
 * How much a single hit is worth. `null` means "do not show this at all" —
 * it is below the floor and offering it would be the original bug.
 *
 * In keyword-only mode there is no cosine to judge, so anything the full-text
 * arm matched at all counts as weak: it literally contains the words asked
 * about, which is evidence, just not graded evidence.
 */
export function rateHit(hit: ScoredHit): HitRelevance | null {
  if (hit.semanticScore === null) return hit.keywordScore > 0 ? 'weak' : null;
  if (hit.semanticScore >= STRONG_MATCH) return 'strong';
  if (hit.semanticScore >= WEAK_FLOOR) return 'weak';
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
}

export interface AssessOptions {
  /** What the person asked, quoted back in the summary. */
  query: string;
  /** Set when the query could not be embedded and only keywords ran. */
  degraded?: boolean;
  /** Where it looked, when it was narrowed to one space. */
  spaceName?: string;
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
  { query, degraded = false, spaceName }: AssessOptions,
): CoverageVerdict<T> {
  const rated = hits.map((hit) => ({ hit, relevance: rateHit(hit) }));
  const kept = rated.filter((r): r is { hit: T; relevance: HitRelevance } => r.relevance !== null);
  const discarded = rated.length - kept.length;
  const scored = hits
    .map((h) => h.semanticScore)
    .filter((s): s is number => s !== null && Number.isFinite(s));
  const bestScore = scored.length > 0 ? Math.max(...scored) : null;

  const where = spaceName ? `en el espacio «${spaceName}»` : 'en Brain Knowledge';

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
    };
  }

  const strong = kept.filter((k) => k.relevance === 'strong').length;
  if (strong > 0) {
    return {
      coverage: 'answered',
      summary: `Encontré material que responde a esto ${where}. Cita solo lo que aparece abajo.`,
      kept,
      discarded,
      bestScore,
    };
  }

  if (kept.length > 0) {
    return {
      coverage: 'thin',
      summary: `No hay nada ${where} que responda directamente a "${query}". Lo que sigue es material apenas relacionado: dilo con esas palabras — que tienes algo tangencial y que quien pregunta mire a ver si le sirve — y no lo presentes como la respuesta.`,
      kept,
      discarded,
      bestScore,
    };
  }

  return {
    coverage: 'nothing',
    summary: `No hay nada ${where} sobre "${query}". Dilo tal cual: que en Brain Knowledge no hay nada guardado sobre eso. Es una respuesta legítima y útil — mucho mejor que responder con lo más parecido que había. Si sabes la respuesta por fuera del conocimiento de la empresa, puedes darla, pero aclara que no viene de Brain Knowledge.`,
    kept,
    discarded,
    bestScore,
  };
}
