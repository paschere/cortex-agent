import {
  type CustomViewRow,
  NO_THINKING,
  chatModel,
  checkMeter,
  consumeToken,
  isRefused,
  transcribeAudio,
} from '@cortex/agent-tools';
import { ValidationError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateObject } from 'ai';
import { z } from 'zod';
import {
  DICTATION_MAX_CHARS,
  type DictationInput,
  DictationLimitError,
  HOW_TO,
  formFields,
  shapeDictated,
  todayInBogota,
} from './dictate';
import { VOICE_COMMANDS, type VoiceCommand } from './voice-form';

/**
 * UN TURNO DEL ASISTENTE DE VOZ, LO QUE NO ES SIMPLE.
 *
 * El motor del navegador (voice-form.ts) entiende solo los comandos y las
 * respuestas simples a un campo. Cuando la persona dice algo que trae varios
 * datos («guía 045…, vuelo AV204, 4 piezas») o que no se pudo leer, el
 * navegador manda aquí lo que oyó, el campo que se estaba preguntando y lo que
 * ya lleva, y el modelo devuelve los valores de CUALQUIER campo del formulario
 * y, si en realidad era una orden («salta», «corrige el vuelo»), cuál.
 *
 * Igual que el dictado: NO guarda nada (el envío sale por el formulario, con
 * todas sus reglas), pasa por las mismas puertas que el dictado (sesión o token
 * + contraseña, ver las rutas), tiene su tope por minuto por vista y la llamada
 * al modelo cuenta como una respuesta del plan. Cuando el navegador no puede
 * transcribir (Firefox), manda el audio con `transcribeOnly`: se transcribe y
 * se devuelve el texto sin llamar al modelo, para que el motor lo intente
 * primero y sólo pregunte aquí si hace falta.
 */

/** Una conversación hace muchos turnos; el dictado, uno. Tope por minuto y por vista. */
const TURNS_PER_MINUTE = 40;

export interface VoiceTurnInput {
  blockId: string;
  input: DictationInput;
  /** La clave del campo que se estaba preguntando. */
  current?: string;
  /** Lo que el formulario ya lleva (contexto; no se pisa sin que lo pidan). */
  values: Record<string, string>;
  transcribeOnly?: boolean;
}

export interface VoiceTurnResult {
  heard: string;
  values: Record<string, string>;
  command: VoiceCommand | null;
  commandField: string | null;
}

const TURN_HOW_TO = `${HOW_TO}

ESTÁS EN UNA CONVERSACIÓN: la persona llena el formulario hablando y se le pregunta campo por campo. El mensaje trae "asking" (el campo que se le preguntó, o null) y "have" (lo que ya se llenó).
- Si lo dicho responde a "asking", ponlo en ese campo. Si además trae datos de OTROS campos, pon también esos.
- No cambies un campo de "have" salvo que la persona lo corrija expresamente.
- Si lo dicho es una ORDEN para el asistente y no un dato, devuelve "command" y deja "values" vacío: repeat (repite), skip (salta, ese no), back (atrás), cancel (cancela, olvídalo), read (lee lo que llevo), send (enviar, ya está), correct (corrige/cambia un campo; pon en "commandField" la clave de ese campo si lo nombró).
- Un texto libre («nota», «descripción») se queda tal cual. Si nada de lo dicho sirve, devuelve todo vacío.`;

export async function voiceTurn(
  db: SupabaseClient,
  view: CustomViewRow,
  req: VoiceTurnInput,
  opts: { signal?: AbortSignal } = {},
): Promise<VoiceTurnResult> {
  const fields = await formFields(db, view, req.blockId);
  if (!fields.length) throw new ValidationError('Este formulario no tiene campos para llenar.');

  try {
    await consumeToken(db, view.id, 'views.voice_turn', TURNS_PER_MINUTE);
  } catch {
    throw new DictationLimitError('Muchos turnos seguidos. Espera un momento.');
  }

  let heard: string;
  if ('text' in req.input) {
    heard = req.input.text.trim().slice(0, DICTATION_MAX_CHARS);
  } else {
    const res = await transcribeAudio({ bytes: req.input.bytes, mime: req.input.mime }, { logger });
    if (!res.ok) {
      throw res.configured
        ? new ValidationError('No te entendí. Intenta otra vez, más cerca del micrófono.')
        : new ValidationError('La voz por audio no está activa; usa Chrome o Safari.');
    }
    heard = res.data.turns
      .map((t) => t.text)
      .join(' ')
      .trim()
      .slice(0, DICTATION_MAX_CHARS);
  }
  if (!heard) throw new ValidationError('No se oyó nada. Intenta otra vez.');
  if (req.transcribeOnly) return { heard, values: {}, command: null, commandField: null };

  if (isRefused(await checkMeter(db, 'answers')))
    throw new DictationLimitError('El plan de la empresa no tiene respuestas disponibles.');

  const schema = z.object({
    command: z.enum(VOICE_COMMANDS).nullable().optional(),
    commandField: z.string().nullable().optional(),
    values: z
      .object(Object.fromEntries(fields.map((f) => [f.key, z.string().optional()])))
      .partial(),
  });
  const { object } = await generateObject({
    model: chatModel(),
    experimental_providerMetadata: NO_THINKING,
    schema,
    maxTokens: 1200,
    abortSignal: AbortSignal.any([
      ...(opts.signal ? [opts.signal] : []),
      AbortSignal.timeout(20000),
    ]),
    system: TURN_HOW_TO,
    prompt: JSON.stringify({
      today: todayInBogota(),
      fields: fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        ...(f.options?.length ? { options: f.options } : {}),
      })),
      asking: req.current && fields.some((f) => f.key === req.current) ? req.current : null,
      have: Object.fromEntries(
        Object.entries(req.values).filter(([k, v]) => fields.some((f) => f.key === k) && v),
      ),
      said: heard,
    }),
  });

  const command = object.command ?? null;
  const known = new Set(fields.map((f) => f.key));
  return {
    heard,
    values: command ? {} : shapeDictated(fields, object.values as Record<string, unknown>),
    command,
    commandField:
      command === 'correct' && object.commandField && known.has(object.commandField)
        ? object.commandField
        : null,
  };
}
