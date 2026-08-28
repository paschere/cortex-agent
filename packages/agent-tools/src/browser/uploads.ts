import type { SupabaseClient } from '@supabase/supabase-js';
import { getFile } from '../files/store';
import { getVisibleDocument } from '../kb/spaces';
import type { Step } from './types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PUTTING A FILE INTO SOMEBODY ELSE'S FORM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `download` was half a trámite. An administrator in Bogotá does not fetch a
 * certificate for the pleasure of having it — they fetch it from the chamber
 * of commerce and then attach it to a customer's supplier portal, or pull the
 * RUT out of Drive and attach that. The errand ends at an `<input type=file>`
 * on a site nobody here controls.
 *
 * ── THE BYTES NEVER GO NEAR A MODEL, AND ONLY ONE HOP NEAR A ROW ──────────
 *
 * Same discipline as download.ts, pointed the other way. A step does not
 * CARRY a file, it NAMES one, and the naming is what gets stored, versioned,
 * rendered on the review screen and read by the planner. The bytes are looked
 * up once, at run time, in the request that goes to the browser service, and
 * exist nowhere else.
 *
 * ── THE FOUR THINGS A REFERENCE CAN BE ────────────────────────────────────
 *
 *   download          what THIS run downloaded a few steps ago. Resolved
 *                     inside the browser service, from bytes it already has in
 *                     hand — so "bajar el certificado en el portal A y subirlo
 *                     en el portal B" never round-trips through Postgres, and
 *                     works even for a file too big to file as a document.
 *   doc:<uuid>        a Brain Knowledge document. This is the interesting one,
 *                     because it is what EVERY other source already becomes: a
 *                     file imported from Drive, a file a person uploaded, a
 *                     report Cortex generated, and a certificate a previous
 *                     trámite brought back (browser-download.ts files it as
 *                     one). One reference kind covers all four because the
 *                     product already converged on one document table.
 *   file:<b>/<path>   a raw app_files row, for the rare thing that is a file
 *                     without being a document.
 *   {{slot}}          a hole. The flow says "sube el archivo que te den aquí";
 *                     the errand decides which one on every run. This is the
 *                     whole reason an upload is teachable rather than wired.
 *
 * ── WHOSE FILES ───────────────────────────────────────────────────────────
 *
 * `getVisibleDocument` is the gate, and it is the same gate every other path
 * that reaches a document by id goes through. A document id is not an
 * authorisation: personal spaces exist inside a workspace, and «sube el
 * documento tal al portal del cliente» must not become a way to read a
 * colleague's private folder by guessing. The workspace boundary is already
 * handled a layer below — `db` is org-scoped — so what is enforced here is the
 * boundary inside it.
 */

/** The same ceiling as a download, and for the same reason. See replay.ts. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * What a portal may be handed.
 *
 * Deliberately the same list `readDownload` allows, minus nothing: a file this
 * workspace could legitimately receive from one portal is a file it can
 * legitimately hand to another, and two lists that disagree would mean a
 * certificate that can be fetched and not forwarded.
 */
export const ALLOWED_UPLOAD_EXTENSIONS = [
  'pdf',
  'xml',
  'csv',
  'txt',
  'json',
  'xls',
  'xlsx',
  'doc',
  'docx',
  'zip',
  'png',
  'jpg',
  'jpeg',
];

