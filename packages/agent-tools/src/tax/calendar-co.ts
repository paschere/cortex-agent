import { colombianHolidays } from '../management/follow-up';

/**
 * LAS FECHAS DEL CALENDARIO TRIBUTARIO COLOMBIANO, COMO DATOS VERSIONADOS.
 *
 * ===========================================================================
 * DE DÓNDE SALE CADA FECHA (léase antes de cambiar una sola)
 * ===========================================================================
 * Nacional (DIAN): Decreto 2229 de 2023, que fijó en el DUR 1625 de 2016
 * (arts. 1.6.1.13.2.x) un calendario PERMANENTE «para 2024 y siguientes»,
 * contado en días hábiles por el último dígito del NIT (1 → 7.º día hábil del
 * mes … 0 → 16.º). El Comunicado DIAN 128-2025 confirma que rige para 2026.
 * Las fechas de 2026 se tomaron del PDF oficial ACTUALIZADO
 * (https://www.dian.gov.co/Calendarios/Calendario_Tributario_2026.pdf) y se
 * comprobaron contra la regla de días hábiles (`engine.test.ts` las recalcula).
 *
 * Dos cambios posteriores al calendario de diciembre de 2025, ya incluidos:
 *   - 17 de abril de 2026, «Día Cívico de la Paz con la Naturaleza» (Decreto
 *     500 de 2024, tercer viernes de abril): la DIAN lo trata como no hábil
 *     (Comunicado 031-2026), así que todo lo de abril desde el 17 se corre.
 *   - 13 de julio de 2026, festivo nuevo (Virgen de Chiquinquirá, Ley 2578 de
 *     2026, 9 de julio corrido al lunes): julio desde el 13 se corre.
 * Muchos calendarios de terceros publicados en diciembre de 2025 NO tienen
 * esos dos cambios; éste sí.
 *
 * Exógena (año gravable 2025): Resolución Única 000227 de 2025 (mod. 000233)
 * y Resolución 000012 de 2026 (plazos extraordinarios de grandes
 * contribuyentes con NIT terminado en 1, 2 y 3). Comunicado DIAN 053-2026.
 * PILA: Decreto 1990 de 2016 (art. 3.2.2.1 DUR 780 de 2016), una sola tabla
 * por los dos últimos dígitos (2.º a 16.º día hábil del mes).
 * Nómina electrónica: Resolución DIAN 000013 de 2021 (10.º día hábil del mes
 * siguiente). Cámara de Comercio: Código de Comercio art. 33 (31 de marzo).
 *
 * ICA: NO es DIAN, cada ciudad publica su resolución cada año, y aquí se
 * verificaron sólo contra fuentes secundarias (siemprealdia.co, INCP). Por eso
 * TODAS las fechas de ICA salen con `needsConfirmation: true`. Cali y
 * Barranquilla no tienen fechas: no se encontraron publicadas y no se
 * inventan (el motor lo dice como un vacío).
 *
 * 2027: el decreto es permanente, así que las fechas nacionales se pueden
 * CALCULAR con la regla y los festivos. Pero 2026 demostró que un festivo
 * nuevo mueve medio calendario, así que todo lo de 2027 sale con
 * `needsConfirmation: true` hasta que alguien lo compare con el PDF de 2027 y
 * suba la versión. Exógena e ICA de 2027 dependen de resoluciones que no
 * existen todavía: no se generan.
 *
 * CAMBIAR UNA FECHA = SUBIR `RULE_VERSION_BY_YEAR`. La sincronización compara
 * la versión de cada fila y vuelve a escribir sólo lo pendiente.
 */

export const RULE_VERSION_BY_YEAR: Record<number, string> = {
  2026: 'co-2026.1',
  2027: 'co-2027.regla',
};

/** La versión vigente del año en curso de producto (la que `tax.calendar` exige). */
export const RULE_VERSION = 'co-2026.1';

export function supportedYears(): number[] {
  return Object.keys(RULE_VERSION_BY_YEAR).map(Number);
}

export const VERIFIED_DIAN_2026 =
  'Calendario Tributario 2026 DIAN (PDF actualizado), Decreto 2229 de 2023, Comunicado DIAN 031-2026 y Ley 2578 de 2026';

