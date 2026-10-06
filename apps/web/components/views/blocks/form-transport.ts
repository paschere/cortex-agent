import { editViewSubmissionAction, submitViewFormAction } from '@/lib/views/actions';
import { isOfflineFailure } from '@/lib/views/offline-queue';
import type { UploadedFile } from '@/lib/views/upload-rules';
import type { SubmitTarget } from '../ViewCanvas';
import { uploadFile } from '../inputs/FileInput';

/**
 * Cómo habla el formulario con el servidor: enviar, corregir y subir fotos
 * pendientes. Adentro por server action (con sesión); afuera por las rutas
 * públicas (con token). Un fallo de RED se marca `offline` para que el
 * formulario lo mande a la cola del teléfono en vez de mostrarlo como error.
 */

export type SubmitResult =
  /** `duplicate`: la regla de duplicados de la tabla marcó lo enviado (se pinta como alerta). */
  | {
      ok: true;
      message: string;
      duplicate?: string | null;
      rowId?: string;
      editToken?: string | null;
    }
  | { ok: false; error: string; offline?: boolean };

export type SubmitFn = (
  blockId: string,
  values: Record<string, string>,
  clientId?: string,
) => Promise<SubmitResult>;

export type CorrectResult =
  | { ok: true; message: string; duplicate?: string | null }
  | { ok: false; error: string };

export type CorrectFn = (
  blockId: string,
  rowId: string,
  values: Record<string, string>,
  editToken: string | null,
) => Promise<CorrectResult>;

const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

async function publicPost<T extends object>(
  url: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; error: string; offline: boolean }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (res.ok && data) return { ok: true, data };
    return {
      ok: false,
      error: data?.error ?? 'No se pudo enviar. Inténtalo otra vez.',
      offline: isOfflineFailure({ online: online(), status: res.status }),
    };
  } catch {
    return { ok: false, error: 'Sin conexión. Inténtalo otra vez.', offline: true };
  }
}

export function submitterFor(target: SubmitTarget): SubmitFn | undefined {
  if (target.kind === 'app')
    return async (blockId, values, clientId) => {
      try {
        return await submitViewFormAction(target.viewId, blockId, values, clientId);
      } catch {
        // La server action no llegó: sin red.
        return { ok: false, error: 'Sin conexión. Inténtalo otra vez.', offline: true };
      }
    };
  if (target.kind === 'public')
    return async (blockId, values, clientId) => {
      const res = await publicPost<{
        message?: string;
        duplicate?: string | null;
        rowId?: string;
        editToken?: string | null;
      }>('/api/views/public/submit', { token: target.token, blockId, values, clientId });
      if (res.ok && res.data.message)
        return {
          ok: true,
          message: res.data.message,
          duplicate: res.data.duplicate ?? null,
          rowId: res.data.rowId,
          editToken: res.data.editToken ?? null,
        };
      return res.ok
        ? { ok: false, error: 'No se pudo enviar. Inténtalo otra vez.' }
        : { ok: false, error: res.error, offline: res.offline };
    };
  if (target.kind === 'demo')
    return async () => {
      await new Promise((r) => setTimeout(r, 500));
      return { ok: true, message: 'Recibido. Gracias.', rowId: 'demo', editToken: null };
    };
  return undefined;
}

export function correctorFor(target: SubmitTarget): CorrectFn | undefined {
  if (target.kind === 'app')
    return async (blockId, rowId, values) => {
      try {
        return await editViewSubmissionAction(target.viewId, blockId, rowId, values);
      } catch {
        return { ok: false, error: 'Sin conexión. Inténtalo otra vez.' };
      }
    };
  if (target.kind === 'public')
    return async (blockId, rowId, values, editToken) => {
      if (!editToken) return { ok: false, error: 'Ya no se puede corregir este envío.' };
      const res = await publicPost<{ message?: string; duplicate?: string | null }>(
        '/api/views/public/submission',
        { token: target.token, blockId, rowId, editToken, values },
      );
      return res.ok
        ? { ok: true, message: res.data.message ?? 'Corregido.', duplicate: res.data.duplicate }
        : { ok: false, error: res.error };
    };
  if (target.kind === 'demo')
    return async () => {
      await new Promise((r) => setTimeout(r, 400));
      return { ok: true, message: 'Corregido (de mentira).' };
    };
  return undefined;
}

/** Sube una foto guardada en el teléfono; el mismo camino que FileInput. */
export function uploaderFor(
  target: SubmitTarget,
  blockId: string,
): (file: File, field: string) => Promise<UploadedFile> {
  return (file, field) => uploadFile(target, blockId, field, file, () => {});
}
