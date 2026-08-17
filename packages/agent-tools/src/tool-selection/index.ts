/**
 * Which tools a turn gets, decided by meaning instead of by hand.
 *
 * THE PROBLEM THIS REPLACES. Past ~40 function declarations the model's tool
 * choice measurably degrades, so the catalogue has to be narrowed per turn.
 * That narrowing used to be a hand-written regex per family in the chat route.
 * Every regex was correct on the day it was written, and the list was wrong
 * within a release: `vehicles` shipped registered, granted, and matched by no
 * pattern — so it was filtered out of every request and the model truthfully
 * answered that it had no access to the RUNT. Nothing errored. `meetings`,
 * `inbox`, `chat` and `security` were in the same state when this was written.
 *
 * And the list could never have been complete anyway. Cortex lets a user
 * connect their own MCP server from /integrations; those tools appear between
 * one turn and the next, on one user's account, with names nobody has ever
 * seen. There is no regex to write for them. They were born invisible, always.
 *
 * THE RULE NOW. Compare what the person is asking for against what each tool
 * says it does — the same embeddings Brain Knowledge already runs on — and keep
 * the families that match. A family that does not exist yet is handled by the
 * same code path as one that does, because there is no list to be absent from.
 *
 * FAILURE IS ALWAYS OPEN. Voyage down, no API key, table unreachable, a tool
 * nobody has embedded yet: every one of those returns MORE tools, never fewer.
 * The worst outcome of this module is the behaviour we had before it existed.
 * The one outcome it must never produce is a model that quietly cannot do
 * something it was granted.
 *
 * COST. One `embedQuery` per turn — a single request of a few dozen tokens,
 * ~100ms and a rounding error in cents — and only on deployments that were
 * already being filtered (>40 candidates). The vector lookup runs in parallel
 * with it and is a cache hit on any warm instance, so it adds nothing.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { embedQuery, embeddingModelId } from '../kb/embedder';
import {
  SELECTION_THRESHOLD,
  type SelectableTool,
  rankTools,
  selectionCalibrationFor,
} from './rank';
import { backfillToolVectors, prepareToolVectors } from './store';

export {
  type SelectableTool,
  type SelectionCalibration,
  SELECTION_THRESHOLD,
  SELECTION_CALIBRATIONS,
  AWAITING_SELECTION_MEASUREMENT,
  DEFAULT_SELECTION_CALIBRATION,
  DEFAULT_SELECTION_MODEL_ID,
  selectionCalibrationFor,
  uncalibratedSelection,
  toolEmbedText,
  toolFamily,
  rankTools,
  cosine,
} from './rank';
export { resetToolVectorCache, TOOL_EMBEDDINGS_TABLE } from './store';
export {
  type StickyCombineInput,
  type StickyCombineResult,
  STICKY_TOOL_BUDGET,
  combineStickySelection,
} from './sticky';
export {
  type SaveStickyToolIdsInput,
  loadStickyToolIds,
  saveStickyToolIds,
} from './sticky-store';

/**
 * Families that make sense on any turn and are therefore never ranked.
 *
 * `kb` and `cortex` are how Cortex remembers and how it recalls; `web` is the
 * fallback for anything it does not have an integration for; `schedule` turns
 * any answer into a routine; `pipeline` and `format` are shaping, not subject
 * matter. Keeping them out of the ranking also means a greeting still arrives
 * with a working assistant attached rather than a bare model.
 *
 * A name here that matches no family is simply inert — this is an allow-list
 * for what already exists, never a declaration that it does. That is the
 * property the old CORE_FAMILIES/FAMILY_TRIGGERS pair did not have.
 */
export const BASE_FAMILIES: readonly string[] = [
  'kb',
  'cortex',
  'web',
  'pipeline',
  'schedule',
  'format',
  /**
   * Una sola herramienta, `attachments.promote`, y está aquí por lo que le pasa
   * si NO está.
   *
   * Sólo tiene sentido en un turno que lleva un adjunto encima, así que la
   * tentación es dejar que el ranking la traiga cuando haga falta. El problema
   * es que la frase que la necesita es «guárdalo», «que quede en el cerebro»,
   * «déjalo ahí» — pronombres, sin una palabra que se parezca a «attachments
   * promote» ni a nada de su descripción. Contra el resto del catálogo eso
   * puntúa como ruido, y el turno en que el ranking la deja fuera es
   * exactamente el turno en que alguien la pidió: el modelo contesta que sí,
   * no llama a nada, y el archivo se borra solo a la semana.
   *
   * El costo del otro lado es una definición de herramienta en el prefijo del
   * catálogo, que además está antes del breakpoint del caché. Es barato y es
   * fijo; el fallo que evita es silencioso y no lo ve nadie.
   */
  'attachments',
];

