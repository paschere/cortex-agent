/**
 * LOS PARÁMETROS DE LA NÓMINA COLOMBIANA, COMO DATOS CON VERSIÓN (0194).
 *
 * El motor (engine.ts) no tiene ni un número legal adentro: todo sale de
 * aquí, por fecha. Un cambio de la norma es una fila nueva, no un cambio del
 * motor, y cada liquidación guarda qué versión la produjo (`version`).
 *
 * Por qué por TRAMOS de fecha y no por año: en 2026 cambian cosas a mitad de
 * año. El recargo dominical y festivo sube de 80 % a 90 % el 1 de julio (Ley
 * 2466 de 2025, art. 14 que modifica el 179 CST) y la jornada máxima baja de
 * 44 a 42 horas semanales el 15 de julio (Ley 2101 de 2021, art. 3). Una hora
 * extra del 10 de julio y una del 20 no valen lo mismo, y el motor busca el
 * tramo de la fecha de cada novedad.
 *
 * FUENTES (verificadas el 2026-10-03):
 *   - SMMLV 2026 $1.750.905: Decreto 1469 de 2025, suspendido provisionalmente
 *     por el Consejo de Estado (13-feb-2026) y reemplazado por el Decreto
 *     transitorio 0159 de 2026 (19-feb-2026) que mantiene el mismo valor
 *     mientras hay fallo de fondo. Por eso `needsConfirmation` lo nombra.
 *   - Auxilio de transporte 2026 $249.095: Decreto 1470 de 2025.
 *   - UVT 2026 $52.374: Resolución DIAN 000238 de 2025.
 *   - 2025: SMMLV $1.423.500 (Decreto 1572 de 2024), auxilio $200.000
 *     (Decreto 1573 de 2024), UVT $49.799 (Resolución DIAN 000193 de 2024).
 *   - Jornada (Ley 2101 de 2021): 46 h desde 15-jul-2024, 44 h desde
 *     15-jul-2025, 42 h desde 15-jul-2026. Horas al mes = horas semanales / 6
 *     días × 30 (220 con 44 h; 210 con 42 h), el divisor de uso común.
 *   - Recargos (Ley 2466 de 2025): nocturno desde las 7 p. m. (35 %);
 *     dominical/festivo 80 % desde 1-jul-2025, 90 % desde 1-jul-2026, 100 %
 *     desde 1-jul-2027. Hora extra diurna 25 %, nocturna 75 % (arts. 168 CST).
 *   - Fondo de solidaridad pensional: tabla de la Ley 797 de 2003, art. 8. La
 *     Ley 2381 de 2024 (reforma pensional) la cambia, pero la Corte (C-264 de
 *     2026) fijó su vigencia para el 1-abr-2027.
 *   - ARL por clase de riesgo: Decreto 1772 de 1994 (tarifas mínimas de cada
 *     clase, que son las que se cotizan casi siempre).
 *
 * Lo que una persona tiene que validar (contador / abogado laboral) está en
 * `needsConfirmation` de cada tramo y lo dice la pantalla.
 */

export interface PayrollParams {
  /** «co-2026.c»: lo guarda cada liquidación. */
  version: string;
  validFrom: string;
  validTo: string;
  year: number;
  smmlv: number;
  auxilioTransporte: number;
  uvt: number;
  /** Jornada máxima semanal legal en el tramo. */
  weeklyHours: number;
  /** Divisor de la hora ordinaria: salario / monthlyHours. */
  monthlyHours: number;
  /** Recargo sobre la hora ordinaria (0.35 = 35 %). */
  recargoNocturno: number;
  recargoDominicalFestivo: number;
  extraDiurna: number;
  extraNocturna: number;
  /** Hora en que empieza el trabajo nocturno. */
  nightStartsAt: string;
  /** Fuente de cada valor, en una frase. */
  sources: string;
  /** Lo que no se pudo dejar en firme: la pantalla lo muestra tal cual. */
  needsConfirmation: string[];
}

const SOURCES_2026 =
  'SMMLV: Decreto 0159 de 2026 (transitorio, mantiene el valor del Decreto 1469 de 2025); auxilio de transporte: Decreto 1470 de 2025; UVT: Resolución DIAN 000238 de 2025; jornada: Ley 2101 de 2021; recargos: Ley 2466 de 2025.';
