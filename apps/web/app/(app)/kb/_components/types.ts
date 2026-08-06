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

/* --------------------------------------------------------------- fragments */

/**
 * Under this many tokens a fragment is a scrap rather than a statement.
 *
 * Six, measured against the chunker's own ruler (words × 1.3), and it must stay
 * equal to the cut in `kb_fragment_health` (migration 0073 § 3). The analysis
 * counts them in SQL and the reader marks them one by one in the browser; if
 * the two numbers came from two different constants, the panel would say four
 * and the document would show five, and there would be no way to tell which was
 * lying. Twelve was tried first and flagged "Los sábados no se hacen despachos"
 * — eight tokens and a perfectly good answer.
 */
export const TINY_FRAGMENT_TOKENS = 6;

/**
 * One fragment, as the reader shows it.
 *
 * This is the unit of memory. A document is what somebody handed over; a
 * fragment is what Cortex actually retrieves and answers with, so everything
 * that judges the quality of the memory judges these.
 */
export interface Fragment {
  chunkId: string;
  /** Its place in the document, zero-based. Printed one-based on screen. */
  chunkIndex: number;
  content: string;
  tokens: number;
  /** How many times it has come back in an answer. Zero means never. */
  retrievalCount: number;
  lastRetrievedAt: string | null;
  /** Present on anything spoken: who is talking, and from when to when. */
  speaker: string | null;
  startMs: number | null;
  endMs: number | null;
  /** Present on a parsed PDF: how many pages the document had. */
  pages: number | null;
  /**
   * True when the text stops without the sentence stopping, and this is not
   * the last fragment. That is the chunker running out of budget somewhere the
   * text offered no break — half a statement here, half next door.
   */
  cutOff: boolean;
}

/**
 * A run of fragments, bucketed, for the ribbon that shows a whole document at
 * once. Bucketed rather than sent one per fragment because a long transcript
 * has thousands and a ribbon only has a few hundred pixels of width.
 */
export interface SpineBucket {
  /** First and last fragment index this bucket covers, inclusive. */
  from: number;
  to: number;
  /** Mean tokens across the bucket — how substantial these fragments are. */
  tokens: number;
  /** Fragments in this run that have never been retrieved. */
  never: number;
  /** Total retrievals across the run. */
  retrievals: number;
}

export interface FragmentPage {
  documentId: string;
  documentTitle: string;
  spaceId: string;
  spaceName: string;
  /** Fragments in the whole document, not in this page. */
  total: number;
  /** Index of the first fragment in `fragments`. */
  from: number;
  fragments: Fragment[];
  /** The whole document at ribbon resolution. Null while it is being read. */
  spine: SpineBucket[];
  /** True when the document is longer than the spine could measure exactly. */
  spineSampled: boolean;
}

/* -------------------------------------------------------------- the bench */

/** What the retrieval decided about one fragment. Mirrors `rateHit`. */
export type FragmentVerdict = 'strong' | 'weak' | 'dropped';

export interface ProbeFragment {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  spaceId: string;
  spaceName: string;
  spaceKind: SpaceKind;
  source: IntakeKey;
  chunkIndex: number;
  content: string;
  /**
   * Raw cosine similarity between the question and the passage — the only
   * number here that means the same thing from one question to the next, and
   * the one the thresholds are set on. Null when the semantic search could not
   * run at all, which is not the same as a similarity of zero.
   */
  cosine: number | null;
  /** ts_rank of the literal-word match. Zero for most fragments. */
  keyword: number;
  /** The 0.7/0.3 blend the database sorts by. Good order, meaningless size. */
  blended: number;
  verdict: FragmentVerdict;
  /** Its age, in words, when the document has a date: "de hace 5 meses". */
  age: string | null;
  freshness: 'current' | 'aging' | 'old' | 'expired' | 'superseded';
  /** `mm:ss` into the recording, on anything spoken. */
  spokenAt: string | null;
  speaker: string | null;
  /** True while this fragment is inside the window Cortex actually receives. */
  inWindow: boolean;
}

/** Two documents of different dates saying almost the same thing. */
export interface ProbeConflict {
  note: string;
  documentTitle: string;
  otherDocumentTitle: string;
  otherSpace: string;
  otherContent: string;
  moreRecent: 'this' | 'other';
  similarity: number;
}

