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
