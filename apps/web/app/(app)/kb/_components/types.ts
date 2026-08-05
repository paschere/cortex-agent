/**
 * Plain shapes shared between the server page and the client components.
 *
 * Nothing in here may import `@cortex/agent-tools`: a client component that
 * pulls that package in drags node:crypto, node:dns and pdf-parse's fs access
 * into the browser bundle and breaks the production build. The server resolves
 * everything and hands down these props.
 */

export type SpaceKind = 'global' | 'personal';

/**
 * Where a document is in the cycle that turns a file into something Cortex can
 * recall. These are the four states the page is built around — the database's
 * `status`/`transcript_status` pair collapsed into the only distinction a
 * person cares about: is it in yet, is it being worked on, can it be recalled,
 * did it break.
 */
export type DigestStage = 'waiting' | 'digesting' | 'memory' | 'stuck';

/** The four ways memory gets in. */
export type IntakeKey = 'upload' | 'record' | 'meeting' | 'drive';

/** How many documents arrived through each intake. */
export interface IntakeCounts {
  upload: number;
  record: number;
  meeting: number;
  drive: number;
}

/** Documents by stage, in one place because they are always read together. */
export interface StageCounts {
  waiting: number;
  digesting: number;
  memory: number;
  stuck: number;
}

/** One document currently being worked on, named so the wait has a subject. */
export interface DigestingDoc {
  id: string;
  title: string;
  spaceName: string;
  stage: DigestStage;
  /** True while a recording is being transcribed rather than merely indexed. */
  transcribing: boolean;
}

/** Documents that entered in one calendar week. `start` is a Monday, ISO. */
export interface WeekPoint {
  start: string;
  added: number;
}

/**
 * The same reading, kept for one source only.
 *
 * Why it exists: the plate is a control, and choosing a lobe narrows the rest
 * of the page to that source. Every figure below has to be re-counted for the
 * chosen source, and re-counting it in the browser from a total is impossible —
 * so the server, which is already walking every row, keeps four running
 * tallies as it goes. No extra query.
 *
 * Fragments are missing on purpose: they are counted with a join on spaces, not
 * on sources, so there is no honest per-source figure and the panel prints
 * nothing rather than a number it cannot stand behind.
 */
export interface SourceStats {
  stages: StageCounts;
  growth: WeekPoint[];
  spokenSeconds: number;
  namedVoices: number;
  unnamedRecordings: number;
  lastAddedAt: string | null;
  digesting: DigestingDoc[];
}

/**
 * What this brain knows, in figures that come from rows and nothing else.
 *
 * `chunks` is null when the count could not be read — the page then leaves the
 * figure out rather than showing a zero it cannot stand behind.
 */
export interface BrainStats {
  stages: StageCounts;
  intake: IntakeCounts;
  /** The same four sources, counting only what is already indexed. */
  indexed: IntakeCounts;
  /** The last twelve weeks, oldest first. Empty weeks are present as zeroes. */
  growth: WeekPoint[];
  /** Retrievable fragments across every space the viewer can see. */
  chunks: number | null;
  /** Seconds of recording and meeting audio that have been digested. */
  spokenSeconds: number;
  /** Speakers known by name, from meeting participants and renamed voices. */
  namedVoices: number;
  /** Spoken documents whose voices are still "Speaker 1", "Speaker 2"… */
  unnamedRecordings: number;
  lastAddedAt: string | null;
  digesting: DigestingDoc[];
  /** The same reading again, split four ways, so a lobe can narrow the page. */
  bySource: Record<IntakeKey, SourceStats>;
}

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
  /** Retrievable fragments in this space; null when the count is unavailable. */
  chunkCount: number | null;
  /** Seconds of digested audio filed here. */
  spokenSeconds: number;
  intake: IntakeCounts;
}

export interface SearchResult {
  documentId: string;
  documentTitle: string;
  space: string;
  spaceId: string;
  spaceKind: SpaceKind;
  chunkIndex: number;
  content: string;
  score: number;
  /**
   * Which mouth the document came in through. Carried so a hit can be shown
   * where it lives — lit on the plate and on the ring — before anything is
   * opened. Read off the document row, never guessed from the space.
   */
  source: IntakeKey;
}

/**
 * Every action returns this instead of throwing. A thrown server action reaches
 * the browser as an opaque "an error occurred" in production, and someone who
 * has just tried to move a document needs to be told why it stayed put.
 */
export type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** The same contract for actions that have nothing to report on success. */
export type SimpleActionResult = { ok: true } | { ok: false; error: string };
