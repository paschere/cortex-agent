import 'server-only';
import { mintBlobToken } from '@/lib/blob-token';
import { logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type DocumentRow,
  type PresentationRow,
  type ReportRow,
  type TaskFile,
  collectFiles,
  filesFromText,
  fromDocument,
  fromPresentation,
  fromReport,
  windowFor,
} from './files';

/**
 * Las consultas detrás de «Archivos» (ver files.ts para qué se junta y por qué
 * así). Nunca lanza: una fuente que falla se registra y la lista sigue con las
 * demás — un panel de archivos que se cae por un informe ilegible sería peor que
 * uno al que le falta una fila.
 */

const BLOB_TTL_MS = 60 * 60_000;
const DOCUMENT_BUCKET = 'kb-uploads';

async function safe<T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (err) {
    logger.warn({ err, label }, 'produced files: source failed');
    return fallback;
  }
}

export interface ProducedFilesInput {
  /** Quien creó los archivos (la dueña de la conversación o de la tarea). */
  userId: string;
  conversationId: string | null;
  /** Ventana explícita (una tarea: de que se encoló a que terminó). Si falta, sale de los mensajes. */
  from?: string | null;
  to?: string | null;
  origin?: string;
  now?: Date;
}

export async function loadProducedFiles(
  db: SupabaseClient,
  input: ProducedFilesInput,
): Promise<TaskFile[]> {
  const now = input.now ?? new Date();

  const messages = input.conversationId
    ? await safe(
        'messages',
        async () => {
          const { data, error } = await db
            .from('messages')
            .select('role, content, created_at')
            .eq('conversation_id', input.conversationId)
            .order('created_at', { ascending: true })
            .limit(500);
          if (error) throw error;
          return (data ?? []) as Array<{ role: string; content: string; created_at: string }>;
        },
        [],
      )
    : [];

  const from = input.from ?? messages[0]?.created_at ?? null;
  const to = input.to ?? messages[messages.length - 1]?.created_at ?? null;
  const win = windowFor({ from, to, now });

  const fromLinks = messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) =>
      filesFromText(m.content ?? '', m.created_at, input.origin ? { origin: input.origin } : {}),
    );

  const presentations = win
    ? await safe(
        'presentations',
        async () => {
          const { data, error } = await db
            .from('presentation_files')
            .select('token, filename, size_bytes, created_at, expires_at')
            .eq('created_by', input.userId)
            .gte('created_at', win.from)
            .lte('created_at', win.to)
            .order('created_at', { ascending: false })
            .limit(50);
          if (error) throw error;
          return ((data ?? []) as PresentationRow[]).map((r) => fromPresentation(r, now));
        },
        [] as Array<TaskFile | null>,
      )
    : [];

  const reports = await safe(
    'reports',
    async () => {
      let q = db
        .from('reports')
        .select('id, title, generated_at')
        .order('generated_at', { ascending: false })
        .limit(50);
      if (input.conversationId) {
        q = q.eq('conversation_id', input.conversationId);
      } else if (win) {
        q = q
          .eq('generated_by', input.userId)
          .gte('generated_at', win.from)
          .lte('generated_at', win.to);
      } else {
        return [] as TaskFile[];
      }
      const { data, error } = await q;
      if (error) throw error;
      return ((data ?? []) as ReportRow[]).map(fromReport);
    },
    [] as TaskFile[],
  );

  const documents = win
    ? await safe(
        'documents',
        async () => {
          const { data, error } = await db
            .from('kb_documents')
            .select('id, title, mime, created_at, source_ref')
            .eq('uploaded_by', input.userId)
            .eq('source', 'tramite')
            .gte('created_at', win.from)
            .lte('created_at', win.to)
            .order('created_at', { ascending: false })
            .limit(50);
          if (error) throw error;
          const rows = (data ?? []) as Array<{
            id: string;
            title: string;
            mime: string | null;
            created_at: string;
            source_ref: string | null;
          }>;
          const paths = rows.map((r) => r.source_ref).filter((p): p is string => Boolean(p));
          const sizes = new Map<string, number>();
          if (paths.length > 0) {
            const { data: files } = await db
              .from('app_files')
              .select('path, size_bytes')
              .eq('bucket', DOCUMENT_BUCKET)
              .in('path', paths);
            for (const f of (files ?? []) as Array<{ path: string; size_bytes: number }>)
              sizes.set(f.path, Number(f.size_bytes));
          }
          return rows.map((r): TaskFile | null => {
            let downloadHref: string | null = null;
            if (r.source_ref) {
              try {
                const token = mintBlobToken({
                  bucket: DOCUMENT_BUCKET,
                  path: r.source_ref,
                  expiresAt: Date.now() + BLOB_TTL_MS,
                });
                downloadHref = `/api/files/blob/${token}`;
              } catch {
                downloadHref = null;
              }
            }
            const row: DocumentRow = {
              id: r.id,
              title: r.title,
              mime: r.mime,
              created_at: r.created_at,
              downloadHref,
              sizeBytes: r.source_ref ? (sizes.get(r.source_ref) ?? null) : null,
            };
            return fromDocument(row);
          });
        },
        [] as Array<TaskFile | null>,
      )
    : [];

  return collectFiles(presentations, reports, documents, fromLinks);
}