const SOURCES_2025 =
  'SMMLV: Decreto 1572 de 2024; auxilio de transporte: Decreto 1573 de 2024; UVT: Resolución DIAN 000193 de 2024; jornada: Ley 2101 de 2021; recargos: Ley 2466 de 2025 (desde julio).';

const CONFIRM_2026 = [
  'El salario mínimo 2026 rige por un decreto transitorio (0159 de 2026) mientras el Consejo de Estado falla de fondo sobre el Decreto 1469 de 2025: si el fallo cambia el valor, hay que reliquidar.',
];

const BASE_2026 = {
  year: 2026,
  smmlv: 1_750_905,
  auxilioTransporte: 249_095,
  uvt: 52_374,
  recargoNocturno: 0.35,
  extraDiurna: 0.25,
  extraNocturna: 0.75,
  nightStartsAt: '19:00',
  sources: SOURCES_2026,
  needsConfirmation: CONFIRM_2026,
};

const BASE_2025 = {
  year: 2025,
  smmlv: 1_423_500,
  auxilioTransporte: 200_000,
  uvt: 49_799,
  recargoNocturno: 0.35,
  extraDiurna: 0.25,
  extraNocturna: 0.75,
  sources: SOURCES_2025,
  needsConfirmation: [] as string[],
};

/** Los tramos, en orden. Agregar uno nuevo al final; nunca editar uno usado. */
export const PAYROLL_PARAMS: readonly PayrollParams[] = [
  {
    ...BASE_2025,
    version: 'co-2025.a',
    validFrom: '2025-01-01',
    validTo: '2025-06-30',
    weeklyHours: 46,
    monthlyHours: 230,
    recargoDominicalFestivo: 0.75,
    nightStartsAt: '21:00',
  },
  {
    ...BASE_2025,
    version: 'co-2025.b',
    validFrom: '2025-07-01',
    validTo: '2025-07-14',
    weeklyHours: 46,
    monthlyHours: 230,
    recargoDominicalFestivo: 0.8,
    nightStartsAt: '21:00',
  },
  {
    ...BASE_2025,
    version: 'co-2025.c',
    validFrom: '2025-07-15',
    validTo: '2025-12-24',
    weeklyHours: 44,
    monthlyHours: 220,
    recargoDominicalFestivo: 0.8,
    nightStartsAt: '21:00',
  },
  {
    ...BASE_2025,
    version: 'co-2025.d',
    validFrom: '2025-12-25',
    validTo: '2025-12-31',
    weeklyHours: 44,
    monthlyHours: 220,
    recargoDominicalFestivo: 0.8,
    nightStartsAt: '19:00',
  },
  {
    ...BASE_2026,
    version: 'co-2026.a',
    validFrom: '2026-01-01',
    validTo: '2026-06-30',
    weeklyHours: 44,
    monthlyHours: 220,
    recargoDominicalFestivo: 0.8,
  },
  {
    ...BASE_2026,
    version: 'co-2026.b',
    validFrom: '2026-07-01',
    validTo: '2026-07-14',
    weeklyHours: 44,
    monthlyHours: 220,
    recargoDominicalFestivo: 0.9,
  },
  {
    ...BASE_2026,
    version: 'co-2026.c',
    validFrom: '2026-07-15',
    validTo: '2026-12-31',
    weeklyHours: 42,
    monthlyHours: 210,
    recargoDominicalFestivo: 0.9,
  },
];

export class MissingPayrollParamsError extends Error {
  constructor(day: string) {
    super(
      `Cortex todavía no tiene los parámetros de nómina vigentes el ${day} (salario mínimo, auxilio de transporte, UVT). Hay que cargarlos antes de liquidar.`,
    );
    this.name = 'MissingPayrollParamsError';
  }
}

/** El tramo vigente un día `YYYY-MM-DD`. Lanza si no hay. */
export function paramsFor(day: string): PayrollParams {
  for (const p of PAYROLL_PARAMS) if (day >= p.validFrom && day <= p.validTo) return p;
  throw new MissingPayrollParamsError(day);
}

