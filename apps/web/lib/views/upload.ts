import 'server-only';
import { randomUUID } from 'node:crypto';
import { mintBlobToken } from '@/lib/blob-token';
import { countRecentFilesDirect, putFileDirect } from '@/lib/files-db';
import { type CustomViewRow, consumeToken } from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import {
  PUBLIC_UPLOADS_PER_HOUR,
  type UploadFieldDef,
  type UploadedFile,
  VIEW_FILES_BUCKET,
  checkUpload,
  checkUploadTarget,
  cleanFileName,
} from './upload-rules';

/**
 * SUBIR UN ARCHIVO A UN CAMPO `file` DE UN FORMULARIO DE VISTA.
 *
 * DÓNDE. app_files, bucket 'view-files', ruta `<org>/<vista>/<uuid>.<ext>`: el
 * prefijo por organización y vista permite contar subidas y borrar todo lo de
 * una vista sin tocar lo demás.
 *
 * CÓMO SE SIRVE. Con el mismo token HMAC de /api/files/blob (lib/blob-token.ts),
 * firmado y de 10 años de vida. Se eligió sobre una ruta propia con permisos
 * porque la URL queda guardada en la fila de la tabla y la ven tanto el equipo
 * (con sesión) como quien abre el enlace público, o un correo/WhatsApp que
 * incruste la foto: ninguno comparte cookie. La URL es inadivinable (firma de
 * 256 bits sobre un uuid) y el valor sólo existe en la fila de una tabla a la
 * que ya se tiene acceso. Contra: no se puede revocar una URL individual sin
 * borrar el archivo (borrar la vista/archivo la invalida).
 *
 * Sólo se aceptan tipos que el navegador no ejecuta (imágenes, pdf, ofimática,
 * csv/txt) y la ruta de descarga manda nosniff, así que un archivo subido no
 * puede ser HTML ni script.
 */

const TEN_YEARS_MS = 10 * 365 * 24 * 3600 * 1000;

export async function readUploadForm(
  form: FormData | null,
): Promise<{ blockId: string; field: string; file: File } | { error: string }> {
  if (!form) return { error: 'Falta el archivo.' };
  const blockId = String(form.get('blockId') ?? '');
  const field = String(form.get('field') ?? '');
  const file = form.get('file');
  if (!blockId || blockId.length > 40 || !field || field.length > 60)
    return { error: 'Falta el formulario o el campo.' };
  if (!(file instanceof File)) return { error: 'No llegó ningún archivo.' };
  return { blockId, field, file };
}

export async function storeViewUpload(
  db: SupabaseClient,
  view: CustomViewRow,
  input: { blockId: string; field: string; file: File },
  opts: { publicLink: boolean },
): Promise<UploadedFile> {
  const block = view.spec.blocks.find((b) => b.id === input.blockId);
  let fields: UploadFieldDef[] = [];
  if (block?.type === 'form') {
    const { data, error } = await db
      .from('trackers')
      .select('fields')
      .eq('slug', block.tracker)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new NotFoundError('La tabla de este formulario ya no existe.');
    fields = ((data as { fields: UploadFieldDef[] }).fields ?? []).filter(Boolean);
  }
  const target = checkUploadTarget(block as never, fields, input.field);
  if (!target.ok) throw new ValidationError(target.error);
  const check = checkUpload(input.file, target.accept);
  if (!check.ok) throw new ValidationError(check.error);

  const orgId = view.organization_id;
  if (!orgId) throw new NotFoundError('Esa vista ya no existe.');
  const prefix = `${orgId}/${view.id}/`;
  // Ráfaga por minuto (cualquier vista) y, en el enlace público, tope por hora.
  try {
    await consumeToken(db, view.id, 'views.upload', 30);
  } catch {
    throw new UploadLimitError();
  }
  if (
    opts.publicLink &&
    (await countRecentFilesDirect(VIEW_FILES_BUCKET, prefix, 3600_000)) >= PUBLIC_UPLOADS_PER_HOUR
  )
    throw new UploadLimitError();

  const path = `${prefix}${randomUUID()}.${check.ext}`;
  await putFileDirect({
    organizationId: orgId,
    bucket: VIEW_FILES_BUCKET,
    path,
    content: Buffer.from(await input.file.arrayBuffer()),
    contentType: check.mime,
  });
  const token = mintBlobToken({
    bucket: VIEW_FILES_BUCKET,
    path,
    expiresAt: Date.now() + TEN_YEARS_MS,
  });
  return {
    url: `/api/files/blob/${token}`,
    name: cleanFileName(input.file.name),
    mime: check.mime,
    size: input.file.size,
  };
}

export class UploadLimitError extends Error {
  constructor() {
    super('Se subieron muchos archivos en poco tiempo. Espera un momento e inténtalo de nuevo.');
    this.name = 'UploadLimitError';
  }
}

export function uploadError(err: unknown): NextResponse {
  if (err instanceof UploadLimitError)
    return NextResponse.json({ error: err.message }, { status: 429 });
  if (err instanceof ValidationError || err instanceof NotFoundError)
    return NextResponse.json({ error: err.message }, { status: 400 });
  return NextResponse.json(
    { error: 'No se pudo subir el archivo. Inténtalo otra vez.' },
    { status: 503 },
  );
}