// ---------------------------------------------------------------------------
// Festivos y días hábiles para efectos tributarios
// ---------------------------------------------------------------------------

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function nextMondayOf(y: number, m: number, d: number): string {
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay();
  const shift = dow === 1 ? 0 : (8 - dow) % 7;
  return new Date(t.getTime() + shift * 86_400_000).toISOString().slice(0, 10);
}

function thirdFridayOfApril(y: number): string {
  const first = new Date(Date.UTC(y, 3, 1)).getUTCDay();
  const firstFriday = 1 + ((5 - first + 7) % 7);
  return iso(y, 4, firstFriday + 14);
}

/**
 * Los festivos nacionales (management/follow-up.ts) MÁS lo que la DIAN
 * trata como no hábil desde 2026: el 9 de julio corrido al lunes (Ley 2578 de
 * 2026) y el tercer viernes de abril (Día Cívico, Decreto 500 de 2024).
 */
export function taxHolidays(year: number): ReadonlySet<string> {
  const set = new Set(colombianHolidays(year));
  if (year >= 2026) {
    set.add(nextMondayOf(year, 7, 9));
    set.add(thirdFridayOfApril(year));
  }
  return set;
}

export function isTaxBusinessDay(day: string): boolean {
  const t = new Date(`${day}T00:00:00Z`);
  const dow = t.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  return !taxHolidays(t.getUTCFullYear()).has(day);
}

/**
 * Si `day` cae en sábado, domingo o festivo, el siguiente día hábil: un plazo
 * que vence en día no hábil se corre al siguiente hábil (art. 62 Código Civil
 * y art. 1.6.1.13.2.x DUR 1625). Sirve a los plazos «el último día del mes».
 */
export function nextTaxBusinessDay(day: string): string {
  let t = new Date(`${day}T00:00:00Z`).getTime();
  for (let i = 0; i < 10; i++) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (isTaxBusinessDay(d)) return d;
    t += 86_400_000;
  }
  return day;
}

/** El n-ésimo día hábil (1 = el primero) del mes `YYYY-MM`. */
export function nthBusinessDay(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const day = iso(y, m, d);
    if (new Date(`${day}T00:00:00Z`).getUTCMonth() !== m - 1) break;
    if (isTaxBusinessDay(day) && ++count === n) return day;
  }
  throw new Error(`El mes ${month} no tiene ${n} días hábiles`);
}

/** El mes siguiente a `YYYY-MM`. */
export function nextMonth(month: string, by = 1): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// La tabla de cada año
// ---------------------------------------------------------------------------

/**
 * Los días de un mes en que vence algo «por último dígito»: posición 0 = NIT
 * terminado en 1, … posición 9 = terminado en 0. Son el 7.º a 16.º día hábil.
 */
export type DigitRow = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export interface CoCalendarYear {
  year: number;
  ruleVersion: string;
  /** Contra qué se verificaron las fechas. Vacío = calculadas por regla. */
  verifiedAgainst: string;
  /** Todo el año sale «por confirmar con tu contador». */
  allNeedConfirmation: boolean;
  /** Mes `YYYY-MM` → días del mes por último dígito (7.º–16.º hábil). */
  digitMonths: Record<string, DigitRow>;
  /** Renta personas naturales: 50 fechas, una por pareja de dos últimos dígitos (01-02 … 99-00). */
  rentaNaturales: readonly string[];
  /** Régimen Simple: 5 fechas por pareja de último dígito (1-2, 3-4, 5-6, 7-8, 9-0). */
  simpleIvaAnual: readonly string[];
  simpleDeclaracion: readonly string[];
  /** Exógena, año gravable anterior. Nulo = no se genera (no hay resolución). */
  exogena: {
    verifiedAgainst: string;
    /** Grandes contribuyentes por último dígito (posición 0 = 1 … 9 = 0). */
    gc: readonly string[];
    /** Los demás: 20 fechas por rangos de cinco de los dos últimos dígitos (01-05 … 96-00). */
    general: readonly string[];
  } | null;
  /** Nómina electrónica: mes de la nómina (1–12) → fecha límite de transmisión. */
  nomina: readonly string[];
  /** Meses de nómina cuya fecha es derivada y no verificada (1–12). */
  nominaUnverifiedMonths: readonly number[];
  camaraComercio: string;
  ica: {
    verifiedAgainst: string;
    bogotaBimestral: readonly string[] | null;
    /** ICA anual de Bogotá del año gravable `year`, que vence el año siguiente. */
    bogotaAnual: string | null;
    /** Medellín régimen ordinario, anual del año gravable anterior, por último dígito (posición 0 = 1 … 9 = 0). */
    medellinAnual: readonly string[] | null;
    /** Medellín régimen simplificado (bimestral). */
    medellinBimestral: readonly string[] | null;
  } | null;
}

