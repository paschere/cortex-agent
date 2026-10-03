/**
 * LOS DATOS DEL RESPONSABLE, Y LO QUE TODAVÍA NO SABEMOS.
 *
 * Los textos legales nombran a una persona jurídica concreta: razón social, NIT,
 * domicilio, un correo donde se atienden consultas y reclamos (Decreto 1377
 * art. 13 exige que la política los diga). Nada de eso puede inventarse en el
 * código: si falta, el texto muestra un marcador visible — [RAZÓN SOCIAL] — en
 * vez de un dato plausible que alguien podría creer verdadero.
 *
 * Todo sale de variables LEGAL_* (Vercel). `LEGAL_DRAFT` controla la franja
 * «Versión preliminar»: encendida por defecto, y sólo `LEGAL_DRAFT=false`
 * la apaga — cuando un abogado haya revisado los textos y los datos estén
 * puestos. Es un interruptor del dueño, no del código.
 *
 * Sólo servidor en la práctica (lee process.env); no lleva `server-only`
 * porque no hay nada secreto aquí — todo esto se publica en /privacidad.
 */

export interface LegalEntity {
  razonSocial: string;
  nit: string;
  direccion: string;
  ciudad: string;
  correo: string;
  telefono: string;
  fechaVigencia: string;
  /** Dónde están los servidores. Se publica en «transferencias internacionales». */
  regionAlojamiento: string;
  /** Si se ven la franja y el aviso de borrador. */
  draft: boolean;
  /** Marcadores que siguen sin valor, para avisarlo en la franja. */
  missing: string[];
}

const PLACEHOLDERS = {
  razonSocial: ['LEGAL_RAZON_SOCIAL', '[RAZÓN SOCIAL]'],
  nit: ['LEGAL_NIT', '[NIT]'],
  direccion: ['LEGAL_DIRECCION', '[DIRECCIÓN]'],
  ciudad: ['LEGAL_CIUDAD', '[CIUDAD]'],
  correo: ['LEGAL_CORREO', '[CORREO DE CONTACTO]'],
  telefono: ['LEGAL_TELEFONO', '[TELÉFONO]'],
  fechaVigencia: ['LEGAL_FECHA_VIGENCIA', '[FECHA DE VIGENCIA]'],
  regionAlojamiento: ['LEGAL_REGION_ALOJAMIENTO', '[PAÍS/REGIÓN DE LOS SERVIDORES]'],
} as const satisfies Record<string, readonly [string, string]>;

type Env = Record<string, string | undefined>;

export function legalEntity(env: Env = process.env): LegalEntity {
  const missing: string[] = [];
  const read = (key: keyof typeof PLACEHOLDERS): string => {
    const [name, placeholder] = PLACEHOLDERS[key];
    const value = (env[name] ?? '').trim();
    if (value) return value;
    missing.push(placeholder);
    return placeholder;
  };
  const entity = {
    razonSocial: read('razonSocial'),
    nit: read('nit'),
    direccion: read('direccion'),
    ciudad: read('ciudad'),
    correo: read('correo'),
    telefono: read('telefono'),
    fechaVigencia: read('fechaVigencia'),
    regionAlojamiento: read('regionAlojamiento'),
  };
  return { ...entity, draft: isLegalDraft(env), missing };
}

/** Encendido salvo `LEGAL_DRAFT=false` explícito. */
export function isLegalDraft(env: Env = process.env): boolean {
  return (env.LEGAL_DRAFT ?? '').trim().toLowerCase() !== 'false';
}

/** Un valor es marcador si sigue entre corchetes. Lo usa la página para resaltarlo. */
export function isPlaceholder(value: string): boolean {
  return /^\[[^\]]+\]$/.test(value);
}