export interface ProbeResult {
  query: string;
  coverage: 'answered' | 'thin' | 'nothing' | 'keyword-only';
  /** The sentence Cortex is handed about its own results, in Spanish. */
  summary: string;
  /** Everything retrieval touched, best first — including what it threw away. */
  fragments: ProbeFragment[];
  /** How many fragments Cortex is allowed to receive for one question. */
  window: number;
  conflicts: ProbeConflict[];
  /** Set when the semantic half could not run and only words were matched. */
  degraded: string | null;
  elapsedMs: number;
  /**
   * The scale these scores were judged on, so the rail is engraved with the
   * cuts that were really applied rather than with a copy that may have drifted.
   * Cosine thresholds are per embedding model — see relevance.ts — and a bench
   * drawing one model's cuts under another model's verdicts is an instrument
   * that lies about the very thing it exists to show.
   */
  scale: ProbeScale;
}

/** The cuts one probe was judged with, and whether anyone ever measured them. */
export interface ProbeScale {
  /** Provider-qualified, e.g. `voyage:voyage-4-lite`. */
  modelId: string;
  strongMatch: number;
  weakFloor: number;
  railCeiling: number;
  /** False when these thresholds are a provisional guess for this model. */
  measured: boolean;
  /** ISO date the corpus was run, or null when it never was. */
  measuredOn: string | null;
  /** One line in Colombian Spanish, worth showing when `measured` is false. */
  note: string;
}

/* ------------------------------------------------------------- the analysis */

/** One fragment in a summary list, truncated. */
export interface FragmentBrief {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  spaceId: string;
  spaceName: string;
  chunkIndex: number;
  tokens: number;
  /** How many byte-identical copies of this text are in the corpus. */
  copies: number;
  retrievalCount: number;
  spoken: boolean;
  content: string;
}

export interface DeadDocument {
  documentId: string;
  documentTitle: string;
  spaceId: string;
  spaceName: string;
  /** Fragments of this document that have never been used to answer. */
  never: number;
  total: number;
}

/**
 * What is wrong with how the corpus was cut up, and how much of it has never
 * earned its keep. Every figure comes from a row; nothing is estimated.
 */
export interface FragmentHealth {
  total: number;
  documents: number;
  embedded: number;
  /** Stored but never embedded: findable by words only, not by meaning. */
  unembedded: number;
  neverUsed: number;
  /** Retrievals recorded across the whole corpus. Zero means nothing yet. */
  retrievals: number;
  /**
   * The oldest last-use still on record — NOT the moment counting began, which
   * nothing stores. Deliberately not printed as one: the honest reading is "the
   * least recently used fragment was last used then", which is a mouthful for a
   * panel, so the interface shows `lastUsedAt` instead and leaves this for
   * anything that wants the span.
   */
  firstUsedAt: string | null;
  /** The last time Cortex retrieved anything at all from this memory. */
  lastUsedAt: string | null;
  medianTokens: number;
  tiny: number;
  cut: number;
  repeated: number;
  /**
   * Distinct fragments with anything wrong with them. NOT the sum of the three
   * above — a duplicate can also be truncated — so this is what the headline
   * uses; adding them up overstates the damage.
   */
  flagged: number;
  samples: {
    tiny: FragmentBrief[];
    cut: FragmentBrief[];
    repeated: FragmentBrief[];
    deadDocuments: DeadDocument[];
  };
}

/** A document whose date, expiry or replacement makes it worth checking. */
export interface StaleDocument {
  id: string;
  title: string;
  spaceId: string;
  spaceName: string;
  status: 'expired' | 'superseded' | 'old' | 'aging';
  /** Already in Spanish: "venció el 31 de enero de 2026". */
  label: string;
  ageDays: number | null;
}

/**
 * How well corroborated one document is: how many OTHER documents talk about
 * the same thing. Zero means the company knows this from exactly one place.
 */
export interface Corroboration {
  documentId: string;
  title: string;
  spaceId: string | null;
  spaceName: string | null;
  source: IntakeKey;
  chunks: number;
  /** Other documents whose material sits on top of this one's. */
  neighbours: number;
}

export interface KnowledgeShape {
  /** Best corroborated first. */
  corroborated: Corroboration[];
  /** Documents nothing else backs up, newest first. */
  alone: Corroboration[];
  /** How many documents were compared — the newest of a possibly larger set. */
  considered: number;
  total: number;
}

/**
 * Every action returns this instead of throwing. A thrown server action reaches
 * the browser as an opaque "an error occurred" in production, and someone who
 * has just tried to move a document needs to be told why it stayed put.
 */
export type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string };

/** The same contract for actions that have nothing to report on success. */
export type SimpleActionResult = { ok: true } | { ok: false; error: string };
