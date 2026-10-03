import { type SpaceChoice, listWritableSpacesAction } from '@/app/(chat)/chat/actions';
import type { FeedDetail, FeedEntry } from '@/lib/feed/shared';
import type { FeedSourceSummary } from '@/lib/feed/source-management';
import { workspaceHref } from '@/lib/workspace-context';

/**
 * Lo que la bandeja le pide al servidor, detrás de una interfaz: en la app son
 * las mismas rutas de siempre (/api/feed/…); en el fixture de /v, datos de
 * mentira en memoria. Ningún contrato cambia por esto.
 */
export interface FeedClient {
  list(): Promise<FeedEntry[]>;
  detail(id: string, signal?: AbortSignal): Promise<FeedDetail>;
  add(form: FormData): Promise<{ entry: FeedEntry; deduplicated?: boolean }>;
  /** El enlace al chat donde se consulta la entrada (crea la conversación si no hay). */
  consult(id: string): Promise<string>;
  promote(id: string, space?: string): Promise<{ documentId: string; note: string }>;
  remove(id: string): Promise<void>;
  spaces(): Promise<SpaceChoice[]>;
  sources(): Promise<{ sources: FeedSourceSummary[]; impactTruncated: boolean }>;
  sourceAction(body: unknown): Promise<{ capture?: { entry?: FeedEntry } }>;
}

async function json<T>(res: Response, fallback: string): Promise<T> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? fallback);
  return body as T;
}

export function httpFeedClient(workspaceId: string): FeedClient {
  const href = (path: string) => workspaceHref(workspaceId, path);
  return {
    async list() {
      const data = await json<{ entries: FeedEntry[] }>(
        await fetch(href('/api/feed')),
        'No se pudo actualizar la bandeja.',
      );
      return data.entries;
    },
    async detail(id, signal) {
      const data = await json<{ entry: FeedDetail }>(
        await fetch(href(`/api/feed/${id}`), { signal }),
        'No se pudo leer la entrada.',
      );
      return data.entry;
    },
    async add(form) {
      return json(
        await fetch(href('/api/feed'), { method: 'POST', body: form }),
        'No se pudo añadir la entrada.',
      );
    },
    async consult(id) {
      const data = await json<{ href: string }>(
        await fetch(href(`/api/feed/${id}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'consult' }),
        }),
        'No se pudo abrir la consulta.',
      );
      return href(data.href);
    },
    async promote(id, space) {
      const data = await json<{ result: { documentId: string; note: string } }>(
        await fetch(href(`/api/feed/${id}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'promote', ...(space ? { space } : {}) }),
        }),
        'No se pudo guardar en el cerebro.',
      );
      return data.result;
    },
    async remove(id) {
      await json(
        await fetch(href(`/api/feed/${id}`), { method: 'DELETE' }),
        'No se pudo eliminar la entrada.',
      );
    },
    spaces: () => listWritableSpacesAction(),
    async sources() {
      const body = await json<{ sources?: FeedSourceSummary[]; impactTruncated?: boolean }>(
        await fetch(href('/api/feed/sources'), { cache: 'no-store' }),
        'No se pudieron cargar las fuentes conectadas.',
      );
      return { sources: body.sources ?? [], impactTruncated: body.impactTruncated === true };
    },
    async sourceAction(body) {
      return json(
        await fetch(href('/api/feed/sources'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        'No se pudo actualizar la fuente.',
      );
    },
  };
}
