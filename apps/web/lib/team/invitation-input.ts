/**
 * Pegar varios correos de una vez: separarlos, validarlos y quitar repetidos.
 *
 * Quien arma un equipo no tiene los correos uno por uno: los copia de un chat,
 * de una hoja o del «Para:» de un correo, así que llegan separados por comas,
 * puntos y coma, espacios, saltos de línea, o como «Ana <ana@x.com>». Esto lo
 * absorbe todo sin pedir que se limpie antes.
 *
 * Es puro y lo comparten el formulario (para pintar chips en vivo) y la ruta
 * (que NO se fía de lo que validó el navegador y vuelve a pasarlo por aquí).
 */

/** Tope por petición: invitar es lento (cada una manda un correo) y cada una compra un asiento. */
export const MAX_INVITES_PER_REQUEST = 25;

// Deliberadamente simple: la validación de verdad la hace zod en la ruta. Esto
// sólo decide qué se pinta como chip y qué como «no parece un correo».
const EMAIL_SHAPE = /^[^\s@<>()[\]"',;]+@[^\s@<>()[\]"',;]+\.[^\s@<>()[\]"',;]{2,}$/;

export function looksLikeEmail(value: string): boolean {
  return EMAIL_SHAPE.test(value) && value.length <= 254;
}

export interface ParsedEmails {
  /** Correos con forma válida, en minúsculas, sin repetir, en el orden en que llegaron. */
  valid: string[];
  /** Lo que no parece un correo, tal como se escribió (sin repetir). */
  invalid: string[];
  /** Cuántos correos válidos se repetían y se descartaron. */
  duplicates: number;
}

function clean(token: string): string {
  // «Ana <ana@x.com>» → «ana@x.com»; quita comillas y puntuación de los bordes.
  const angle = token.match(/<([^<>]+)>/);
  const inner = angle?.[1] ?? token;
  return inner.replace(/^[\s"'(<[]+|[\s"')>\].:]+$/g, '');
}

export function parseEmailList(raw: string): ParsedEmails {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalidSeen = new Set<string>();
  const invalid: string[] = [];
  let duplicates = 0;

  // «Ana Restrepo <ana@x.com>» trae espacios dentro del nombre: se separa por
  // comas, punto y coma y saltos de línea primero, y sólo después por espacios
  // cuando el trozo no trae un «<correo>».
  const chunks = raw.split(/[,;\n\r]+/).flatMap((chunk) => {
    return /<[^<>]+>/.test(chunk) ? [chunk] : chunk.split(/\s+/);
  });

  for (const chunk of chunks) {
    const token = clean(chunk.trim());
    if (!token) continue;
    if (looksLikeEmail(token)) {
      const email = token.toLowerCase();
      if (seen.has(email)) {
        duplicates += 1;
        continue;
      }
      seen.add(email);
      valid.push(email);
    } else if (!invalidSeen.has(token)) {
      invalidSeen.add(token);
      invalid.push(token);
    }
  }
  return { valid, invalid, duplicates };
}

/** Lo que pasó con CADA correo; es lo que la pantalla pinta, uno por fila. */
export type InviteStatus =
  | 'sent'
  | 'already_member'
  | 'already_invited'
  | 'no_seats'
  | 'invalid'
  | 'failed';

export interface InviteEmailResult {
  email: string;
  status: InviteStatus;
  /** Frase lista para mostrar; la de `sent` es corta, las demás explican qué hacer. */
  message: string;
  /** El id de la invitación, para copiar el enlace. Sólo cuando se envió. */
  id?: string | null;
}

export const STATUS_LABEL: Record<InviteStatus, string> = {
  sent: 'Enviada',
  already_member: 'Ya es miembro',
  already_invited: 'Ya estaba invitada',
  no_seats: 'Sin cupo',
  invalid: 'Correo inválido',
  failed: 'No se pudo enviar',
};
