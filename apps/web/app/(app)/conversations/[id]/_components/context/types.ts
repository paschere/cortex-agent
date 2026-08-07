/**
 * Plain shapes shared between the server page and the client panel.
 *
 * Nothing in here may import `@cortex/agent-tools`. A `'use client'` component
 * that pulls that package in drags `node:dns` and friends into the browser
 * bundle and breaks the production build, while typecheck and the tests stay
 * green because neither one bundles for the browser — that is how it shipped
 * once already. See `apps/web/lib/commitments-shape.ts`.
 *
 * So the server resolves everything (`_lib/turn-context-view.ts`) and hands
 * down these props. Every number here was measured at the moment of the turn;
 * nothing on this side of the boundary computes a score, a share or a verdict.
 */

/** Which slice of the prompt a weight belongs to. */
export type PartKey =
  | 'instructions'
  | 'memory'
  | 'knowledge'
  | 'history'
  | 'tools'
  | 'question';

export interface PartView {
  key: PartKey;
  /** Exact character count of the string that was sent. */
  chars: number;
  /** Estimated from characters. Labelled as an estimate wherever it is shown. */
  tokens: number;
  /** Share of everything measured, 0–1. Exact, because it is on characters. */
  share: number;
}

/** A fragment as this reader may see it. */
export interface FragmentView {
  key: string;
  documentId: string;
  documentTitle: string;
  spaceName: string;
  spaceKind: 'global' | 'personal';
  chunkIndex: number;
  cosine: number | null;
  keyword: number;
  verdict: 'strong' | 'weak' | 'dropped';
  /** True for the fragments that were really pasted above the question. */
  prepended: boolean;
  /** Null when withheld, or when the turn is old enough to have been redacted. */
  excerpt: string | null;
  /** True when the reader may not see the space this came from. */
  withheld: boolean;
}

export interface FamilyView {
  family: string;
  score: number | null;
  offered: boolean;
  reason: 'always' | 'ranked' | 'unindexed' | 'below-cut' | 'muted';
}

/** The rail's three numbers, as they were applied on the turn. */
export interface CutsView {
  modelId: string;
  strongMatch: number;
  weakFloor: number;
  railCeiling: number;
  measured: boolean;
}

/**
 * How long the turn took, and where the time went.
 *
 * Every field is milliseconds, measured on the turn and stored (migration
 * 0084). Nothing here is derived on this page; the stages carry the offset at
 * which they began so two that ran at the same time read as concurrent instead
 * of summing to more than the turn.
 *
 * Null when the turn predates the measurement, which is a different sentence
 * from "it was instant" and the panel says so.
 */
export interface LatencyView {
  /** To the first character on screen — reasoning counts. The headline. */
  firstVisibleMs: number | null;
  /** To the first character of the answer itself. */
  firstAnswerMs: number | null;
  totalMs: number;
  /** Everything Cortex did before the request left for the model. */
  preludeMs: number;
  stages: Array<{ stage: string; at: number; ms: number }>;
  steps: number;
  toolCalls: number;
  toolMs: number;
  /** Model round-trips that read the prompt cache, out of how many. */
  cacheReadSteps: number;
  cacheTokensRead: number;
}

export interface TurnView {
  id: string;
  messageId: string | null;
  createdAt: string;
  model: string;
  /** The provider's own count. The one figure here that is not an estimate. */
  promptTokens: number | null;
  completionTokens: number | null;
  parts: PartView[];
  /** The key of the biggest part, so the page can point at it in words. */
  heaviest: PartKey | null;
  /** Total characters across every part that was measured. */
  totalChars: number;

  retrieval: {
    ran: boolean;
    skipped: string | null;
    query: string;
    coverage: 'answered' | 'thin' | 'nothing' | 'keyword-only';
    summary: string;
    cuts: CutsView;
    limit: number;
    fragments: FragmentView[];
    /** How many really went in, and how many came back at all. */
    prependedCount: number;
    /** Came back, cleared nothing, never shown to the model. */
    droppedCount: number;
  };

  tools: {
    reason: 'below-threshold' | 'no-query' | 'embedding-unavailable' | 'semantic';
    candidates: number;
    offered: string[];
    families: FamilyView[];
  };

  memories: Array<{ id: string; text: string | null }>;

  instructions: {
    chars: number;
    /**
     * Whether the agent's prompt is still the one that was sent. Resolved on
     * the server by comparing the stored fingerprint against the live row —
     * showing today's prompt as if it were the one used would be the exact
     * class of lie this whole surface exists to remove.
     */
    unchanged: boolean | null;
  };

  /** How long it took. Null for turns captured before 0084 existed. */
  latency: LatencyView | null;

  /** A conversation-scoped adjustment was in force on this turn. */
  overridden: boolean;
  /** The quoted material has aged out and been stripped from the row. */
  redacted: boolean;
}

/** The three knobs, as the panel edits them. */
export interface AdjustView {
  fragmentLimit: number | null;
  spaceIds: string[] | null;
  mutedFamilies: string[];
}

export interface SpaceOption {
  id: string;
  name: string;
  kind: 'global' | 'personal';
}

/** What the label reads for each part, in the reader's words. */
export const PART_LABEL: Record<PartKey, string> = {
  instructions: 'Sus instrucciones',
  memory: 'Lo que recuerda de ti',
  knowledge: 'Fragmentos del cerebro',
  history: 'La conversación previa',
  tools: 'Las herramientas ofrecidas',
  question: 'Tu pregunta',
};

/**
 * One line each, said plainly. These exist so that somebody who has never seen
 * this screen can tell what a bar is without being told what RAG is.
 */
export const PART_NOTE: Record<PartKey, string> = {
  instructions: 'El texto fijo que define cómo se comporta este agente.',
  memory: 'Tus instrucciones permanentes. Van completas en cada turno, no se buscan.',
  knowledge: 'Los pedazos de documentos que se le pegaron encima de tu pregunta.',
  history: 'Los mensajes anteriores de esta conversación que se le volvieron a mandar.',
  tools: 'El nombre y la descripción de cada herramienta que se le ofreció.',
  question: 'Lo último que escribiste.',
};

/** Colour per part. Neutral by design: none of these is good or bad news. */
export const PART_FILL: Record<PartKey, string> = {
  instructions: 'bg-ink-faint',
  memory: 'bg-sky',
  knowledge: 'bg-primary',
  history: 'bg-ink-muted',
  tools: 'bg-amber',
  question: 'bg-emerald',
};

export const COVERAGE_LABEL: Record<TurnView['retrieval']['coverage'], string> = {
  answered: 'Encontró algo que respondía',
  thin: 'Solo encontró algo parecido',
  nothing: 'No encontró nada del tema',
  'keyword-only': 'Solo pudo buscar por palabras',
};

export const SELECTION_REASON: Record<TurnView['tools']['reason'], string> = {
  semantic: 'Se escogieron por parecido con lo que estabas pidiendo.',
  'below-threshold': 'Eran pocas, así que se le ofrecieron todas sin filtrar.',
  'no-query': 'No había con qué comparar, así que se le ofrecieron todas.',
  'embedding-unavailable':
    'El servicio que mide el parecido no respondió, así que se le ofrecieron todas. Ante la duda se ofrece de más, nunca de menos.',
};

export const FAMILY_REASON: Record<FamilyView['reason'], string> = {
  always: 'siempre va',
  ranked: 'coincidió',
  unindexed: 'sin indexar todavía — se manda por si acaso',
  'below-cut': 'no alcanzó',
  muted: 'apagada en esta conversación',
};
