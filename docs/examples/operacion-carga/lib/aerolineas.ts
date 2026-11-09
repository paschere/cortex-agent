import { LOGOS_AEROLINEA } from './manifiesto-logo';

/**
 * Aerolínea a partir del número de vuelo: «AV», «AV123», «LA 8044», «CM-401», «AVA123»…
 * Primero manda lo que ya se usó en la empresa (vuelos y prealertas anteriores), luego esta tabla.
 */

/** Códigos IATA (2) e ICAO (3) frecuentes en la carga de Bogotá. */
const CONOCIDAS: Record<string, string> = {
  AV: 'Avianca',
  AVA: 'Avianca',
  QT: 'Avianca Cargo',
  TPA: 'Avianca Cargo',
  '2K': 'Avianca Ecuador',
  TA: 'Avianca El Salvador',
  LR: 'Avianca Costa Rica',
  LA: 'LATAM Airlines',
  LAN: 'LATAM Airlines',
  L7: 'LATAM Cargo Colombia',
  LAE: 'LATAM Cargo Colombia',
  UC: 'LATAM Cargo Chile',
  LCO: 'LATAM Cargo Chile',
  M3: 'LATAM Cargo Brasil',
  LTG: 'LATAM Cargo Brasil',
  '4C': 'LATAM Colombia',
  LP: 'LATAM Perú',
  XL: 'LATAM Ecuador',
  JJ: 'LATAM Brasil',
  CM: 'Copa Airlines',
  CMP: 'Copa Airlines',
  P5: 'Wingo',
  '9R': 'Satena',
  AA: 'American Airlines',
  AAL: 'American Airlines',
  UA: 'United Airlines',
  DL: 'Delta Air Lines',
  B6: 'JetBlue',
  NK: 'Spirit Airlines',
  IB: 'Iberia',
  UX: 'Air Europa',
  AF: 'Air France',
  KL: 'KLM',
  LH: 'Lufthansa',
  TK: 'Turkish Airlines',
  EK: 'Emirates',
  QR: 'Qatar Airways',
  AM: 'Aeroméxico',
  AR: 'Aerolíneas Argentinas',
  '5Y': 'Atlas Air',
  GTI: 'Atlas Air',
  K4: 'Kalitta Air',
  CKS: 'Kalitta Air',
  M6: 'Amerijet International',
  AJT: 'Amerijet International',
  CV: 'Cargolux',
  CLX: 'Cargolux',
  FX: 'FedEx Express',
  '5X': 'UPS Airlines',
  KRE: 'Aerosucre',
  W8: 'Cargojet',
  CJT: 'Cargojet',
  GB: 'ABX Air',
  ABX: 'ABX Air',
  AC: 'Air Canada',
  ACA: 'Air Canada',
  UAL: 'United Airlines',
  FDX: 'FedEx Express',
  UPS: 'UPS Airlines',
  KLM: 'KLM',
};

/** El código de la aerolínea al inicio del número: 2 caracteres IATA o 3 letras ICAO. */
export function codigoAerolinea(numero: string): string | null {
  const s = numero.trim().toUpperCase();
  const icao = /^([A-Z]{3})(?=[\s-]*\d|$)/.exec(s);
  if (icao?.[1] && (CONOCIDAS[icao[1]] || s.length >= 3)) return icao[1];
  const iata = /^([A-Z][A-Z0-9]|[0-9][A-Z])(?=[\s-]*\d|$)/.exec(s);
  return iata?.[1] ?? null;
}