export type FileRef =
  /** Whatever this run downloaded. Resolved by the browser service. */
  | { kind: 'download' }
  | { kind: 'document'; id: string }
  | { kind: 'stored'; bucket: string; path: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a reference, or say it is not one.
 *
 * Returns null rather than throwing on anything unrecognised, because the
 * commonest unrecognised thing is an UNFILLED HOLE — the literal `{{factura}}`
 * arriving because nobody passed that slot. The caller turns that into "me
 * falta el archivo", which is a sentence a person can act on; an exception
 * here would surface as a stack trace on a run screen.
 */
export function parseFileRef(raw: string): FileRef | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value === 'download') return { kind: 'download' };

  const doc = /^doc:(.+)$/i.exec(value);
  if (doc?.[1]) {
    const id = doc[1].trim();
    return UUID_RE.test(id) ? { kind: 'document', id } : null;
  }

  const stored = /^file:([a-z0-9][a-z0-9._-]*)\/(.+)$/i.exec(value);
  if (stored?.[1] && stored[2]) {
    const path = stored[2].trim();
    // `..` in a path is the one thing that could reach outside the row it
    // names. app_files is keyed by an exact (bucket, path) pair so traversal
    // cannot actually resolve anywhere, but refusing it here means the rule is
    // stated where somebody reading this can see it rather than inferred from
    // the storage layer's shape.
    if (path.length === 0 || path.includes('..')) return null;
    return { kind: 'stored', bucket: stored[1], path };
  }

  return null;
}

/** Fill a reference's `{{holes}}` from the run's inputs. Same syntax as a step. */
export function renderRef(from: string, inputs: Record<string, string>): string {
  return from.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (whole, key: string) =>
    Object.hasOwn(inputs, key) ? (inputs[key] ?? '') : whole,
  );
}

/** The bytes and the name, as the browser service wants them. */
export interface UploadPayload {
  filename: string;
  mimeType: string;
  base64: string;
}

export interface UploadPlanEntry {
  /** Index into the flow's step list. The key the service looks it up by. */
  index: number;
  label: string;
  ref: FileRef | null;
  /** What the reference said, after the holes were filled. For the message. */
  rendered: string;
}

/**
 * Every upload the flow is about to attempt, with its reference resolved as far
 * as it can be without touching a database.
 *
 * Pure and separate from the reading of bytes on purpose: which files a run
 * will need is a property of the flow and the inputs, and being able to answer
 * it without a Supabase client is what lets the errand planner, the review
 * screen and the tests all ask.
 */
export function planUploads(
  steps: readonly Step[],
  inputs: Record<string, string>,
): UploadPlanEntry[] {
  const out: UploadPlanEntry[] = [];
  steps.forEach((step, index) => {
    if (step.action !== 'upload') return;
    const from = step.value?.kind === 'file' ? step.value.from : '';
    const rendered = renderRef(from, inputs);
    out.push({ index, label: step.label, ref: parseFileRef(rendered), rendered });
  });
  return out;
}

/** The extension a portal is being handed, lower-cased and without the dot. */
export function extensionOf(filename: string): string {
  const parts = filename.split('.');
  return parts.length > 1 ? (parts.pop() ?? '').toLowerCase() : '';
}

export type UploadResolution =
  | { ok: true; payload: UploadPayload }
  /** `why` is a full sentence for a person. Never a stack trace, never an id. */
  | { ok: false; why: string };

/**
 * Turn one reference into bytes, or into the sentence explaining why not.
 *
 * `download` is not resolvable here BY DESIGN and returns a refusal saying so
 * — the bytes for that reference exist only inside the run that is about to
 * happen, and a caller reaching this branch has asked the wrong layer.
 */
