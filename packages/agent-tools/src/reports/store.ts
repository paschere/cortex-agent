import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ReportDocument, ReportKind } from './document';
import { REPORT_DOCUMENT_VERSION, validateDocument } from './document';
import { RENDERER_VERSION } from './render';
import type { ToolContext } from '../types';

/**
 * Saving a report, and what "saved" is allowed to mean.
 *
 * ===========================================================================
 * SAVING IS PHOTOGRAPHING, NOT BOOKMARKING
 * ===========================================================================
 * The July report has to say in November exactly what it said in July. That
 * sounds obvious and it rules out the design almost everybody reaches for
 * first: storing the report's PARAMETERS and re-running the query when someone
 * opens it. That version of "saved" quietly rewrites history — the report a
 * decision was made from is gone, replaced by a report about today wearing
 * July's title, and nobody can tell because both look correct.
 *
 * So what gets stored is the RESOLVED DOCUMENT: every figure already computed,
 * every label already written, every source already stamped with the instant it
 * was read and the number of rows it returned. Opening a saved report runs no
 * query at all. Nothing about it can change, because nothing about it is still
 * being decided.
 *
 * Rendering stays outside the freeze on purpose. HTML is a pure function of the
 * document, so a fixed typo, a better contrast ratio or an accessibility repair
 * reaches every report ever generated, while not one number moves. `document`
 * is the fact; `renderer_version` records which presentation drew it.
 *
 * ===========================================================================
 * AND THE FREEZE IS CHECKED, NOT PROMISED
 * ===========================================================================
 * `content_hash` is the sha256 of the canonical serialization of the document,
 * computed on the way in. It is recomputed every time a report is read, and a
 * mismatch is surfaced on the page rather than swallowed.
 *
 * That is not paranoia about attackers with database access — if they have it,
 * they can rewrite the hash too. It is about the failure that actually happens:
 * a migration, a backfill, a well-meant "let me just fix that title" against
 * production. A report whose whole value is that it did not change should be
 * able to say whether it did, and this is the cheapest possible way for it to
 * say so.
 *
 * ===========================================================================
 * SHARING: A LINK, AND ALSO A FILE
 * ===========================================================================
 * `presentations/storage.ts` faced the same question for PDFs and answered it
 * with an unguessable token on our own domain. The same reasoning applies here
 * and the mechanism is deliberately identical (32 random bytes, base64url, an
 * expiry, a view counter, a URL we can audit and revoke) — one shape for "a
 * Cortex artifact somebody outside the app can open" is worth more than a
 * marginally better second one.
 *
 * What differs is that a report ALSO exports. Both exist because they answer
 * different questions:
 *
 *   THE LINK is for a person. It lives at one address, it can be revoked, it
 *   counts its own views, and it always shows the snapshot — so "the report I
 *   sent you" and "the report I'm looking at" are provably the same document.
 *
 *   THE EXPORT is for a folder. Customs and postal operations get audited, and
 *   an audit wants a file with a date on it, openable in five years with no
 *   server involved. A single self-contained HTML file — charts included, no
 *   requests, no scripts — is that artifact. A link cannot be it, because a
 *   link is a promise that a server will still be there.
 *
 * The PDF module (`presentations/`) is neither of these and is not duplicated
 * here: a PDF is a document you mail to a client. This is a document you read,
 * reopen and cite.
 */

/** The table this module owns. Registered as `tenant()` in tenancy/tables.ts. */
export const REPORTS_TABLE = 'reports';

/** Long enough to be useful for a monthly review cycle, short enough to die. */
export const DEFAULT_SHARE_DAYS = 30;

export const REPORT_COLUMNS =
  'id, kind, title, subtitle, period_label, period_start, params, document, content_hash, document_version, renderer_version, generated_at, generated_by, conversation_id, client_id, share_token, share_expires_at, share_views, created_at';

