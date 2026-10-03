import type { SupabaseClient } from '@supabase/supabase-js';
import { bogotaToday } from '../commitments/shape';
import type { DocumentChunk } from '../documents/verify';
import {
  EXPIRATIONS_EXTRACTOR_VERSION,
  type ExpirationHint,
  type VerifiedExpiration,
  readExpirations,
} from './detect';
import { getExpiration, getScan, recordScan, saveDetected } from './store';

/**
 * La lectura de vencimientos que corre cuando un documento llega al Cerebro
 * (subido, sincronizado de Drive, adjunto del correo promovido, descargado por
 * un trámite: todos pasan por `kb/document.ingest`), y el barrido de lo que ya
 * estaba.
 *
 * NUNCA LANZA. Igual que `extractDocumentData`: es una lectura extra encima de
 * un documento que ya quedó guardado y buscable; un modelo caído no puede
 * tumbar la ingesta. Cada fallo vuelve como `{ ok: false, reason }` y queda
 * escrito en el barrido.
 *
 * ES DE PAGO, así que en `ingest-document.ts` vive en su propio `step.run`
 * (`embedding-cost-guard.test.ts` lo lista por nombre) y es IDEMPOTENTE: un
 * documento ya mirado no se vuelve a pagar salvo con `force`.
 *
 * QUÉ NO SE MIRA, sin gastar nada:
 *   - documentos de un cuaderno personal (un papel privado no se vuelve un
 *     vencimiento que ve toda la empresa), salvo que alguien lo haya subido
 *     como renovación desde la pantalla;
 *   - lo que la lectura de documentos (0076) ya reconoció como factura, guía,
 *     comprobante de pago o declaración de importación;
 *   - lo que no pasa el filtro gratis de `detect.ts`.
 */

/** Tipos de 0076 que nunca son un papel que vence: su «vencimiento» es de pago. */
const NOT_EXPIRING_TYPES = new Set([
  'invoice',
  'waybill',
  'payment_receipt',
  'customs_declaration',
]);

export type DetectionOutcome =
  | { ok: true; skipped: true; reason: string }
  | { ok: true; skipped: false; found: number; modelCalled: boolean; deferred?: boolean }
  | { ok: false; reason: string };

interface DocumentRow {
  id: string;
  title: string;
  collection_id: string | null;
  uploaded_by: string | null;
  status: string;
}

export async function detectDocumentExpiration(
  db: SupabaseClient,
  documentId: string,
  opts: { today?: string; force?: boolean; allowModel?: boolean } = {},
): Promise<DetectionOutcome> {
  try {
    const scan = await getScan(db, documentId);
    if (scan && scan.outcome !== 'queued' && !opts.force) {
      return { ok: true, skipped: true, reason: 'este documento ya se revisó' };
    }

    const { data: docData, error: docError } = await db
      .from('kb_documents')
      .select('id, title, collection_id, uploaded_by, status')
      .eq('id', documentId)
      .maybeSingle();
    if (docError) throw docError;
    const doc = docData as DocumentRow | null;
    if (!doc) return { ok: true, skipped: true, reason: 'el documento ya no existe' };

    // La pista de una renovación subida desde la pantalla.
    const renews = scan?.renews_expiration_id
      ? await getExpiration(db, scan.renews_expiration_id)
      : null;
    const hint: ExpirationHint | null = renews
      ? { kind: renews.kind, subject: renews.subject, subjectKind: renews.subject_kind }
      : null;

    if (!hint) {
      const personal = await isPersonalSpace(db, doc.collection_id);
      if (personal) {
        await recordScan(db, {
          documentId,
          outcome: 'skipped',
          detail: 'Está en un cuaderno personal: no se vuelve un vencimiento de la empresa.',
          extractorVersion: EXPIRATIONS_EXTRACTOR_VERSION,
        });
        return { ok: true, skipped: true, reason: 'cuaderno personal' };
      }
      const { data: ext, error: extError } = await db
        .from('document_extractions')
        .select('doc_type')
        .eq('document_id', documentId)
        .maybeSingle();
      if (extError) throw extError;
      const docType = (ext as { doc_type: string | null } | null)?.doc_type ?? null;
      if (docType && NOT_EXPIRING_TYPES.has(docType)) {
        await recordScan(db, {
          documentId,
          outcome: 'none',
          detail: `Se leyó como ${docType}: su vencimiento es de pago, no de renovación.`,
          extractorVersion: EXPIRATIONS_EXTRACTOR_VERSION,
        });
        return { ok: true, skipped: false, found: 0, modelCalled: false };
      }
    }

    const { data: chunkData, error: chunkError } = await db
      .from('kb_chunks')
      .select('id, chunk_index, content')
      .eq('document_id', documentId)
      .order('chunk_index', { ascending: true })
      .limit(200);
    if (chunkError) throw chunkError;
    const chunks = (chunkData ?? []) as DocumentChunk[];
    if (chunks.length === 0) {
      await recordScan(db, {
        documentId,
        outcome: 'skipped',
        detail: 'El documento no tiene texto indexado.',
        extractorVersion: EXPIRATIONS_EXTRACTOR_VERSION,
      });
      return { ok: true, skipped: true, reason: 'sin texto indexado' };
    }

    const today = opts.today ?? bogotaToday();
    const reading = await readExpirations(chunks, today, hint, { allowModel: opts.allowModel });
    if (reading.deferred) {
      return { ok: true, skipped: false, found: 0, modelCalled: false, deferred: true };
    }

    const items: VerifiedExpiration[] = reading.items.map((item) =>
      hint && !item.subject && item.kind === hint.kind && hint.subject
        ? {
            ...item,
            subject: hint.subject,
            subjectKind: hint.subjectKind,
            reviewNote: [item.reviewNote, 'el sujeto se tomó del papel que renueva']
              .filter(Boolean)
              .join('; '),
          }
        : item,
    );

    const saved = items.length
      ? await saveDetected(
          db,
          {
            documentId,
            spaceId: doc.collection_id,
            items,
            uploaderId: doc.uploaded_by,
            modelId: reading.modelId,
            extractorVersion: EXPIRATIONS_EXTRACTOR_VERSION,
          },
          today,
        )
      : [];

    await recordScan(db, {
      documentId,
      outcome: saved.length ? 'found' : 'none',
      modelCalled: reading.modelCalled,
      detail: saved.length ? `${saved.length} por revisar` : reading.reason,
      extractorVersion: EXPIRATIONS_EXTRACTOR_VERSION,
    });
    return { ok: true, skipped: false, found: saved.length, modelCalled: reading.modelCalled };
  } catch (err) {
    const reason = (err as Error)?.message ?? 'falló la lectura de vencimientos';
    await recordScan(db, {
      documentId,
      outcome: 'failed',
      detail: reason,
      extractorVersion: EXPIRATIONS_EXTRACTOR_VERSION,
    }).catch(() => {});
    return { ok: false, reason };
  }
}

