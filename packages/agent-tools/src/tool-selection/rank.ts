/**
 * The pure half of tool selection: no database, no network, no clock.
 *
 * Everything here is a function of (candidate list, query vector, stored
 * vectors). That separation exists so the interesting decisions — how many
 * families survive, what happens to a tool nobody has embedded yet — are
 * testable without a Supabase double or an HTTP mock.
 */

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

/**
 * How far below the best-matching family a family may score and still be sent.
 * A band rather than a fixed K: "email the three people on the Acme deal and
 * put it on the calendar" legitimately wants three families, "what's on my
 * calendar" wants one, and a constant would be wrong for both.
 */
const FAMILY_BAND = 0.06;

/**
 * A floor for families 2..N only — see `selectFamilies` for why the top family
 * is exempt. Voyage query/document pairs land around 0.2–0.35 for unrelated
 * text and 0.45+ for a real match, so this sits just above the noise.
 */
const MIN_FAMILY_SCORE = 0.3;

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
}

export interface RankResult<T> {
  tools: T[];
  /** Situational families that made the cut, best first. Logged, never shown. */
  selectedFamilies: string[];
  /** Families included only because nothing has embedded them yet. */
  unrankedFamilies: string[];
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

  const selected = selectFamilies(scoreByFamily);
  const keep = new Set<string>([...alwaysFamilies, ...unranked, ...selected]);
  const scoped = tools.filter((t) => keep.has(toolFamily(t)));

  return {
    tools: scoped.length >= MIN_TOOLS ? scoped : tools,
    selectedFamilies: selected,
    unrankedFamilies: [...unranked],
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
 */
function selectFamilies(scores: ReadonlyMap<string, number>): string[] {
  const ordered = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const top = ordered[0];
  if (!top) return [];
  const cutoff = Math.max(MIN_FAMILY_SCORE, top[1] - FAMILY_BAND);
  const picked = [top[0]];
  for (const [family, score] of ordered.slice(1)) {
    if (picked.length >= MAX_FAMILIES) break;
    if (score < cutoff) break;
    picked.push(family);
  }
  return picked;
}
