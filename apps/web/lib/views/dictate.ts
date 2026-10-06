import {
  type CustomViewRow,
  NO_THINKING,
  chatModel,
  checkMeter,
  consumeToken,
  isRefused,
  transcribeAudio,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { generateObject } from 'ai';
import { z } from 'zod';

/**
 * DICTAR UN REGISTRO EN UNA VISTA.
 *
 * El operario de planta tiene las manos ocupadas y el celular en el bolsillo:
 * escribir «AWB 729-12345675, vuelo AV204, 4 piezas, llegó hoy» campo por campo
 * es lo que hace que no lo registre. Aquí habla una vez y el formulario se
 * llena solo.
 *
 * Dos entradas, una salida:
 *   - TEXTO: lo que el reconocimiento del navegador ya oyó (Chrome, Safari). No
 *     sube audio a ningún lado.
 *   - AUDIO: una grabación corta (Firefox, o cuando el navegador no reconoce
 *     voz). Deepgram la transcribe con la misma llave que las llamadas.
 *
 * La salida es una PROPUESTA de valores para los campos de ESE formulario —
 * nunca se guarda aquí. El formulario se llena, la persona lo mira y aprieta
 * Enviar, y ese envío pasa por `submitViewForm` con todas sus reglas (campos
 * permitidos, esquema, tope por hora, duplicados). Por eso dictar no necesita
 * permisos nuevos: no escribe nada que el formulario no dejara escribir a mano.
 *
 * Lo que sí cuesta es la llamada al modelo (y la transcripción): cuenta como
 * una respuesta del plan de la empresa, con tope por minuto por vista para que
 * un enlace público no sea una canilla abierta.
 */

/** Grabaciones de más de esto no son un registro: son una reunión. */
export const DICTATION_MAX_BYTES = 4 * 1024 * 1024;
export const DICTATION_MAX_CHARS = 1500;
const DICTATIONS_PER_MINUTE = 12;

const AUDIO_MIMES = new Set([
  'audio/webm',
  'audio/ogg',
  'audio/mp4',
  'audio/mpeg',
  'audio/wav',
  'audio/x-wav',
  'audio/x-m4a',
  'audio/aac',
]);

export function isDictationAudio(mime: string): boolean {
  return AUDIO_MIMES.has((mime.split(';')[0] ?? '').trim().toLowerCase());
}

interface DictField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  options?: string[];
}

export type DictationInput = { text: string } | { bytes: Uint8Array; mime: string };

export interface DictationResult {
  /** Lo que se oyó, para mostrarlo debajo del formulario. */
  heard: string;
  /** Sólo los campos que se reconocieron, ya en el formato del input. */
  values: Record<string, string>;
  /** Campos obligatorios que quedaron vacíos: el formulario los señala. */
  missing: string[];
}

export class DictationLimitError extends Error {
  constructor(message = 'Muchos dictados seguidos. Espera un minuto.') {
    super(message);
    this.name = 'DictationLimitError';
  }
}

