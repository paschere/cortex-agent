import { aerolineaDe } from './aerolineas';
import type { Vuelo } from './datos';
import { N, hay } from './formato';
import { leer, normVuelo } from './manifiesto';
import type { Esquema } from './documental';
import { hayCampo } from './documental';

/**
 * Encabezado del manifiesto: lo que `docs.scan` lee arriba del documento (vuelo, aerolínea,
 * fecha, origen, destino, matrícula, número de manifiesto, totales) y cómo rellena un vuelo
 * sin pisar lo que la persona ya escribió.
 */

export interface Encabezado {
  numero: string;
  aerolinea: string;
  fecha: string;
  origen: string;
  destino: string;
  matricula: string;
  manifiesto: string;
  piezas: string;
  kilos: string;
}

const ALIAS = {
  numero: ['numero_vuelo', 'vuelo', 'flight', 'flight_number', 'flight number', 'numero de vuelo', 'nro vuelo'],
  aerolinea: ['aerolinea', 'aerolínea', 'airline', 'carrier', 'operador', 'transportador'],
  fecha: ['fecha', 'fecha_vuelo', 'date', 'flight date', 'fecha de llegada', 'arrival date'],
  origen: ['origen', 'origin', 'procedencia', 'from', 'aeropuerto origen', 'aeropuerto de origen'],
  destino: ['destino', 'destination', 'to', 'aeropuerto destino', 'aeropuerto de destino'],
  matricula: ['matricula', 'matrícula', 'registration', 'tail', 'tail number', 'aircraft registration'],
  manifiesto: ['manifiesto', 'numero_manifiesto', 'numero de manifiesto', 'manifest', 'manifest_number', 'manifest number', 'manifiesto_numero'],
  piezas: ['piezas_totales', 'total_piezas', 'piezas', 'total pieces', 'pieces', 'bultos'],
  kilos: ['kilos_totales', 'total_kilos', 'kilos', 'peso_total', 'peso total', 'total weight', 'weight', 'peso'],
};