export type SelectionReason =
  /** Few enough tools that narrowing buys nothing — everything was sent. */
  | 'below-threshold'
  /** Nothing to match against; the full catalogue was sent. */
  | 'no-query'
  /** Voyage could not embed the request; the full catalogue was sent. */
  | 'embedding-unavailable'
  /** Narrowed by meaning. */
  | 'semantic';

export interface ToolSelectionRequest<T extends SelectableTool> {
  db: SupabaseClient;
  /** Every tool the user is actually allowed to call this turn. */
  tools: T[];
  /** What the person is asking for — typically the last few user messages. */
  query: string;
  /** Overrides BASE_FAMILIES. Pass to add a surface-specific always-on family. */
  alwaysFamilies?: readonly string[];
}

export interface ToolSelectionResult<T> {
  /** The tools to hand the model. Never empty unless `tools` was. */
  tools: T[];
  reason: SelectionReason;
  /** Situational families that matched, best first. For logs. */
  selectedFamilies: string[];
  /** Families included because they are not indexed yet. For logs. */
  unrankedFamilies: string[];
  /**
   * What every scored family scored, best first — including the ones that lost.
   * Empty whenever ranking did not run (see `reason`). Carried so a turn can
   * record why it was offered what it was; nothing in selection reads it back.
   */
  familyScores: Array<{ family: string; score: number }>;
  /** The always-on families this call used, so a capture need not guess them. */
  alwaysFamilies: string[];
  /**
   * Resolves when any background embedding this call triggered has finished.
   * Production callers ignore it — the turn must not wait on it. Tests await it.
   */
  indexing: Promise<void>;
}

const DONE = Promise.resolve();

export async function selectToolsForTurn<T extends SelectableTool>(
  request: ToolSelectionRequest<T>,
): Promise<ToolSelectionResult<T>> {
  const { db, tools, query } = request;
  const alwaysFamilies = new Set(request.alwaysFamilies ?? BASE_FAMILIES);

  const everything = (reason: SelectionReason, indexing = DONE): ToolSelectionResult<T> => ({
    tools,
    reason,
    selectedFamilies: [],
    unrankedFamilies: [],
    familyScores: [],
    alwaysFamilies: [...alwaysFamilies],
    indexing,
  });

  // Cheap exits first: neither one is worth an embedding round-trip.
  if (tools.length <= SELECTION_THRESHOLD) return everything('below-threshold');
  if (query.trim().length === 0) return everything('no-query');

  // Deliberately concurrent. The vector lookup is a cache hit on a warm
  // instance and one small SELECT on a cold one; either way it hides entirely
  // behind the embedding call, so selection costs one network round-trip and
  // not two.
  const [prepared, embedded] = await Promise.all([
    prepareToolVectors(db, tools),
    embedQuery(query),
  ]);

  // Started here rather than after the early return below, so a deployment
  // whose Voyage key is momentarily rejected still indexes as soon as it
  // recovers, and a new MCP server is rankable from the very next turn.
  const indexing =
    prepared.stale.length > 0
      ? backfillToolVectors(db, prepared.stale).catch(() => undefined)
      : DONE;

  // Voyage is a third party. Losing it costs relevance, and that is all it may
  // cost: the model keeps every tool it was granted.
  if (!embedded.ok) return everything('embedding-unavailable', indexing);

  const ranked = rankTools({
    tools,
    queryVector: embedded.data,
    vectors: prepared.vectors,
    alwaysFamilies,
    // The cuts belong to the model that produced these vectors, not to whatever
    // the file was written against. Naming it here is what stops migration 0074
    // from happening again: change EMBEDDING_MODEL and the cuts move with it, or
    // the model is openly unmeasured and the floor opens up instead of closing.
    calibration: selectionCalibrationFor(embeddingModelId()),
  });

  return {
    tools: ranked.tools,
    reason: 'semantic',
    selectedFamilies: ranked.selectedFamilies,
    unrankedFamilies: ranked.unrankedFamilies,
    familyScores: ranked.familyScores,
    alwaysFamilies: [...alwaysFamilies],
    indexing,
  };
}