function todayInBogota(): string {
  // en-CA da AAAA-MM-DD, el formato de los campos de fecha.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

const HOW_TO = `Eres el asistente que llena un formulario a partir de lo que dijo un operario (español de Colombia, a veces con ruido de planta).
Devuelve SOLO los campos que se dijeron o se deducen sin duda. No inventes: si un dato no se dijo, no lo pongas.
Formatos:
- date: AAAA-MM-DD. "hoy", "ayer", "el lunes" se resuelven con la fecha de hoy que viene en el mensaje.
- time: HH:MM en 24 horas ("a las tres de la tarde" = 15:00).
- number / money: sólo dígitos y punto decimal, sin separadores de miles ni símbolo ("cuatro cajas" = 4, "un millón doscientos" = 1200000).
- checkbox: "true" o "false".
- select: exactamente una de las opciones dadas (la más cercana a lo dicho); si ninguna encaja, omítelo.
- text / longtext: tal cual, corrigiendo sólo lo obvio de la transcripción.
Códigos (números de guía, pedido, factura, lote o serie; placas; NIT; referencias): se dictan dígito por dígito o en grupos ("siete veintinueve, uno dos tres..."). Únelos sin espacios, en el formato que sugiera el nombre del campo o los ejemplos (una placa es ABC123; un NIT lleva guion antes del dígito de verificación; una guía aérea AWB es 3 dígitos, guion, 8 dígitos). Si la persona deletrea, respeta lo deletreado.`;

/**
 * Los campos del formulario `blockId` de la vista, leídos de su tabla. Sólo
 * los que el bloque pide, igual que `submitViewForm`.
 */
async function formFields(
  db: SupabaseClient,
  view: CustomViewRow,
  blockId: string,
): Promise<DictField[]> {
  const block = view.spec.blocks.find((b) => b.id === blockId);
  if (!block || block.type !== 'form')
    throw new NotFoundError('Ese formulario no está en esta vista.');
  const { data, error } = await db
    .from('trackers')
    .select('fields')
    .eq('slug', block.tracker)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('La tabla de este formulario ya no existe.');
  const fields = ((data as { fields: DictField[] }).fields ?? []).filter(Boolean);
  const allowed = new Set(block.fields.length ? block.fields : fields.map((f) => f.key));
  // Una foto, una ubicación o una fila de otra tabla no se dictan: se toman o se
  // eligen en el formulario. Ni se le piden al modelo ni se señalan como faltantes.
  return fields.filter((f) => allowed.has(f.key) && !NOT_DICTATED.has(f.type));
}

const NOT_DICTATED: ReadonlySet<string> = new Set(['file', 'location', 'relation']);

/**
 * Un número como lo escribe el modelo o la persona en Colombia: «1.200.000»
 * es un millón doscientos mil (punto de miles), «3,5» es tres y medio (coma
 * decimal), «1200000» y «3.5» también valen. Lo que no es un número: null.
 */
export function parseSpokenNumber(raw: string): number | null {
  let s = raw.replace(/[$\s]/g, '').replace(/^COP/i, '');
  if (!/^-?[\d.,]+$/.test(s) || !/\d/.test(s)) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Normaliza lo que propuso el modelo al formato exacto de cada input. */
export function shapeDictated(
  fields: DictField[],
  proposed: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    const raw = proposed[f.key];
    if (raw === undefined || raw === null) continue;
    const s = String(raw).trim();
    if (!s) continue;
    switch (f.type) {
      case 'date':
        if (/^\d{4}-\d{2}-\d{2}$/.test(s)) out[f.key] = s;
        break;
      case 'time': {
        const m = /^(\d{1,2}):(\d{2})$/.exec(s);
        if (m && Number(m[1]) < 24 && Number(m[2]) < 60)
          out[f.key] = `${m[1]?.padStart(2, '0')}:${m[2]}`;
        break;
      }
      case 'number':
      case 'money': {
        const n = parseSpokenNumber(s);
        if (n !== null) out[f.key] = String(n);
        break;
      }
      case 'checkbox':
        if (/^(true|s[ií]|yes|1)$/i.test(s)) out[f.key] = 'true';
        else if (/^(false|no|0)$/i.test(s)) out[f.key] = 'false';
        break;
      case 'select': {
        const hit = f.options?.find((o) => o.toLowerCase() === s.toLowerCase());
        if (hit) out[f.key] = hit;
        break;
      }
      case 'file':
      case 'location':
      case 'relation':
        break;
      default:
        out[f.key] = s.slice(0, f.type === 'longtext' ? 2000 : 400);
    }
  }
  return out;
}

export async function dictateForm(
  db: SupabaseClient,
  view: CustomViewRow,
  blockId: string,
  input: DictationInput,
  opts: { signal?: AbortSignal } = {},
): Promise<DictationResult> {
  const fields = await formFields(db, view, blockId);
  if (!fields.length) throw new ValidationError('Este formulario no tiene campos para llenar.');

  // Tope por vista, no por persona: en un enlace público no hay persona.
  try {
    await consumeToken(db, view.id, 'views.dictate', DICTATIONS_PER_MINUTE);
  } catch {
    throw new DictationLimitError();
  }
  if (isRefused(await checkMeter(db, 'answers')))
    throw new DictationLimitError('El plan de la empresa no tiene respuestas disponibles.');

  let heard: string;
  if ('text' in input) {
    heard = input.text.trim().slice(0, DICTATION_MAX_CHARS);
  } else {
    const res = await transcribeAudio({ bytes: input.bytes, mime: input.mime }, { logger });
    if (!res.ok) {
      throw res.configured
        ? new ValidationError('No te entendí. Intenta otra vez, más cerca del micrófono.')
        : new ValidationError('El dictado por audio no está activo; usa el micrófono de Chrome.');
    }
    heard = res.data.turns
      .map((t) => t.text)
      .join(' ')
      .trim()
      .slice(0, DICTATION_MAX_CHARS);
  }
  if (!heard) throw new ValidationError('No se oyó nada. Intenta otra vez.');

  const schema = z.object({
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
      AbortSignal.timeout(25000),
    ]),
    system: HOW_TO,
    prompt: JSON.stringify({
      today: todayInBogota(),
      fields: fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        ...(f.options?.length ? { options: f.options } : {}),
      })),
      said: heard,
    }),
  });

  const values = shapeDictated(fields, object.values as Record<string, unknown>);
  const missing = fields.filter((f) => f.required && !values[f.key]).map((f) => f.key);
  return { heard, values, missing };
}