export interface ReportRow {
  id: string;
  kind: ReportKind;
  title: string;
  subtitle: string | null;
  period_label: string;
  /** El lunes de la semana que reporta, sólo en los partes que salen solos. */
  period_start: string | null;
  params: Record<string, unknown>;
  document: unknown;
  content_hash: string;
  document_version: number;
  renderer_version: number;
  generated_at: string;
  generated_by: string | null;
  conversation_id: string | null;
  client_id: string | null;
  share_token: string | null;
  share_expires_at: string | null;
  share_views: number;
  created_at: string;
}

/** A row with its document parsed, validated, and its freeze checked. */
export interface StoredReport {
  row: ReportRow;
  document: ReportDocument;
  /**
   * False when the stored hash does not match the stored document. The report
   * still renders — refusing to show it would destroy the only evidence — but
   * the screen says so, loudly.
   */
  intact: boolean;
}

// ---------------------------------------------------------------------------
// The hash
// ---------------------------------------------------------------------------

/**
 * Serialize a document so that the same content always produces the same bytes.
 *
 * `JSON.stringify` is insufficient on its own: key order follows insertion
 * order, so a document that round-trips through a database, a JSON column or a
 * different builder can serialize differently while being identical. Sorting
 * keys at every level makes the hash a function of the CONTENT rather than of
 * the code path that assembled it.
 */