/** AAAA-MM-DD desde «2026-11-05», «05/11/2026», «5-11-26», «5 nov 2026»… ('' si no se entiende). */
export function fechaIso(s: string): string {
  const t = s.trim();
  if (!t) return '';
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(t);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(t);
  if (dmy) {
    const a = dmy[3] as string;
    const año = a.length === 2 ? `20${a}` : a;
    return `${año}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  }
  const MES: Record<string, string> = { ene: '01', jan: '01', feb: '02', mar: '03', abr: '04', apr: '04', may: '05', jun: '06', jul: '07', ago: '08', aug: '08', sep: '09', set: '09', oct: '10', nov: '11', dic: '12', dec: '12' };
  const txt = /^(\d{1,2})\s*(?:de\s+)?([a-záéíóú]{3})[a-záéíóú]*\.?\s*(?:de\s+)?(\d{2,4})/i.exec(t);
  if (txt) {
    const m = MES[(txt[2] as string).toLowerCase().slice(0, 3)];
    const a = txt[3] as string;
    if (m) return `${a.length === 2 ? `20${a}` : a}-${m}-${String(txt[1]).padStart(2, '0')}`;
  }
  return '';
}

/** Lee el encabezado de lo escaneado; totales faltantes se suman de los renglones. */
export function leerEncabezado(fields: Record<string, string | number>, rows: Record<string, string | number>[]): Encabezado {
  const g = (alias: string[]) => leer(fields, alias);
  const suma = (alias: string[]) => rows.reduce((a, r) => a + N(leer(r, alias)), 0);
  const piezas = g(ALIAS.piezas) || (rows.length ? String(suma(['piezas', 'pieces', 'pcs', 'bultos', 'piezas_esperadas']) || '') : '');
  const kilos = g(ALIAS.kilos) || (rows.length ? String(Math.round(suma(['kilos', 'kg', 'peso', 'weight', 'kilos_esperados']) * 10) / 10 || '') : '');
  return {
    numero: g(ALIAS.numero).toUpperCase().replace(/\s+/g, ''),
    aerolinea: g(ALIAS.aerolinea) || aerolineaDe(g(ALIAS.numero)) || '',
    fecha: fechaIso(g(ALIAS.fecha)),
    origen: g(ALIAS.origen),
    destino: g(ALIAS.destino),
    matricula: g(ALIAS.matricula).toUpperCase(),
    manifiesto: g(ALIAS.manifiesto),
    piezas,
    kilos,
  };
}

export const ENCABEZADO_VACIO: Encabezado = { numero: '', aerolinea: '', fecha: '', origen: '', destino: '', matricula: '', manifiesto: '', piezas: '', kilos: '' };

interface Campo {
  clave: keyof Encabezado;
  etiqueta: string;
  /** Campo de la tabla vuelos. */
  campo: string;
  actual: (v: Vuelo) => string;
  valor: (e: Encabezado) => unknown;
  nuevo: boolean;
}

const num_ = (s: string): number | undefined => (s ? N(s) : undefined);

const CAMPOS: Campo[] = [
  { clave: 'aerolinea', etiqueta: 'Aerolínea', campo: 'aerolinea', actual: (v) => v.aerolinea, valor: (e) => e.aerolinea || undefined, nuevo: false },
  { clave: 'origen', etiqueta: 'Origen', campo: 'origen', actual: (v) => v.origen, valor: (e) => e.origen || undefined, nuevo: false },
  { clave: 'destino', etiqueta: 'Destino', campo: 'destino', actual: (v) => v.destino, valor: (e) => e.destino || undefined, nuevo: true },
  { clave: 'matricula', etiqueta: 'Matrícula', campo: 'matricula', actual: (v) => v.matricula, valor: (e) => e.matricula || undefined, nuevo: true },
  { clave: 'manifiesto', etiqueta: 'Número de manifiesto', campo: 'manifiesto_numero', actual: (v) => v.manifiestoNumero, valor: (e) => e.manifiesto || undefined, nuevo: true },
  { clave: 'piezas', etiqueta: 'Piezas esperadas', campo: 'piezas_esperadas', actual: (v) => (v.piezasEsp ? String(v.piezasEsp) : ''), valor: (e) => num_(e.piezas), nuevo: false },
  { clave: 'kilos', etiqueta: 'Kilos esperados', campo: 'kilos_esperados', actual: (v) => (v.kilosEsp ? String(v.kilosEsp) : ''), valor: (e) => num_(e.kilos), nuevo: false },
];

export interface Conflicto {
  campo: string;
  etiqueta: string;
  actual: string;
  nuevo: string;
  valor: unknown;
}

export interface PlanRelleno {
  /** Lo que estaba vacío: se escribe sin preguntar. */
  vacios: Record<string, unknown>;
  etiquetasVacios: string[];
  /** Lo que ya tenía algo distinto: se pregunta antes de pisar. */
  conflictos: Conflicto[];
}

/** Compara el encabezado leído con el vuelo: lo vacío se rellena, lo distinto se pregunta. */
export function planRelleno(v: Vuelo, e: Encabezado, esq: Esquema): PlanRelleno {
  const vacios: Record<string, unknown> = {};
  const etiquetasVacios: string[] = [];
  const conflictos: Conflicto[] = [];
  for (const c of CAMPOS) {
    const nuevo = c.valor(e);
    if (nuevo === undefined || !hay(nuevo)) continue;
    if (!hayCampo(esq, 'vuelos', c.campo)) continue;
    const actual = c.actual(v).trim();
    if (!actual) {
      vacios[c.campo] = nuevo;
      etiquetasVacios.push(c.etiqueta);
    } else {
      const igual = typeof nuevo === 'number' ? Math.abs(N(actual) - nuevo) < 0.05 : normVuelo(actual) === normVuelo(String(nuevo));
      if (!igual) conflictos.push({ campo: c.campo, etiqueta: c.etiqueta, actual, nuevo: String(nuevo), valor: nuevo });
    }
  }
  return { vacios, etiquetasVacios, conflictos };
}