/** Lo aprendido de registros anteriores: código → aerolínea más usada. */
export function aprenderAerolineas(registros: Array<{ numero?: string; aerolinea?: string }>) {
  const cuenta = new Map<string, Map<string, number>>();
  for (const r of registros) {
    const nombre = r.aerolinea?.trim();
    const cod = r.numero ? codigoAerolinea(r.numero) : null;
    if (!nombre || !cod) continue;
    const m = cuenta.get(cod) ?? new Map<string, number>();
    m.set(nombre, (m.get(nombre) ?? 0) + 1);
    cuenta.set(cod, m);
  }
  const out: Record<string, string> = {};
  for (const [cod, m] of cuenta) out[cod] = [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return out;
}

/** La aerolínea para ese número de vuelo, o null si el código no se reconoce. */
export function aerolineaDe(numero: string, aprendidas: Record<string, string> = {}): string | null {
  const cod = codigoAerolinea(numero);
  if (!cod) return null;
  return aprendidas[cod] || CONOCIDAS[cod] || null;
}

/* ───────────── Aerolíneas del manifiesto (hoja AEROLINEAS de la plantilla) ───────────── */

export interface AerolineaManifiesto {
  /** Palabra que identifica a la aerolínea en un nombre escrito a mano («LATAM Cargo Chile» → LATAM). */
  clave: string;
  /** Como se escribe en el recuadro: «MANIFIESTO <titulo>». */
  titulo: string;
  /** Nombre con el que se guarda en el vuelo (el mismo de CONOCIDAS cuando existe). */
  nombre: string;
  /** Códigos IATA e ICAO, para prellenar desde el número de vuelo. */
  codigos: string[];
  /** Logo incrustado (data URI PNG, ver manifiesto-logo.ts). */
  logo: string;
}

export const AEROLINEAS_MANIFIESTO: AerolineaManifiesto[] = [
  { clave: 'LATAM', titulo: 'LATAM', nombre: 'LATAM Airlines', codigos: ['LA', 'LAN', 'L7', 'LAE', 'UC', 'LCO', 'M3', 'LTG', '4C', 'LP', 'XL', 'JJ'], logo: '' },
  { clave: 'AMERIJET', titulo: 'AMERIJET', nombre: 'Amerijet International', codigos: ['M6', 'AJT'], logo: '' },
  { clave: 'FEDEX', titulo: 'FEDEX', nombre: 'FedEx Express', codigos: ['FX', 'FDX'], logo: '' },
  { clave: 'UNITED', titulo: 'UNITED', nombre: 'United Airlines', codigos: ['UA', 'UAL'], logo: '' },
  { clave: 'CARGOJET', titulo: 'CARGOJET', nombre: 'Cargojet', codigos: ['W8', 'CJT'], logo: '' },
  { clave: 'KALITTA', titulo: 'KALITTA', nombre: 'Kalitta Air', codigos: ['K4', 'CKS'], logo: '' },
  { clave: 'AIR CANADA', titulo: 'AIR CANADA', nombre: 'Air Canada', codigos: ['AC', 'ACA'], logo: '' },
  { clave: 'UPS', titulo: 'UPS', nombre: 'UPS Airlines', codigos: ['5X', 'UPS'], logo: '' },
  { clave: 'KLM', titulo: 'KLM', nombre: 'KLM', codigos: ['KL', 'KLM'], logo: '' },
  { clave: 'ABX', titulo: 'ABX', nombre: 'ABX Air', codigos: ['GB', 'ABX'], logo: '' },
  { clave: 'ATLAS', titulo: 'ATLAS', nombre: 'Atlas Air', codigos: ['5Y', 'GTI'], logo: '' },
];

// El logo de cada aerolínea es el incrustado (data URI): nada de direcciones externas frágiles.
for (const a of AEROLINEAS_MANIFIESTO) a.logo = LOGOS_AEROLINEA[a.clave]?.dataUrl ?? '';

const sinTildes = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

/** La aerolínea del manifiesto que corresponde a un nombre escrito («Atlas Air», «LATAM Cargo Chile»…). */
export function aerolineaManifiesto(nombre: string): AerolineaManifiesto | null {
  const n = ` ${sinTildes(nombre)} `;
  if (n.trim() === '') return null;
  return AEROLINEAS_MANIFIESTO.find((a) => n.includes(` ${a.clave} `)) ?? null;
}

/** Texto del recuadro amarillo: «MANIFIESTO ATLAS». */
export const tituloManifiesto = (aerolinea: string): string => {
  const a = aerolineaManifiesto(aerolinea);
  const t = a?.titulo ?? aerolinea.trim().toUpperCase();
  return t ? `MANIFIESTO ${t}` : 'MANIFIESTO';
};
