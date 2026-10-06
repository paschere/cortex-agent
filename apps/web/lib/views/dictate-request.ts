import { NotFoundError, ValidationError } from '@cortex/core';
import { NextResponse } from 'next/server';
import {
  DICTATION_MAX_BYTES,
  DICTATION_MAX_CHARS,
  type DictationInput,
  DictationLimitError,
  isDictationAudio,
} from './dictate';

/**
 * Lo común de las dos puertas del dictado (dentro de la app y el enlace
 * público): leer el formData y traducir los errores a respuestas. La lógica
 * vive en `dictate.ts`.
 *
 * El cuerpo es multipart: `blockId` y, o `text` (lo que oyó el navegador), o
 * `audio` (la grabación).
 */
export async function readDictation(
  form: FormData | null,
): Promise<{ blockId: string; input: DictationInput } | { error: string }> {
  if (!form) return { error: 'Falta el dictado.' };
  const blockId = String(form.get('blockId') ?? '');
  if (!blockId || blockId.length > 40) return { error: 'Falta el formulario.' };
  const text = form.get('text');
  if (typeof text === 'string' && text.trim()) {
    if (text.length > DICTATION_MAX_CHARS) return { error: 'El dictado es demasiado largo.' };
    return { blockId, input: { text } };
  }
  const audio = form.get('audio');
  if (audio instanceof Blob && audio.size > 0) {
    if (audio.size > DICTATION_MAX_BYTES)
      return { error: 'La grabación es muy larga: dicta un registro a la vez.' };
    if (!isDictationAudio(audio.type)) return { error: 'Ese formato de audio no lo leo.' };
    return {
      blockId,
      input: { bytes: new Uint8Array(await audio.arrayBuffer()), mime: audio.type },
    };
  }
  return { error: 'No llegó ni texto ni audio.' };
}

export function dictationError(err: unknown): NextResponse {
  if (err instanceof DictationLimitError)
    return NextResponse.json({ error: err.message }, { status: 429 });
  if (err instanceof ValidationError || err instanceof NotFoundError)
    return NextResponse.json({ error: err.message }, { status: 400 });
  return NextResponse.json(
    { error: 'No pude entender el dictado ahora. Llena los campos a mano.' },
    { status: 503 },
  );
}