/**
 * 2026, VERIFICADO. Cada fila de `digitMonths` es la del PDF de la DIAN; el
 * test las vuelve a calcular con `nthBusinessDay` y deben coincidir.
 */
const CO_2026: CoCalendarYear = {
  year: 2026,
  ruleVersion: RULE_VERSION_BY_YEAR[2026] as string,
  verifiedAgainst: VERIFIED_DIAN_2026,
  allNeedConfirmation: false,
  digitMonths: {
    '2026-02': [10, 11, 12, 13, 16, 17, 18, 19, 20, 23],
    '2026-03': [10, 11, 12, 13, 16, 17, 18, 19, 20, 24],
    '2026-04': [13, 14, 15, 16, 20, 21, 22, 23, 24, 27],
    '2026-05': [12, 13, 14, 15, 19, 20, 21, 22, 25, 26],
    '2026-06': [10, 11, 12, 16, 17, 18, 19, 22, 23, 24],
    '2026-07': [9, 10, 14, 15, 16, 17, 21, 22, 23, 24],
    '2026-08': [12, 13, 14, 18, 19, 20, 21, 24, 25, 26],
    '2026-09': [9, 10, 11, 14, 15, 16, 17, 18, 21, 22],
    '2026-10': [9, 13, 14, 15, 16, 19, 20, 21, 22, 23],
    '2026-11': [11, 12, 13, 17, 18, 19, 20, 23, 24, 25],
    '2026-12': [10, 11, 14, 15, 16, 17, 18, 21, 22, 23],
    '2027-01': [13, 14, 15, 18, 19, 20, 21, 22, 25, 26],
  },
  // Art. 1.6.1.13.2.15: agosto días hábiles 7–19, septiembre 1–20, octubre 1–17.
  rentaNaturales: [
    '2026-08-12',
    '2026-08-13',
    '2026-08-14',
    '2026-08-18',
    '2026-08-19',
    '2026-08-20',
    '2026-08-21',
    '2026-08-24',
    '2026-08-25',
    '2026-08-26',
    '2026-08-27',
    '2026-08-28',
    '2026-08-31',
    '2026-09-01',
    '2026-09-02',
    '2026-09-03',
    '2026-09-04',
    '2026-09-07',
    '2026-09-08',
    '2026-09-09',
    '2026-09-10',
    '2026-09-11',
    '2026-09-14',
    '2026-09-15',
    '2026-09-16',
    '2026-09-17',
    '2026-09-18',
    '2026-09-21',
    '2026-09-22',
    '2026-09-23',
    '2026-09-24',
    '2026-09-25',
    '2026-09-28',
    '2026-10-01',
    '2026-10-02',
    '2026-10-05',
    '2026-10-06',
    '2026-10-07',
    '2026-10-08',
    '2026-10-09',
    '2026-10-13',
    '2026-10-14',
    '2026-10-15',
    '2026-10-16',
    '2026-10-19',
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-26',
  ],
  // Arts. 1.6.1.13.2.50–52.
  simpleIvaAnual: ['2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20'],
  simpleDeclaracion: ['2026-04-20', '2026-04-21', '2026-04-22', '2026-04-23', '2026-04-24'],
  exogena: {
    verifiedAgainst:
      'Resolución Única DIAN 000227 de 2025, Resolución 000012 de 2026 y Comunicado DIAN 053-2026',
    gc: [
      '2026-05-14',
      '2026-05-15',
      '2026-05-19',
      '2026-05-05',
      '2026-05-06',
      '2026-05-07',
      '2026-05-08',
      '2026-05-11',
      '2026-05-12',
      '2026-05-13',
    ],
    general: [
      '2026-05-14',
      '2026-05-15',
      '2026-05-19',
      '2026-05-20',
      '2026-05-21',
      '2026-05-22',
      '2026-05-25',
      '2026-05-26',
      '2026-05-27',
      '2026-05-28',
      '2026-05-29',
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
      '2026-06-09',
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
    ],
  },
  nomina: [
    '2026-02-13',
    '2026-03-13',
    '2026-04-16',
    '2026-05-15',
    '2026-06-16',
    '2026-07-15',
    '2026-08-18',
    '2026-09-14',
    '2026-10-15',
    '2026-11-17',
    '2026-12-15',
    '2027-01-18',
  ],
  // La de junio (15 de julio) sale del festivo nuevo del 13 de julio; los
  // calendarios de terceros dicen 14. Coincide con la DIAN para la gasolina,
  // pero no se vio publicada para nómina.
  nominaUnverifiedMonths: [6],
  camaraComercio: '2026-03-31',
  ica: {
    verifiedAgainst:
      'Bogotá: Resolución SDH-000195 de 2025; Medellín: Resolución 202550100057 de 2025 (verificadas en fuentes secundarias)',
    bogotaBimestral: [
      '2026-04-10',
      '2026-06-12',
      '2026-08-21',
      '2026-10-09',
      '2026-12-11',
      '2027-02-12',
    ],
    bogotaAnual: '2027-02-26',
    medellinAnual: [
      '2026-04-30',
      '2026-04-29',
      '2026-04-28',
      '2026-04-27',
      '2026-04-24',
      '2026-04-23',
      '2026-04-22',
      '2026-04-21',
      '2026-04-20',
      '2026-04-17',
    ],
    medellinBimestral: [
      '2026-02-25',
      '2026-04-28',
      '2026-06-25',
      '2026-08-27',
      '2026-10-28',
      '2026-12-28',
    ],
  },
};