export function canonicalize(value: unknown): string {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const entries = Object.entries(node as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return JSON.stringify(walk(value));
}

export function documentHash(doc: ReportDocument): string {
  return createHash('sha256').update(canonicalize(doc), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/** 32 bytes = 256 bits, base64url so it survives being pasted into WhatsApp. */
export function mintShareToken(): string {
  return randomBytes(32).toString('base64url');
}

export function appBaseUrl(): string {
  return (process.env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

/** Inside the app, behind the session. */
export function reportUrl(id: string): string {
  return `${appBaseUrl()}/reports/${id}`;
}

/** Outside the app, authenticated by the token itself. */
export function shareUrl(token: string): string {
  return `${appBaseUrl()}/api/files/report/${token}`;
}

/** The self-contained file. Same bytes as the shared page, downloaded. */
export function exportUrl(id: string): string {
  return `${appBaseUrl()}/api/reports/${id}/export`;
}

/** Reduce a title to something safe in a `Content-Disposition` header. */
export function safeFilename(raw: string): string {
  const cleaned = raw
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._-]+/, '')
    .replace(/[._-]+$/, '');
  const base = cleaned || 'informe';
  return `${base.toLowerCase().endsWith('.html') ? base : `${base}.html`}`.slice(0, 180);
}

export function shareExpiresIn(iso: string | null): string {
  if (!iso) return 'sin enlace';
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms)) return 'desconocido';
  if (ms <= 0) return 'vencido';
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `en ${days} ${days === 1 ? 'día' : 'días'}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `en ${hours} ${hours === 1 ? 'hora' : 'horas'}`;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export interface SaveReportInput {
  kind: ReportKind;
  document: ReportDocument;
  params: Record<string, unknown>;
  conversationId?: string | null;
}

/**
 * Store a freshly built report.
 *
 * Validates before it writes — a document that cannot be rendered must never
 * reach a row, because the failure would then surface to whoever opens it
 * weeks later instead of to whoever generated it now.
 */
export async function saveReport(ctx: ToolContext, input: SaveReportInput): Promise<ReportRow> {
  const document = validateDocument(input.document);
  const { data, error } = await ctx.db
    .from(REPORTS_TABLE)
    .insert({
      // Minted here rather than left to `gen_random_uuid()`. The id is the
      // report's URL, and the tool has to be able to say "está en /reports/<id>"
      // in the same breath as it saves; deriving it from the round trip makes
      // the answer depend on the returning clause surviving every future edit.
      id: randomUUID(),
      kind: input.kind,
      title: document.title,
      subtitle: document.subtitle,
      period_label: document.periodLabel,
      params: input.params,
      document,
      content_hash: documentHash(document),
      document_version: document.version ?? REPORT_DOCUMENT_VERSION,
      renderer_version: RENDERER_VERSION,
      generated_at: document.generatedAt,
      generated_by: ctx.userId,
      conversation_id: input.conversationId ?? ctx.conversationId ?? null,
      share_views: 0,
    })
    .select(REPORT_COLUMNS)
    .single();

  if (error) throw new Error(`No se pudo guardar el informe: ${error.message}`);
  return data as unknown as ReportRow;
}

// ---------------------------------------------------------------------------
// Reclamar una semana
// ---------------------------------------------------------------------------

export interface ClaimWeeklyInput {
  /** El lunes de la semana que este parte reporta, `YYYY-MM-DD`. */
  periodStart: string;
  document: ReportDocument;
  params?: Record<string, unknown>;
}

export type ClaimWeeklyResult =
  /** Ganamos la semana. Sólo en este caso se manda el correo. */
  | { claimed: true; row: ReportRow }
  /** Otro proceso ya la tenía. No hay nada que hacer y no hay nada que decir. */
  | { claimed: false; reason: 'already_claimed' };

/**
 * ESCRIBIR EL PARTE ES RECLAMAR LA SEMANA. No hay dos pasos.
 *
 * ===========================================================================
 * POR QUÉ ESTO NO ES `saveReport` CON UN CAMPO MÁS
 * ===========================================================================
 * `saveReport` guarda lo que alguien pidió, y puede haber quince informes de
 * vencimientos generados el mismo martes sin que ninguno esté de más: cada uno
 * es una pregunta que una persona hizo. Este parte es lo contrario — hay UNO
 * por espacio de trabajo y semana, y el segundo no es redundante sino dañino.
 *
 * Un parte que llega dos veces no es un fallo cosmético. Es la lección de que a
 * Cortex se le puede ignorar: quien recibe el mismo informe duplicado deja de
 * leer los dos, y a partir de ahí el producto entero es ruido. Inngest reintenta
 * pasos, los despliegues reinician funciones a medias y un cron que dispara dos
 * veces es un lunes normal, así que esto NO puede depender de que el código
 * recuerde lo que hizo.
 *
 * Así que «¿ya lo mandamos?» lo contesta el índice único parcial
 * `reports_period_once_idx` de la migración 0100, exactamente como
 * `commitment_notices_once_idx` contesta «¿ya lo avisamos?» en la 0069. Esta
 * función inserta y deja decidir a la base:
 *
 *   inserción aceptada  →  la semana es nuestra, mándese el correo
 *   23505               →  ya era de otro, no se manda nada y no se dice nada
 *
 * ===========================================================================
 * RECLAMAR PRIMERO, ENVIAR DESPUÉS
 * ===========================================================================
 * El orden importa porque los dos fallos no cuestan lo mismo. Reclamar y no
 * poder enviar deja el parte guardado en /reports y un aviso en la campana
 * diciendo que el correo no salió: la información existe y se puede ir a
 * buscar. Enviar y no poder reclamar manda el mismo parte otra vez en cada
 * reintento, que es el único desenlace que este mecanismo existe para impedir.
 *
 * `generated_by` va nulo a propósito: no lo pidió nadie. Ésa es la
 * característica del parte, no un dato que falte.
 */
export async function claimWeeklyReport(
  db: SupabaseClient,
  input: ClaimWeeklyInput,
): Promise<ClaimWeeklyResult> {
  const document = validateDocument(input.document);
  const { data, error } = await db
    .from(REPORTS_TABLE)
    .insert({
      id: randomUUID(),
      kind: document.kind,
      period_start: input.periodStart,
      title: document.title,
      subtitle: document.subtitle,
      period_label: document.periodLabel,
      params: input.params ?? { periodStart: input.periodStart },
      document,
      content_hash: documentHash(document),
      document_version: document.version ?? REPORT_DOCUMENT_VERSION,
      renderer_version: RENDERER_VERSION,
      generated_at: document.generatedAt,
      generated_by: null,
      conversation_id: null,
      share_views: 0,
    })
    .select(REPORT_COLUMNS)
    .maybeSingle();

  if (error) {
    // 23505: el índice único parcial de la 0100 hizo su trabajo. No es un fallo
    // que haya que registrar ni reintentar — es la respuesta correcta.
    if (error.code === '23505') return { claimed: false, reason: 'already_claimed' };
    throw new Error(`No se pudo reclamar la semana del parte: ${error.message}`);
  }
  // Sin error y sin fila sólo puede pasar si la inserción no devolvió nada, que
  // con el índice de por medio significa lo mismo que un 23505.
  if (!data) return { claimed: false, reason: 'already_claimed' };
  return { claimed: true, row: data as unknown as ReportRow };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ListReportsOptions {
  kind?: ReportKind;
  /** Only the ones this person generated. */
  generatedBy?: string;
  limit?: number;
}

/** Row summaries, newest first. Does not parse the documents — a list of forty
 *  reports has no business deserializing forty snapshots. */
export async function listReports(
  db: SupabaseClient,
  opts: ListReportsOptions = {},
): Promise<ReportRow[]> {
  let q = db
    .from(REPORTS_TABLE)
    .select(
      'id, kind, title, subtitle, period_label, period_start, params, content_hash, document_version, renderer_version, generated_at, generated_by, conversation_id, client_id, share_token, share_expires_at, share_views, created_at',
    )
    .order('generated_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 25, 100));

  if (opts.kind) q = q.eq('kind', opts.kind);
  if (opts.generatedBy) q = q.eq('generated_by', opts.generatedBy);

  const { data, error } = await q;
  if (error) throw new Error(`No se pudieron leer los informes: ${error.message}`);
  return (data ?? []) as unknown as ReportRow[];
}

/** One report, parsed and integrity-checked. Null when it is not this
 *  workspace's — the scoped handle turns "another tenant's id" into "no row". */
export async function getReport(db: SupabaseClient, id: string): Promise<StoredReport | null> {
  const { data, error } = await db
    .from(REPORTS_TABLE)
    .select(REPORT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`No se pudo abrir el informe: ${error.message}`);
  if (!data) return null;
  return hydrateRow(data as unknown as ReportRow);
}

/**
 * Parse a stored row into a renderable report.
 *
 * The document is validated on the way out as well as on the way in. A row is
 * data; data outlives the code that wrote it, gets restored from backups and
 * occasionally gets edited by hand. Whatever happened to it, a figure whose
 * citation no longer resolves must not reach a page.
 */
export function hydrateRow(row: ReportRow): StoredReport {
  const document = validateDocument(row.document);
  return {
    row,
    document,
    intact: documentHash(document) === row.content_hash,
  };
}

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export interface ShareResult {
  token: string;
  url: string;
  expiresAt: string;
}

/**
 * Mint (or re-mint) a share link.
 *
 * Re-sharing an already-shared report REPLACES the token rather than extending
 * it. That is the safer default by a distance: "share this again" almost always
 * follows "I think that link went to the wrong person", and silently renewing
 * the old token would leave the wrong person holding a live link.
 */
export async function shareReport(
  ctx: ToolContext,
  id: string,
  opts: { days?: number } = {},
): Promise<ShareResult> {
  const days = Math.min(Math.max(Math.round(opts.days ?? DEFAULT_SHARE_DAYS), 1), 180);
  const token = mintShareToken();
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();

  const { data, error } = await ctx.db
    .from(REPORTS_TABLE)
    .update({ share_token: token, share_expires_at: expiresAt, share_views: 0 })
    .eq('id', id)
    .select('id')
    .maybeSingle();

  if (error) throw new Error(`No se pudo crear el enlace: ${error.message}`);
  if (!data) throw new Error('Ese informe no existe en este espacio de trabajo.');

  return { token, url: shareUrl(token), expiresAt };
}

/** Kill the link. The report stays; only the outside door closes. */
export async function revokeShare(ctx: ToolContext, id: string): Promise<boolean> {
  const { data, error } = await ctx.db
    .from(REPORTS_TABLE)
    .update({ share_token: null, share_expires_at: null })
    .eq('id', id)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`No se pudo revocar el enlace: ${error.message}`);
  return Boolean(data);
}

export function shareIsLive(row: Pick<ReportRow, 'share_token' | 'share_expires_at'>): boolean {
  if (!row.share_token || !row.share_expires_at) return false;
  return Date.parse(row.share_expires_at) > Date.now();
}
