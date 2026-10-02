import { createHash } from 'node:crypto';

/**
 * LA HUELLA DE UNA ACCIÓN.
 *
 * Dos llamadas son «la misma acción» cuando dicen lo mismo, no cuando se
 * escriben igual. Un modelo que reintenta no garantiza el orden de las claves
 * del objeto, ni que deje `cc: null` en vez de omitirlo, ni el mismo espacio al
 * final del cuerpo. Si la huella dependiera de eso, la guardia fallaría
 * justamente en el caso para el que existe — el reintento — y lo haría en
 * silencio, enviando dos veces.
 *
 * Así que antes de calcular el hash:
 *   · las claves de cada objeto se ordenan;
 *   · `null` y `undefined` se tratan como ausentes;
 *   · cada texto se normaliza a NFC, se recorta y los tramos de espacios se
 *     reducen a uno;
 *   · el orden de los arreglos SE RESPETA: en general significa algo, y la
 *     herramienta que quiera ignorarlo lo dice en su `key`.
 *
 * Lo que NO hace: adivinar equivalencias de negocio (mayúsculas en un correo,
 * «$1.000» contra «1000»). Eso es una decisión de la herramienta, no de esta
 * función.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === null || v === undefined) continue;
      out[k] = canonicalize(v);
    }
    return out;
  }
  // Funciones, símbolos: no forman parte de una intención.
  return null;
}

/** JSON estable: el mismo valor canónico siempre da la misma cadena. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export interface KeyMaterial {
  organizationId: string;
  /** Quién actúa. La misma acción pedida por dos personas son dos acciones. */
  actorId: string;
  toolId: string;
  /** El input (o lo que la política diga que identifica la acción). */
  input: unknown;
  /**
   * El alcance explícito, cuando lo hay: la ejecución de una rutina
   * (`routine:<id>:<hora programada>`). Un reintento de esa ejecución cae en la
   * misma clave; la ejecución de mañana, no.
   */
  scope?: string | null;
}

/** sha256 en hex (64 caracteres) de la huella canónica. */
export function idempotencyKey(m: KeyMaterial): string {
  const material = canonicalJson({
    v: 1,
    org: m.organizationId,
    actor: m.actorId,
    tool: m.toolId,
    input: m.input,
    scope: m.scope ?? null,
  });
  return createHash('sha256').update(material).digest('hex');
}
