/**
 * «Pide tu acceso»: el formulario público, sus reglas y sus palabras.
 *
 * Sin directiva y sin imports de servidor: lo leen la página pública, el
 * endpoint y las pruebas.
 */

export interface AccessRequestInput {
  name: string;
  company: string;
  email: string;
  phone: string | null;
  message: string | null;
}

export const ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'signed_up'] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

export const ACCESS_REQUEST_STATUS_LABEL: Record<AccessRequestStatus, string> = {
  pending: 'Por revisar',
  approved: 'Aprobada',
  rejected: 'Rechazada',
  signed_up: 'Ya entró',
};

/** Días que vale un código aprobado. */
export const ACCESS_CODE_DAYS = 14;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

/**
 * Valida lo que llega del navegador. Devuelve los campos limpios o la primera
 * frase de error en español, que es lo que se le muestra a la persona.
 *
 * `website` es la trampa para robots: un campo invisible que una persona nunca
 * llena. Si llega con algo, se responde como si todo hubiera salido bien y no
 * se guarda nada — decirle al robot que lo atrapamos sólo le enseña.
 */
export function parseAccessRequest(
  body: unknown,
): { ok: true; value: AccessRequestInput } | { ok: false; error: string } | { ok: 'trap' } {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (clean(raw.website, 200)) return { ok: 'trap' };
  const name = clean(raw.name, 120);
  const company = clean(raw.company, 160);
  const email = clean(raw.email, 254).toLowerCase();
  const phone = clean(raw.phone, 40) || null;
  const message =
    typeof raw.message === 'string' ? raw.message.trim().slice(0, 2000) || null : null;
  if (name.length < 2) return { ok: false, error: 'Escribe tu nombre.' };
  if (company.length < 2) return { ok: false, error: 'Escribe el nombre de tu empresa.' };
  if (!EMAIL_RE.test(email)) return { ok: false, error: 'Revisa el correo: no parece válido.' };
  if (phone && !/^[+\d][\d\s().-]{5,39}$/.test(phone)) {
    return { ok: false, error: 'Revisa el teléfono: sólo números, espacios y +.' };
  }
  return { ok: true, value: { name, company, email, phone, message } };
}