/** Los años con parámetros cargados. */
export function supportedPayrollYears(): number[] {
  return [...new Set(PAYROLL_PARAMS.map((p) => p.year))];
}

// ---------------------------------------------------------------------------
// Tarifas que no cambian con el año (o que cambian por ley aparte)
// ---------------------------------------------------------------------------

/** Aportes y prestaciones, como fracción. */
export const RATES = {
  saludEmpleado: 0.04,
  pensionEmpleado: 0.04,
  saludEmpleador: 0.085,
  pensionEmpleador: 0.12,
  caja: 0.04,
  icbf: 0.03,
  sena: 0.02,
  cesantias: 1 / 12,
  interesesCesantiasAnual: 0.12,
  prima: 1 / 12,
  /** 15 días de salario por 360 trabajados. */
  vacaciones: 15 / 360,
  /** Incapacidad por enfermedad general (art. 227 CST): dos tercios. */
  incapacidadGeneral: 2 / 3,
  /** Salario integral: base de aportes = 70 % (Ley 789 de 2002, art. 49). */
  integralFactorAportes: 0.7,
  /** Salario integral mínimo: 10 SMMLV + 30 % de factor prestacional. */
  integralMinimoSmmlv: 13,
  /** Topes del IBC. */
  ibcMaxSmmlv: 25,
  /** Ley 1393 de 2010, art. 30: lo no salarial por encima del 40 % entra al IBC. */
  noSalarialTope: 0.4,
  /** Art. 114-1 ET: exoneración por debajo de 10 SMMLV. */
  exoneracionTopeSmmlv: 10,
  /** Auxilio de transporte hasta 2 SMMLV (Ley 15 de 1959 y decretos anuales). */
  auxilioTopeSmmlv: 2,
} as const;

/** Tarifa ARL por clase de riesgo (Decreto 1772 de 1994, mínima de cada clase). */
export const ARL_RATES: Record<1 | 2 | 3 | 4 | 5, number> = {
  1: 0.00522,
  2: 0.01044,
  3: 0.02436,
  4: 0.0435,
  5: 0.0696,
};

/**
 * Fondo de solidaridad pensional (Ley 797 de 2003, art. 8): por IBC en
 * salarios mínimos. Desde 4 SMMLV, 1 %; de 16 en adelante sube 0,2 por cada
 * salario hasta 2 % sobre 20.
 */
export function fspRate(ibcInSmmlv: number): number {
  if (ibcInSmmlv < 4) return 0;
  if (ibcInSmmlv < 16) return 0.01;
  if (ibcInSmmlv < 17) return 0.012;
  if (ibcInSmmlv < 18) return 0.014;
  if (ibcInSmmlv < 19) return 0.016;
  if (ibcInSmmlv <= 20) return 0.018;
  return 0.02;
}

/**
 * Tabla de retención en la fuente para pagos laborales (art. 383 ET), en UVT
 * mensuales: [desde (excluido), hasta (incluido), tarifa marginal, UVT fijos].
 */
export const RETENCION_TABLE: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 95, 0, 0],
  [95, 150, 0.19, 0],
  [150, 360, 0.28, 10],
  [360, 640, 0.33, 69],
  [640, 945, 0.35, 162],
  [945, 2300, 0.37, 268],
  [2300, Number.POSITIVE_INFINITY, 0.39, 770],
];

/** Topes de la depuración (art. 336 ET), mensualizados. */
export const RETENCION_LIMITS = {
  /** Renta exenta del 25 %: 790 UVT al año. */
  rentaExentaUvtMes: 790 / 12,
  /** Deducciones + rentas exentas: 40 % y 1.340 UVT al año. */
  topeExentasPct: 0.4,
  topeExentasUvtMes: 1340 / 12,
  /** Dependientes (art. 387 ET): 10 % del ingreso bruto, hasta 32 UVT al mes. */
  dependientesPct: 0.1,
  dependientesUvtMes: 32,
  /** Medicina prepagada: hasta 16 UVT al mes. */
  prepagadaUvtMes: 16,
} as const;
