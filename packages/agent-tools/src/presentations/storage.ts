import { randomBytes } from 'node:crypto';
import type { ToolContext } from '../types';

/**
 * Storage + link minting for candidate presentation PDFs.
 *
 * An MCP tool can only return text, so the deliverable of "send me her
 * presentation" is a LINK. Three decisions are encoded here:
 *
 * 1. THE BYTES LIVE IN OUR STORAGE, not in the matcher. The matcher renders on
 *    demand and keeps nothing; re-rendering costs a Chromium launch (10-25 s)
 *    and, if the draft was regenerated meanwhile, would quietly hand out a
 *    DIFFERENT document than the one the user was shown. Uploading pins the
 *    exact artifact that was described in the conversation.
 *
 * 2. THE LINK IS ON OUR DOMAIN, not a Supabase signed URL. A signed URL leaks
 *    the storage host and object path, expires opaquely (the user gets an XML
 *    error page), and cannot be counted or revoked. `/api/files/presentation/
 *    <token>` is ours: we can audit it, expire it on our terms, and change
 *    where the bytes live without breaking a link somebody pasted into Slack.
 *
 * 3. THE TOKEN IS THE CREDENTIAL. See the header comment on
 *    apps/web/app/api/files/presentation/[token]/route.ts for the full
 *    trade-off. Short version: the link must survive being clicked out of a
 *    Claude conversation, where no session cookie exists, so it carries 32
 *    random bytes and a 7-day expiry instead of an identity check.
 */

/** Private bucket created in infra/supabase/migrations/0044_presentation_files.sql. */
export const PRESENTATION_BUCKET = 'presentation-files';

/** Long enough that a shared link stays useful for a hiring cycle, short
 *  enough that a leaked one dies before the candidate's data goes stale. */
export const DEFAULT_EXPIRY_DAYS = 7;

/** 32 bytes = 256 bits of entropy, base64url so it survives copy/paste. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

export function downloadUrlFor(token: string): string {
  return `${appBaseUrl()}/api/files/presentation/${token}`;
}

/**
 * Reduce a filename to ASCII word characters.
 *
 * Not cosmetic: this string is interpolated into a Content-Disposition header
 * by the download route, and header values are latin-1. A candidate called
 * "José Peña" would otherwise produce a header the runtime rejects outright.
 */
export function safeFilename(raw: string): string {
  const cleaned = raw
    // Fold accents first so "José Peña" becomes Jose_Pena, not Jos_Pea.
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  if (!cleaned) return 'presentation.pdf';
  const withExt = cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
  return withExt.slice(0, 180);
}

export interface StoreInput {
  candidateId: string;
  candidateName: string | null;
  jobId: string | null;
  version: number | null;
  filename: string;
  bytes: Uint8Array;
}

export interface StoredFile {
  token: string;
  downloadUrl: string;
  storagePath: string;
  filename: string;
  sizeBytes: number;
  expiresAt: string;
}

/**
 * Upload the PDF and record the row that makes the download link resolvable.
 *
 * Ordering matters: upload first, insert second. A row pointing at a missing
 * object is a broken link the user will click; an uploaded object with no row
 * is invisible garbage the bucket's lifecycle can sweep. Fail the cheap way —
 * and if the insert does fail, delete the object rather than leave it behind.
 */
export async function storePdf(ctx: ToolContext, input: StoreInput): Promise<StoredFile> {
  const token = mintToken();
  const filename = safeFilename(input.filename);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const storagePath = `presentations/${input.candidateId}/v${input.version ?? 0}-${stamp}.pdf`;
  const expiresAt = new Date(Date.now() + DEFAULT_EXPIRY_DAYS * 86_400_000).toISOString();

  const { error: uploadError } = await ctx.db.storage
    .from(PRESENTATION_BUCKET)
    .upload(storagePath, input.bytes, { contentType: 'application/pdf', upsert: true });
  if (uploadError) {
    throw new Error(`Could not store the PDF: ${uploadError.message}`);
  }

  const { error: insertError } = await ctx.db.from('presentation_files').insert({
    token,
    candidate_id: input.candidateId,
    candidate_name: input.candidateName,
    job_id: input.jobId,
    storage_path: storagePath,
    filename,
    size_bytes: input.bytes.byteLength,
    created_by: ctx.userId,
    expires_at: expiresAt,
  });
  if (insertError) {
    try {
      await ctx.db.storage.from(PRESENTATION_BUCKET).remove([storagePath]);
    } catch {
      // Best effort; the orphaned object is harmless and unreachable.
    }
    throw new Error(`Could not register the download link: ${insertError.message}`);
  }

  return {
    token,
    downloadUrl: downloadUrlFor(token),
    storagePath,
    filename,
    sizeBytes: input.bytes.byteLength,
    expiresAt,
  };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** "in 7 days" / "in 4 hours" / "expired" - for the one-line note in markdown. */
export function expiresIn(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return 'unknown';
  if (ms <= 0) return 'expired';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `in ${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `in ${hours} hour${hours === 1 ? '' : 's'}`;
}
