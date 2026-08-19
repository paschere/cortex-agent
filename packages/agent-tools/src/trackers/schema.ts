import { z } from 'zod';

/**
 * El esquema de una tabla inventada, y por qué se valida aquí y no en Postgres.
 *
 * El CHECK de la 0115 sólo exige que `fields` sea un array. La forma de cada
 * campo —clave, tipo, opciones de un select— vive aquí porque añadir un tipo
 * mañana es una constante más, no una migración más un despliegue más. El
 * agente escribe este JSON; si se deja pasar un campo sin clave, las filas
 * posteriores no se pueden consultar por nombre.
 */

export const TRACKER_SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;
export const FIELD_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

export const FIELD_TYPES = ['text', 'number', 'date', 'money', 'select'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const trackerFieldSchema = z
  .object({
    key: z.string().regex(FIELD_KEY_RE),
    label: z.string().trim().min(1).max(60),
    type: z.enum(FIELD_TYPES),
    required: z.boolean().default(false),
    options: z.array(z.string().trim().min(1).max(80)).max(30).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.type === 'select' && (!field.options || field.options.length < 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Un campo de opciones necesita al menos una.',
        path: ['options'],
      });
    }
  });

export type TrackerField = z.infer<typeof trackerFieldSchema>;

export const trackerFieldsSchema = z
  .array(trackerFieldSchema)
  .min(1)
  .max(20)
  .superRefine((fields, ctx) => {
    const seen = new Set<string>();
    for (const [i, field] of fields.entries()) {
      if (seen.has(field.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `La clave «${field.key}» está repetida.`,
          path: [i, 'key'],
        });
      }
      seen.add(field.key);
    }
  });

export const trackerSlugSchema = z.string().trim().regex(TRACKER_SLUG_RE);

export function fieldByKey(fields: TrackerField[], key: string): TrackerField | undefined {
  return fields.find((f) => f.key === key);
}

/**
 * Convierte lo que el modelo mandó en un valor que este campo acepta.
 * Devuelve el valor listo para JSON, o un mensaje de error en español.
 */
export function coerceValue(
  field: TrackerField,
  raw: unknown,
): { ok: true; value: string | number } | { ok: false; message: string } {
  if (raw === undefined || raw === null || raw === '') {
    if (field.required) return { ok: false, message: `Falta «${field.label}».` };
    return { ok: true, value: '' };
  }

  switch (field.type) {
    case 'text':
    case 'date': {
      if (typeof raw !== 'string') {
        return { ok: false, message: `«${field.label}» tiene que ser texto.` };
      }
      const value = raw.trim();
      if (value.length > 400) {
        return { ok: false, message: `«${field.label}» es demasiado largo.` };
      }
      if (field.type === 'date' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return { ok: false, message: `«${field.label}» tiene que ser una fecha YYYY-MM-DD.` };
      }
      return { ok: true, value };
    }
    case 'number':
    case 'money': {
      const n =
        typeof raw === 'number'
          ? raw
          : typeof raw === 'string'
            ? Number(raw.replace(',', '.'))
            : Number.NaN;
      if (!Number.isFinite(n)) {
        return { ok: false, message: `«${field.label}» tiene que ser un número.` };
      }
      return { ok: true, value: n };
    }
    case 'select': {
      const value = String(raw).trim();
      if (!field.options?.includes(value)) {
        return {
          ok: false,
          message: `«${field.label}» tiene que ser una de: ${field.options?.join(', ')}.`,
        };
      }
      return { ok: true, value };
    }
  }
}

/** Cómo se nombra una fila en voz alta: el primer texto, o lo que manden. */
export function rowLabel(
  fields: TrackerField[],
  values: Record<string, string | number>,
  explicit?: string,
): string {
  const named = explicit?.trim();
  if (named) return named.slice(0, 200);
  const preferred =
    fields.find((f) => f.type === 'text' && f.required) ?? fields.find((f) => f.type === 'text');
  if (preferred) {
    const value = values[preferred.key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  }
  return 'Sin nombre';
}