export async function resolveUpload(
  db: SupabaseClient,
  userId: string,
  ref: FileRef,
): Promise<UploadResolution> {
  if (ref.kind === 'download') {
    return {
      ok: false,
      why: 'ese archivo es el que baja el propio trámite, así que se resuelve durante la corrida',
    };
  }

  let bucket: string;
  let path: string;
  let filename: string;
  let mime: string | null = null;

  if (ref.kind === 'document') {
    // The gate. Throws when the document is in a space this person cannot see,
    // and a document they cannot see must read as one that does not exist.
    const visible = await getVisibleDocument(db, userId, ref.id).catch(() => null);
    if (!visible) {
      return { ok: false, why: 'ese documento ya no está en Brain Knowledge o no es tuyo' };
    }
    const { data } = await db
      .from('kb_documents')
      .select('source_ref, mime, title')
      .eq('id', ref.id)
      .maybeSingle();
    const sourceRef = (data?.source_ref as string | null) ?? null;
    if (!sourceRef) {
      // A document with no file behind it is a real state: a note typed
      // straight into Brain Knowledge, or a Drive document read as text.
      return {
        ok: false,
        why: `«${visible.title}» no tiene un archivo detrás que se pueda subir; es texto guardado en Brain Knowledge`,
      };
    }
    bucket = 'kb-uploads';
    path = sourceRef;
    mime = (data?.mime as string | null) ?? null;
    // The stored path ends in the original filename (see browser-download.ts
    // and the upload route), which is the name the portal should receive —
    // `documento.pdf` rather than a uuid.
    filename = sourceRef.split('/').pop() || `${visible.title}.pdf`;
  } else {
    bucket = ref.bucket;
    path = ref.path;
    filename = path.split('/').pop() || 'archivo';
  }

  const stored = await getFile(db, bucket, path).catch(() => null);
  if (!stored) return { ok: false, why: `no encontré el archivo «${filename}» para adjuntarlo` };

  if (stored.content.byteLength > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      why: `«${filename}» pesa ${Math.round(stored.content.byteLength / (1024 * 1024))} MB y el límite para adjuntar son ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
    };
  }

  const extension = extensionOf(filename);
  if (!ALLOWED_UPLOAD_EXTENSIONS.includes(extension)) {
    return {
      ok: false,
      why: `«${filename}» es un archivo «.${extension || 'sin extensión'}», que no es de los tipos que un trámite puede adjuntar (${ALLOWED_UPLOAD_EXTENSIONS.join(', ')})`,
    };
  }

  return {
    ok: true,
    payload: {
      filename,
      mimeType: stored.contentType ?? mime ?? 'application/octet-stream',
      base64: Buffer.from(stored.content).toString('base64'),
    },
  };
}

/**
 * Resolve every upload a run needs, refusing the whole run if any one of them
 * cannot be resolved.
 *
 * ALL OR NOTHING, and that is the important half. A trámite that radica a
 * solicitud with three attachments and silently sends two is worse than one
 * that does not run: the portal accepts it, the radicado number comes back, and
 * the omission is discovered by whoever rejects the filing a week later. There
 * is no partial success available at an `<input type=file>`.
 */
export async function resolveUploads(
  db: SupabaseClient,
  userId: string,
  steps: readonly Step[],
  inputs: Record<string, string>,
): Promise<{ ok: true; files: Record<string, UploadPayload> } | { ok: false; why: string }> {
  const plan = planUploads(steps, inputs);
  const files: Record<string, UploadPayload> = {};

  for (const entry of plan) {
    // Resolved by the service from the file it just downloaded. Nothing to send.
    if (entry.ref?.kind === 'download') continue;

    if (!entry.ref) {
      return {
        ok: false,
        why: `No sé qué archivo adjuntar en «${entry.label}»: ${
          entry.rendered.includes('{{')
            ? 'nadie llenó ese dato'
            : `«${entry.rendered}» no es una referencia de archivo que yo entienda`
        }.`,
      };
    }

    const resolved = await resolveUpload(db, userId, entry.ref);
    if (!resolved.ok) {
      return {
        ok: false,
        why: `No pude adjuntar el archivo de «${entry.label}»: ${resolved.why}.`,
      };
    }
    files[String(entry.index)] = resolved.payload;
  }

  return { ok: true, files };
}

/**
 * Does this flow put a file into a site?
 *
 * The mirror of `producesDocument`, and read off the steps for the same
 * reason: it is a property of what was TAUGHT, known before the trámite has
 * ever run. The review screen uses it to say so out loud, because "este
 * trámite sube un archivo al portal" is the sentence that decides whether
 * somebody looks twice before pressing the button.
 */
export function consumesDocument(steps: readonly Step[]): boolean {
  return steps.some((s) => s.action === 'upload');
}
