import { createHash } from 'node:crypto';
import { ValidationError } from '@cortex/core';
import { z } from 'zod';
import { registerTool } from '../index';
import { parseFileValue } from '../trackers/schema';
import { driveGet, driveUploadFile } from './client';

/**
 * SUBIR A DRIVE UN ARCHIVO QUE YA ESTÁ EN CORTEX (el valor de un campo `file`).
 *
 * ===========================================================================
 * POR QUÉ EL ALCANCE `drive` Y NO `drive.file`
 * ===========================================================================
 * `drive.file` (el no restringido) sólo deja tocar archivos y carpetas que LA
 * APP creó o que la persona abrió con el selector de Google. Aquí la carpeta
 * («Vuelos / AV204 / 045-12345678») la crea la empresa a mano, mucho antes y
 * sin Cortex: para Google es una carpeta que la app nunca vio, y `drive.file`
 * contesta 404 al intentar escribirle. El único alcance que permite escribir en
 * una carpeta ajena existente es `drive` completo.
 *
 * COSTO: `drive` es un alcance RESTRINGIDO. Mientras la app de Google no pase la
 * verificación (revisión de seguridad anual) vive en modo «prueba»/sin verificar:
 * sólo entran los usuarios de prueba que se agreguen en la consola de Google
 * (tope de 100) y la pantalla de consentimiento muestra la advertencia. Por eso
 * es OPCIONAL: sólo se pide cuando alguien pulsa «Permitir que Cortex guarde
 * archivos en tu Drive» (/api/integrations/google?preset=drive_write) y quien no
 * lo pulsa sigue con lectura. Nadie tiene que reconectar si no usa esto.
 *
 * Reglas: la carpeta tiene que existir (nunca se crea una), tiene que ser una
 * carpeta donde quien conectó puede escribir, y subir dos veces el MISMO archivo
 * a la MISMA carpeta no duplica: la llave va en `appProperties` del archivo en
 * Drive, así que Drive mismo es el registro de qué se subió (con su id).
 */

export const DRIVE_FULL = 'https://www.googleapis.com/auth/drive';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const DRIVE_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

export const MISSING_WRITE_SCOPE_MESSAGE =
  'Cortex todavía no tiene permiso para guardar archivos en tu Drive. Pulsa «Permitir que Cortex guarde archivos en tu Drive» (Conocimiento → Google Drive, o /api/integrations/google?preset=drive_write) y acepta el permiso; después repite esto. Sin ese permiso sólo puede leer.';

/** La llave de idempotencia: el mismo archivo de Cortex en la misma carpeta. */
export function uploadKey(folderId: string, sourceUrl: string): string {
  return createHash('sha256').update(`${folderId}|${sourceUrl}`).digest('hex').slice(0, 32);
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const fileOut = z.object({
  name: z.string(),
  driveFileId: z.string().nullable(),
  link: z.string().nullable(),
  status: z.enum(['uploaded', 'already_there', 'failed']),
  error: z.string().nullable(),
});

export const gdriveUploadFile = registerTool({
  id: 'gdrive.upload_file',
  description:
    'Save a file that is already in Cortex (the value of a `file` field of a table row: pass it exactly as stored, {url,name,mime,size} or the array of them) into an EXISTING Google Drive folder (folderId from gdrive.find_folder). Never creates folders. Uploading the same file to the same folder twice does nothing the second time (it reports already_there with the same Drive id/link), so it is safe to repeat. Needs the optional Drive write permission; if it is missing the error says how to grant it. Returns the Drive id and link of each file so you can write the link in the row. Requires confirmation in chat.',
  inputSchema: z.object({
    folderId: z
      .string()
      .trim()
      .min(5)
      .max(120)
      .describe('Drive folder id (from gdrive.find_folder)'),
    file: z
      .unknown()
      .describe('The file field value: {url,name,mime,size}, a JSON string of it, or an array'),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(180)
      .optional()
      .describe('Name in Drive (only when a single file is passed); default: its own name'),
  }),
  outputSchema: z.object({
    folderName: z.string(),
    files: z.array(fileOut),
    summary: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    if (!(await ctx.integrations.hasScopes('google', [DRIVE_FULL])))
      throw new ValidationError(MISSING_WRITE_SCOPE_MESSAGE);
    const refs = parseFileValue(input.file);
    if (!refs || refs.length === 0)
      throw new ValidationError(
        'No hay ningún archivo en ese valor: pásalo tal como está en la fila.',
      );
    if (!ctx.readStoredFile)
      throw new ValidationError('Aquí no puedo leer los archivos guardados en Cortex.');

    const folder = await driveGet<{
      id: string;
      name: string;
      mimeType: string;
      trashed?: boolean;
      capabilities?: { canAddChildren?: boolean };
    }>(ctx, `/files/${encodeURIComponent(input.folderId)}`, {
      fields: 'id,name,mimeType,trashed,capabilities(canAddChildren)',
      supportsAllDrives: 'true',
    });
    if (folder.mimeType !== FOLDER_MIME || folder.trashed)
      throw new ValidationError('Ese id no es una carpeta de Drive disponible.');
    if (folder.capabilities?.canAddChildren === false)
      throw new ValidationError(
        `No tienes permiso para agregar archivos en «${folder.name}»; pide acceso de editor a esa carpeta.`,
      );

    const files: Array<z.infer<typeof fileOut>> = [];
    for (const ref of refs) {
      const name = (refs.length === 1 ? input.fileName : undefined) ?? ref.name;
      const key = uploadKey(folder.id, ref.url);
      try {
        const existing = await driveGet<{ files?: Array<{ id: string; webViewLink?: string }> }>(
          ctx,
          '/files',
          {
            q: `'${esc(folder.id)}' in parents and trashed = false and appProperties has { key='cortexSrc' and value='${key}' }`,
            fields: 'files(id,webViewLink)',
            pageSize: '1',
            supportsAllDrives: 'true',
            includeItemsFromAllDrives: 'true',
          },
        );
        const prior = existing.files?.[0];
        if (prior) {
          files.push({
            name,
            driveFileId: prior.id,
            link: prior.webViewLink ?? null,
            status: 'already_there',
            error: null,
          });
          continue;
        }
        const stored = await ctx.readStoredFile(ref.url);
        if (!stored) throw new Error('El archivo ya no está en Cortex.');
        if (stored.bytes.byteLength > DRIVE_UPLOAD_MAX_BYTES)
          throw new Error('El archivo pasa de 20 MB.');
        const up = await driveUploadFile(ctx, {
          folderId: folder.id,
          name,
          mime: stored.mime ?? ref.mime ?? 'application/octet-stream',
          bytes: stored.bytes,
          appProperties: { cortexSrc: key },
        });
        files.push({
          name: up.name,
          driveFileId: up.id,
          link: up.webViewLink,
          status: 'uploaded',
          error: null,
        });
      } catch (err) {
        files.push({
          name,
          driveFileId: null,
          link: null,
          status: 'failed',
          error: err instanceof Error ? err.message.slice(0, 300) : String(err),
        });
      }
    }
    const up = files.filter((f) => f.status === 'uploaded').length;
    const there = files.filter((f) => f.status === 'already_there').length;
    const bad = files.filter((f) => f.status === 'failed').length;
    return {
      folderName: folder.name,
      files,
      summary: `En «${folder.name}»: ${up} subido${up === 1 ? '' : 's'}, ${there} ya estaba${there === 1 ? '' : 'n'}${bad ? `, ${bad} con error` : ''}.`,
    };
  },
});
