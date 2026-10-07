import { readDictation } from './dictate-request';
import type { VoiceTurnInput } from './voice-turn';

/**
 * Lo común de las dos puertas del turno de voz: el mismo cuerpo multipart del
 * dictado (`blockId` y `text` o `audio`) más `current` (el campo que se
 * preguntaba), `values` (JSON con lo que el formulario ya lleva) y
 * `transcribeOnly` (sólo transcribir un audio). Los errores se traducen igual
 * que en el dictado (`dictationError`).
 */

const MAX_VALUES_CHARS = 8000;

export async function readVoiceTurn(
  form: FormData | null,
): Promise<VoiceTurnInput | { error: string }> {
  const base = await readDictation(form);
  if ('error' in base || !form) return 'error' in base ? base : { error: 'Falta el turno.' };

  const current = String(form.get('current') ?? '');
  const rawValues = String(form.get('values') ?? '');
  if (rawValues.length > MAX_VALUES_CHARS) return { error: 'El formulario lleva demasiado texto.' };
  const values: Record<string, string> = {};
  if (rawValues) {
    try {
      const parsed: unknown = JSON.parse(rawValues);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return { error: 'No entendí lo que lleva el formulario.' };
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
        if (typeof v === 'string' && k.length <= 60) values[k] = v.slice(0, 2000);
    } catch {
      return { error: 'No entendí lo que lleva el formulario.' };
    }
  }
  return {
    blockId: base.blockId,
    input: base.input,
    current: current && current.length <= 60 ? current : undefined,
    values,
    transcribeOnly: form.get('transcribeOnly') === '1',
  };
}
