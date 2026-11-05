import 'server-only';
import { DICTATION_MAX_BYTES, isDictationAudio } from '@/lib/views/dictate';
import {
  CODE_SCAN_MAX_BYTES,
  type CodeScanKind,
  type CodeScanOutput,
  scanFreeDocument,
} from '@/lib/views/scan-doc';
import { storeChecked } from '@/lib/views/upload';
import {
  type CustomViewRow,
  type StoredUpload,
  checkMeter,
  consumeToken,
  isRefused,
  transcribeAudio,
} from '@cortex/agent-tools';
import { ValidationError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

/**
 * LO QUE NECESITA UN ARCHIVO O UNA GRABACIÓN en las pantallas con código: leer un documento con
 * visión (`docs.scan`), pasar voz a texto (`voice.transcribe`) y guardar un archivo (`files.upload`).
 * Las tres llegan como multipart a la ruta del SDK (el iframe no puede subir nada por sí mismo);
 * el permiso de cada una lo decide la ruta o `runSdkOp`, aquí solo se hace el trabajo.
 */

const VOICE_PER_MINUTE = 12;

const scanArgs = z.object({
  kind: z.enum(['manifiesto', 'guia', 'general']).default('general'),
  rows: z.boolean().optional(),
});

/** `docs.scan`: foto o PDF de hasta 4 MB → `{fields, rows, text?}`. Nada se guarda. */
export async function runDocsScan(
  db: SupabaseClient,
  userId: string,
  args: unknown,
  file: File,
  signal?: AbortSignal,
): Promise<CodeScanOutput> {
  const parsed = scanArgs.safeParse(args ?? {});
  if (!parsed.success) throw new ValidationError('Las opciones de la lectura no son válidas.');
  const kind: CodeScanKind = parsed.data.kind;
  if (file.size > CODE_SCAN_MAX_BYTES)
    throw new ValidationError('El archivo pesa más de 4 MB. Tómalo otra vez más cerca.');
  return scanFreeDocument({
    db,
    userId,
    kind,
    rows: parsed.data.rows ?? kind === 'manifiesto',
    image: { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type },
    signal,
  });
}

/** `voice.transcribe`: la misma transcripción del dictado (Deepgram); si falta la llave, lo dice. */
export async function runVoiceTranscribe(
  db: SupabaseClient,
  userId: string,
  file: File,
): Promise<{ text: string }> {
  if (!file.size) throw new ValidationError('La grabación llegó vacía.');
  if (file.size > DICTATION_MAX_BYTES)
    throw new ValidationError('La grabación es muy larga (máximo 4 MB).');
  if (!isDictationAudio(file.type)) throw new ValidationError('Ese formato de audio no lo leo.');
  try {
    await consumeToken(db, userId, 'apps.sdk.voice', VOICE_PER_MINUTE);
  } catch {
    throw new ValidationError('Muchas grabaciones seguidas. Espera un momento.');
  }
  if (isRefused(await checkMeter(db, 'answers')))
    throw new ValidationError('El plan de la empresa no tiene respuestas disponibles.');
  const res = await transcribeAudio(
    { bytes: new Uint8Array(await file.arrayBuffer()), mime: file.type },
    { logger },
  );
  if (!res.ok) {
    throw res.configured
      ? new ValidationError('No te entendí. Intenta otra vez, más cerca del micrófono.')
      : new ValidationError(
          'La transcripción de voz no está activa en esta instalación (falta la llave DEEPGRAM_API_KEY). Escribe el texto a mano.',
        );
  }
  const text = res.data.turns
    .map((t) => t.text)
    .join(' ')
    .trim();
  if (!text) throw new ValidationError('No se oyó nada. Intenta otra vez.');
  return { text };
}

/** El guardado de `files.upload`: mismo bucket, ruta y firma que los campos `file` de los formularios. */
export function uploadStore(
  db: SupabaseClient,
  view: CustomViewRow,
  file: File,
  opts: { publicLink: boolean },
) {
  return {
    file: { name: file.name, type: file.type, size: file.size },
    store: (accept: 'image' | 'any', name: string): Promise<StoredUpload> =>
      storeChecked(
        db,
        view,
        { blockId: 'code', field: 'file', file: name === file.name ? file : renamed(file, name) },
        opts,
        accept,
      ),
  };
}

function renamed(file: File, name: string): File {
  return new File([file], name, { type: file.type, lastModified: file.lastModified });
}
