/**
 * QUÉ VERSIÓN DE CADA DOCUMENTO ESTÁ VIGENTE, Y QUIÉN TIENE QUE ACEPTARLA.
 *
 * La autorización de la Ley 1581 tiene que ser previa, expresa e informada, y
 * hay que poder probarla (art. 9; Decreto 1377 art. 7). «Informada» quiere decir
 * sobre un texto concreto: si el texto cambia de forma sustancial, la
 * autorización que se dio sobre el anterior no cubre el nuevo. Por eso cada
 * aceptación se guarda con la versión (`legal_consents.version`) y la
 * aplicación compara contra esta tabla: subir una versión aquí hace que todo el
 * que entre vea el aviso bloqueante hasta aceptar la nueva.
 *
 * CUÁNDO SUBIR LA VERSIÓN. Cambios de fondo: nuevas finalidades, nuevos
 * encargados o transferencias, nuevos datos sensibles, cambio de responsable.
 * Una errata no. Si no hay certeza, que lo decida el abogado — re-pedir la
 * autorización a todo el mundo tiene un costo y no re-pedirla cuando tocaba,
 * otro mayor.
 *
 * Sin directiva y sin imports de servidor: el formulario de registro (cliente)
 * y el servidor leen las mismas constantes.
 */

export const LEGAL_DOCUMENTS = ['tratamiento', 'terminos', 'privacidad'] as const;
export type LegalDocument = (typeof LEGAL_DOCUMENTS)[number];

/** La versión vigente de cada texto. Fecha ISO del cambio de fondo. */
export const LEGAL_DOCUMENT_VERSIONS: Readonly<Record<LegalDocument, string>> = {
  tratamiento: '2026-10-03',
  terminos: '2026-10-03',
  privacidad: '2026-10-03',
};

/**
 * Lo que una persona tiene que haber aceptado para usar la aplicación: la
 * autorización de tratamiento (la que exige la ley) y los términos (el
 * contrato). La política de privacidad se informa, no se «acepta» aparte: el
 * aviso de privacidad y la política de tratamiento van enlazados en el mismo
 * texto de la casilla.
 */
export const REQUIRED_CONSENTS: readonly LegalDocument[] = ['tratamiento', 'terminos'];

export const LEGAL_DOCUMENT_PATH: Readonly<Record<LegalDocument, string>> = {
  tratamiento: '/tratamiento-de-datos',
  terminos: '/terminos',
  privacidad: '/privacidad',
};

export const LEGAL_DOCUMENT_TITLE: Readonly<Record<LegalDocument, string>> = {
  tratamiento: 'Política de tratamiento de datos personales',
  terminos: 'Términos y condiciones',
  privacidad: 'Política de privacidad',
};

export interface ConsentRecord {
  document: string;
  version: string;
  revoked_at?: string | null;
}

/**
 * Qué documentos obligatorios le faltan a alguien por aceptar en su versión
 * vigente. Una aceptación revocada no cuenta; una de otra versión tampoco.
 */
export function missingConsents(
  accepted: readonly ConsentRecord[],
  versions: Readonly<Record<LegalDocument, string>> = LEGAL_DOCUMENT_VERSIONS,
  required: readonly LegalDocument[] = REQUIRED_CONSENTS,
): LegalDocument[] {
  return required.filter(
    (doc) =>
      !accepted.some((c) => c.document === doc && c.version === versions[doc] && !c.revoked_at),
  );
}

/**
 * Si quien entra ya había aceptado ALGUNA versión antes. Cambia el texto del
 * aviso: «actualizamos los documentos» frente a «antes de seguir».
 */
export function hadPreviousConsent(accepted: readonly ConsentRecord[]): boolean {
  return accepted.some((c) => REQUIRED_CONSENTS.includes(c.document as LegalDocument));
}

// ---------------------------------------------------------------------------
// La casilla del registro viaja en una cookie
// ---------------------------------------------------------------------------
/**
 * La casilla del registro no puede escribir en la base: todavía no hay cuenta,
 * y con Google el navegador se va a otro dominio y vuelve. Viaja igual que el
 * nombre de la empresa (lib/workspace-cookie.ts): una cookie corta con las
 * versiones aceptadas, que sólo existe si la persona marcó la casilla. La
 * primera página con sesión la convierte en una fila de `legal_consents`
 * (origen «registro») y la borra. Sin cookie, el aviso bloqueante la pide.
 */
export const SIGNUP_CONSENT_COOKIE = 'cortex_legal_consent';
export const SIGNUP_CONSENT_MAX_AGE_SECONDS = 3600;

/** `tratamiento:2026-10-03,terminos:2026-10-03` */
export function encodeSignupConsent(
  versions: Readonly<Record<LegalDocument, string>> = LEGAL_DOCUMENT_VERSIONS,
  docs: readonly LegalDocument[] = REQUIRED_CONSENTS,
): string {
  return docs.map((d) => `${d}:${versions[d]}`).join(',');
}

/** Lo contrario, tolerante: lo que no se entiende se descarta. */
export function decodeSignupConsent(raw: string | null | undefined): ConsentRecord[] {
  if (!raw) return [];
  let text = raw;
  try {
    text = decodeURIComponent(raw);
  } catch {
    return [];
  }
  const out: ConsentRecord[] = [];
  for (const part of text.split(',')) {
    const [doc, version] = part.split(':');
    if (!doc || !version) continue;
    if (!(LEGAL_DOCUMENTS as readonly string[]).includes(doc)) continue;
    if (!/^[0-9A-Za-z._-]{1,40}$/.test(version)) continue;
    out.push({ document: doc, version });
  }
  return out;
}
