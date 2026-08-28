import type { Step } from './types';

/**
 * The file a trámite came back with.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BYTES ARE PULLED OUT OF THE RESULT INSTEAD OF LEFT IN IT
 * ---------------------------------------------------------------------------
 * The browser service returns everything a run produced in one `output` object,
 * and a `download` step puts the whole file in there as base64. That object then
 * goes three places, and it should go to none of them carrying a document:
 *
 *   * INTO POSTGRES, as `browser_flow_runs.result`. A 4MB certificate becomes a
 *     5.5MB base64 string on a row that is read back every time somebody opens
 *     the run history. Twenty runs of a monthly certificate is a hundred
 *     megabytes of JSONB nobody will ever look at, in a column meant to hold
 *     "what the errand found".
 *   * INTO A MODEL'S CONTEXT, as the tool result of `browser.run_flow`. Base64
 *     is the worst possible thing to spend a context window on: it is
 *     incompressible to a reader, it says nothing, and it is charged by the
 *     token.
 *   * INTO AN API RESPONSE, to a screen that wants a filename and a link.
 *
 * So the bytes are lifted out here, once, at the boundary. What stays in
 * `output` is what a person or a model would actually say about the file --
 * its name, its size, its type -- and the bytes travel separately to whoever is
 * going to store them.
 */

export interface DownloadedFile {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  base64: string;
}

/** What is left in the run's result once the bytes have been taken out. */
export interface DownloadSummary {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Set when the portal handed over something a trámite may not carry. */
  refused?: string;
  /** Filled in by the caller once the file has somewhere to live. */
  documentId?: string;
}

/**
 * Split a run's output into "what happened" and "the file".
 *
 * Returns the output with the bytes removed either way, so a caller that does
 * nothing with the file still cannot persist it by accident.
 */
export function separateDownload(output: Record<string, unknown>): {
  output: Record<string, unknown>;
  file: DownloadedFile | null;
  summary: DownloadSummary | null;
} {
  const raw = output.download as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return { output, file: null, summary: null };

  const filename = typeof raw.filename === 'string' ? raw.filename : 'archivo';
  const mimeType = typeof raw.mimeType === 'string' ? raw.mimeType : 'application/octet-stream';
  const sizeBytes = typeof raw.sizeBytes === 'number' ? raw.sizeBytes : 0;
  const refused = typeof raw.refused === 'string' ? raw.refused : undefined;
  const base64 = typeof raw.base64 === 'string' && raw.base64.length > 0 ? raw.base64 : null;

  const summary: DownloadSummary = {
    filename,
    mimeType,
    sizeBytes,
    ...(refused ? { refused } : {}),
  };
  return {
    output: { ...output, download: summary },
    file: base64 ? { filename, mimeType, sizeBytes, base64 } : null,
    summary,
  };
}

/**
 * Where a downloaded file is put, and what is done with it afterwards.
 *
 * INJECTED, and it has to be. Filing a document means Supabase Storage, a
 * `kb_documents` row and an Inngest event, and Inngest lives in `apps/web`:
 * reaching it from here would drag the whole web app into every consumer of
 * this package, including a Railway container whose job is to drive Chromium.
 * The same seam is why `BrowserTransport` and `Repairer` are interfaces.
 *
 * Returning `null` means "not filed", and that is a legitimate answer -- a run
 * from a surface with nowhere to put a document still finished the errand.
 */
export type DocumentSink = (
  file: DownloadedFile,
  context: {
    organizationId: string;
    flowId: string;
    flowName: string;
    host: string;
    runId: string;
    userId: string;
  },
) => Promise<{ documentId: string; title: string } | null>;

/**
 * The sink the whole process uses, registered once at boot.
 *
 * ---------------------------------------------------------------------------
 * WHY A REGISTRATION AND NOT AN ARGUMENT AT EVERY CALL SITE
 * ---------------------------------------------------------------------------
 * `runFlow` is reached from four places -- the run button, the verification
 * pass, the agent's two chat tools -- and two of them are inside this package,
 * where `apps/web` cannot be imported. Threading a sink through `ToolContext`
 * to reach them would put a Supabase-Storage-and-Inngest concern into the type
 * every tool in the product depends on, to serve one tool.
 *
 * So `apps/web/instrumentation-node.ts` registers it once, on the Node runtime,
 * before anything serves a request -- the same place other process-wide wiring
 * lives. Nothing is registered in a test or in the Railway container, and there
 * the errand simply runs and describes the file it found without filing it,
 * which is the correct behaviour for a process with nowhere to put a document.
 */
let registered: DocumentSink | null = null;

export function setDocumentSink(sink: DocumentSink | null): void {
  registered = sink;
}

export function currentDocumentSink(): DocumentSink | null {
  return registered;
}

/**
 * Does this flow produce a file?
 *
 * Read off the steps rather than off the last run, so it is a property of what
 * was TAUGHT: if the person downloaded something while demonstrating, the
 * trámite knows it produces a document before it has ever run.
 */
export function producesDocument(steps: Step[]): boolean {
  return steps.some((s) => s.action === 'download');
}