async function isPersonalSpace(db: SupabaseClient, collectionId: string | null): Promise<boolean> {
  if (!collectionId) return false;
  const { data, error } = await db
    .from('kb_collections')
    .select('scope')
    .eq('id', collectionId)
    .maybeSingle();
  if (error) throw error;
  const scope = (data as { scope: string } | null)?.scope;
  return scope != null && scope !== 'global';
}

// ---------------------------------------------------------------------------
// El barrido de lo que ya había
// ---------------------------------------------------------------------------

export interface BackfillResult {
  /** Documentos mirados en esta tanda (con o sin llamada). */
  scanned: number;
  found: number;
  modelCalls: number;
  failed: number;
  /** Quedan documentos sin mirar: otra tanda los toma. */
  more: boolean;
}

/**
 * Una TANDA del barrido: hasta `maxDocuments` documentos sin mirar, y como
 * mucho `maxModelCalls` llamadas al modelo. Lo que pasa el filtro gratis
 * cuando ya no queda presupuesto no se marca: queda para la próxima tanda.
 * Idempotente por `document_expiration_scans`: repetir la tanda no paga dos
 * veces el mismo documento.
 */
export async function backfillDocumentExpirations(
  db: SupabaseClient,
  opts: { maxDocuments?: number; maxModelCalls?: number; today?: string } = {},
): Promise<BackfillResult> {
  const maxDocuments = Math.min(Math.max(opts.maxDocuments ?? 40, 1), 200);
  const maxModelCalls = Math.min(Math.max(opts.maxModelCalls ?? 15, 0), 50);
  const today = opts.today ?? bogotaToday();

  const { data, error } = await db
    .from('kb_documents')
    .select('id')
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(1000);
  if (error) throw error;
  const ids = ((data ?? []) as Array<{ id: string }>).map((d) => d.id);

  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data: scans, error: scanError } = await db
      .from('document_expiration_scans')
      .select('document_id, outcome')
      .in('document_id', slice);
    if (scanError) throw scanError;
    for (const s of (scans ?? []) as Array<{ document_id: string; outcome: string }>) {
      if (s.outcome !== 'queued') seen.add(s.document_id);
    }
  }
  const pending = ids.filter((id) => !seen.has(id));

  const result: BackfillResult = { scanned: 0, found: 0, modelCalls: 0, failed: 0, more: false };
  let deferred = 0;
  for (const documentId of pending) {
    // Lo aplazado también cuenta: leer sus fragmentos ya costó una consulta.
    if (result.scanned + deferred >= maxDocuments) break;
    const outcome = await detectDocumentExpiration(db, documentId, {
      today,
      allowModel: result.modelCalls < maxModelCalls,
    });
    if (!outcome.ok) {
      result.failed += 1;
      result.scanned += 1;
      continue;
    }
    if ('deferred' in outcome && outcome.deferred) {
      deferred += 1;
      continue;
    }
    result.scanned += 1;
    if (!outcome.skipped) {
      result.found += outcome.found;
      if (outcome.modelCalled) result.modelCalls += 1;
    }
  }
  result.more = deferred > 0 || pending.length > result.scanned + deferred;
  return result;
}
