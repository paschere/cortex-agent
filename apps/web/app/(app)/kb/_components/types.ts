/**
 * Plain shapes shared between the server page and the client components.
 *
 * Nothing in here may import `@cortex/agent-tools`: a client component that
 * pulls that package in drags node:crypto, node:dns and pdf-parse's fs access
 * into the browser bundle and breaks the production build. The server resolves
 * everything and hands down these props.
 */

export type SpaceKind = 'global' | 'personal';

export interface SpaceSummary {
  id: string;
  name: string;
  kind: SpaceKind;
  description: string | null;
  /** Whose space it is (personal) or who published it (global). */
  ownerName: string | null;
  /** True only for the viewer's own personal spaces. */
  isMine: boolean;
  documentCount: number;
  /** Uploaded but not indexed yet — not searchable until this reaches zero. */
  pendingCount: number;
  failedCount: number;
  lastAddedAt: string | null;
  /** Whether the viewer may add to, move into, or delete this space. */
  canWrite: boolean;
}

export interface SearchResult {
  documentId: string;
  documentTitle: string;
  space: string;
  spaceKind: SpaceKind;
  chunkIndex: number;
  content: string;
  score: number;
}

/**
 * Every action returns this instead of throwing. A thrown server action reaches
 * the browser as an opaque "an error occurred" in production, and someone who
 * has just tried to move a document needs to be told why it stayed put.
 */
export type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** The same contract for actions that have nothing to report on success. */
export type SimpleActionResult = { ok: true } | { ok: false; error: string };