/** Un mes «por último dígito» calculado con la regla (7.º a 16.º día hábil). */
export function ruleDigitRow(month: string): DigitRow {
  return Array.from({ length: 10 }, (_, i) =>
    Number(nthBusinessDay(month, 7 + i).slice(8)),
  ) as unknown as DigitRow;
}

function businessDaysRange(month: string, from: number, to: number): string[] {
  const out: string[] = [];
  for (let n = from; n <= to; n++) out.push(nthBusinessDay(month, n));
  return out;
}

/** Un año calculado con la regla de Decreto 2229. Todo «por confirmar». */
function byRule(year: number): CoCalendarYear {
  const digitMonths: Record<string, DigitRow> = {};
  for (let i = 0; i < 12; i++) {
    const month = nextMonth(`${year}-01`, i + 1); // febrero del año … enero del siguiente
    digitMonths[month] = ruleDigitRow(month);
  }
  const nomina = Array.from({ length: 12 }, (_, i) =>
    nthBusinessDay(nextMonth(`${year}-01`, i + 1), 10),
  );
  return {
    year,
    ruleVersion: RULE_VERSION_BY_YEAR[year] ?? `co-${year}.regla`,
    verifiedAgainst: '',
    allNeedConfirmation: true,
    digitMonths,
    rentaNaturales: [
      ...businessDaysRange(`${year}-08`, 7, 19),
      ...businessDaysRange(`${year}-09`, 1, 20),
      ...businessDaysRange(`${year}-10`, 1, 17),
    ],
    simpleIvaAnual: businessDaysRange(`${year}-02`, 11, 15),
    simpleDeclaracion: businessDaysRange(`${year}-04`, 11, 15),
    exogena: null,
    nomina,
    nominaUnverifiedMonths: [],
    camaraComercio: nextTaxBusinessDay(`${year}-03-31`),
    ica: null,
  };
}

const cache = new Map<number, CoCalendarYear>();

/** El calendario de un año, o `null` si Cortex no tiene sus fechas. */
export function calendarFor(year: number): CoCalendarYear | null {
  if (!(year in RULE_VERSION_BY_YEAR)) return null;
  const hit = cache.get(year);
  if (hit) return hit;
  const cal = year === 2026 ? CO_2026 : byRule(year);
  cache.set(year, cal);
  return cal;
}

/** Posición en una fila por último dígito: 1 → 0, …, 9 → 8, 0 → 9. */
export function digitIndex(digit: number): number {
  return digit === 0 ? 9 : digit - 1;
}

/** El día por último dígito de un mes de la tabla, como fecha completa. */
export function dueByDigit(cal: CoCalendarYear, month: string, digit: number): string | null {
  const row = cal.digitMonths[month];
  if (!row) return null;
  const day = row[digitIndex(digit)];
  return `${month}-${String(day).padStart(2, '0')}`;
}
