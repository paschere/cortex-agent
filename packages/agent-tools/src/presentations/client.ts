import { BASE, matcherFetch } from '../recruit/client';

/**
 * Matcher access for the presentations family.
 *
 * Everything here talks to endpoints the matcher ALREADY has — no second PDF
 * renderer, no forked HTML template:
 *
 *   GET  /api/candidates/<id>/presentation            latest stored draft
 *   POST /api/candidates/<id>/presentation/generate   AI writes a new version
 *   POST /api/candidates/<id>/presentation/export     Puppeteer → PDF bytes
 *
 * The export route is reachable service-to-service: the matcher's middleware
 * guards `/api/candidates` only when ENFORCE_API_AUTH is on, and it accepts
 * `Authorization: Bearer <ZIPDEV_AGENT_SERVICE_TOKEN>` — the same header
 * recruit/client.ts already sends as ZIPDEV_MATCHER_TOKEN. So no new matcher
 * endpoint was needed; the ZIPDEV-letterhead, Letter-format renderer in
 * lib/pdf/generate-presentation-pdf.ts stays the single source of truth for
 * what a Zipdev presentation looks like.
 *
 * What the export route does NOT return is metadata — it answers with bytes
 * and a filename, nothing about which version or author is inside them. That
 * is why `readPresentation()` is always called alongside it: the stored file
 * has to be labelled with a version and an author, or a link that lives for a
 * week says nothing about whether a human ever reviewed the draft.
 */

export interface StoredPresentation {
  id: string | null;
  version: number | null;
  createdBy: string | null;
  lastEditedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  htmlChars: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toStored(p: any): StoredPresentation | null {
  if (!p) return null;
  return {
    id: p.id ?? null,
    version: typeof p.version === 'number' ? p.version : null,
    createdBy: p.createdBy ?? null,
    lastEditedBy: p.lastEditedBy ?? null,
    createdAt: p.createdAt ?? null,
    updatedAt: p.updatedAt ?? null,
    htmlChars: typeof p.htmlContent === 'string' ? p.htmlContent.length : 0,
  };
}

/**
 * Latest stored presentation for a candidate, or null when none exists.
 *
 * The matcher answers 200 + `{presentation: null}` for "never written" — that
 * is a real answer, not an error, and callers must treat it as such.
 *
 * NOTE: this endpoint returns the full htmlContent (tens of KB). It is read
 * for its metadata only and the body is dropped here, at the boundary, so the
 * markup never reaches a model's context.
 */
export async function readPresentation(candidateId: string): Promise<StoredPresentation | null> {
  const data = await matcherFetch(
    `/api/candidates/${encodeURIComponent(candidateId)}/presentation`,
  );
  return toStored(data?.presentation ?? null);
}

/** Same as readPresentation, but never throws — used for best-effort lookups. */
export async function tryReadPresentation(candidateId: string): Promise<StoredPresentation | null> {
  try {
    return await readPresentation(candidateId);
  } catch {
    return null;
  }
}

/** Ask the matcher's AI to write (or rewrite) the presentation. Version-bumps. */
export async function writePresentation(candidateId: string): Promise<StoredPresentation | null> {
  const data = await matcherFetch(
    `/api/candidates/${encodeURIComponent(candidateId)}/presentation/generate`,
    { method: 'POST' },
  );
  return toStored(data?.presentation ?? null);
}

export interface RenderedPdf {
  bytes: Uint8Array;
  /** Filename the matcher chose, e.g. `Jane_Doe_Presentation.pdf`. */
  filename: string;
}

/** Thrown when the matcher has nothing to render — the caller can offer to write one. */
export class NoPresentationError extends Error {
  constructor(candidateId: string) {
    super(`No presentation exists yet for candidate ${candidateId}`);
    this.name = 'NoPresentationError';
  }
}

/**
 * Render the stored presentation to PDF.
 *
 * Deliberately NOT routed through matcherFetch: that helper parses JSON, and
 * this response is binary. The retry policy is also different — a cold
 * Chromium launch is slow but not transient, so retrying a 5xx here would
 * queue a second 25-second render behind the first. One attempt, clear error.
 */
export async function renderPdf(candidateId: string, jobId?: string): Promise<RenderedPdf> {
  const token = process.env.ZIPDEV_MATCHER_TOKEN;
  const url = `${BASE()}/api/candidates/${encodeURIComponent(candidateId)}/presentation/export`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    // The route reads only the path param today; jobId is sent so that a
    // future job-scoped export needs no change on this side.
    body: JSON.stringify({ candidateId, ...(jobId ? { jobId } : {}) }),
  });

  if (res.status === 404) throw new NoPresentationError(candidateId);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Zipdev matcher ${res.status} while exporting the PDF: ${body.slice(0, 300)}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error('The matcher returned an empty PDF');

  return { bytes, filename: filenameFrom(res.headers.get('content-disposition'), candidateId) };
}

/** Pull `filename="…"` out of a Content-Disposition header (it is percent-encoded). */
function filenameFrom(disposition: string | null, candidateId: string): string {
  const match = disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition) : null;
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1].trim());
    } catch {
      return match[1].trim();
    }
  }
  return `${candidateId}_Presentation.pdf`;
}
