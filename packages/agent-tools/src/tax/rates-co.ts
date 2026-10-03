/**
 * LAS TARIFAS Y TOPES QUE USAN LOS BORRADORES, COMO DATOS VERSIONADOS.
 *
 * ===========================================================================
 * LÉASE ANTES DE CAMBIAR UN NÚMERO
 * ===========================================================================
 * Un borrador no es una declaración: es la cuenta que Cortex le prepara al
 * contador. Cada tarifa de aquí dice de dónde salió y si está VERIFICADA
 * (`needsConfirmation: false`) o hay que confirmarla con el contador. El
 * borrador muestra «por confirmar» en todo renglón que use una tarifa sin
 * verificar, y nunca la esconde dentro de un total.
 *
 * Verificado (octubre de 2026):
 *   - UVT 2026 = $52.374 (Resolución DIAN 000238 del 15 de diciembre de 2025,
 *     reseñada por el INCP). UVT 2025 = $49.799.
 *   - Tarifa general de renta de personas jurídicas: 35 % (art. 240 ET, Ley
 *     2277 de 2022).
 *   - Tarifas de IVA 19 % y 5 % (arts. 468 y 468-1 ET).
 *
 * Por confirmar, a propósito:
 *   - Retención en la fuente. El Decreto 572 de 2025 bajó las bases (compras
 *     de 27 a 10 UVT, servicios de 4 a 2 UVT) desde el 1 de junio de 2025; el
 *     Consejo de Estado lo suspendió el 7 de mayo de 2026 (la DIAN volvió a las
 *     bases anteriores, Comunicado 070) y levantó la suspensión el 2 de junio,
 *     con efecto desde el 1 de julio de 2026. Fuente secundaria
 *     (siemprealdia.co); se modelan los tres tramos por fecha y TODO sale
 *     «por confirmar». Las tarifas de autorretención especial dependen del
 *     CIIU y también cambiaron el 1 de julio: el contador escribe la suya en
 *     el perfil.
 *   - Régimen Simple (art. 908 ET): la Ley 2277 de 2022 y la Sentencia C-540
 *     de 2023 movieron los grupos y las tarifas. Cortex NO trae una tabla: el
 *     contador escribe la tarifa consolidada de la empresa en el perfil.
 *   - ICA: la tarifa por mil es de cada municipio y cada actividad: se escribe
 *     en el perfil.
 *   - Topes de patrimonio (72.000 UVT, art. 292-3 ET) y de precios de
 *     transferencia (100.000 UVT de patrimonio bruto o 61.000 UVT de
 *     ingresos, art. 260-5 ET): de la norma, pero la aplicación concreta la
 *     decide el contador.
 *
 * CAMBIAR UNA TARIFA = SUBIR `TAX_RATES_VERSION`. Cada borrador guarda la
 * versión con que se armó (`tax_drafts.rules_version`).
 */

export const TAX_RATES_VERSION = 'co-tarifas-2026.1';

export const UVT_BY_YEAR: Record<number, { value: number; source: string; verified: boolean }> = {
  2025: { value: 49_799, source: 'Resolución DIAN 000193 de 2024', verified: true },
  2026: { value: 52_374, source: 'Resolución DIAN 000238 de 2025', verified: true },
};

/** La UVT de un año, o null si Cortex no la tiene (no se inventa). */
export function uvtFor(year: number): number | null {
  return UVT_BY_YEAR[year]?.value ?? null;
}

export const IVA_RATES = { iva_19: 19, iva_5: 5, iva_0: 0, excluido: 0 } as const;

/** Tarifa general de renta de personas jurídicas (art. 240 ET). */
export const RENTA_PJ_RATE = 35;

// ---------------------------------------------------------------------------
// Retención en la fuente
// ---------------------------------------------------------------------------

export const WITHHOLDING_CONCEPTS = [
  'compras',
  'servicios',
  'honorarios',
  'comisiones',
  'arrendamiento_inmuebles',
  'arrendamiento_muebles',
  'transporte',
  'servicios_temporales',
  'otros',
] as const;
export type WithholdingConcept = (typeof WITHHOLDING_CONCEPTS)[number];

export const WITHHOLDING_CONCEPT_LABEL: Record<WithholdingConcept, string> = {
  compras: 'Compras',
  servicios: 'Servicios',
  honorarios: 'Honorarios',
  comisiones: 'Comisiones',
  arrendamiento_inmuebles: 'Arrendamiento de inmuebles',
  arrendamiento_muebles: 'Arrendamiento de muebles',
  transporte: 'Transporte de pasajeros',
  servicios_temporales: 'Servicios temporales (sobre el AIU)',
  otros: 'Otros pagos sujetos',
};

export interface WithholdingRate {
  concept: WithholdingConcept;
  /** Base mínima en UVT (0 = desde el primer peso). */
  baseUvt: number;
  /** Tarifa en % para quien declara renta. */
  rate: number;
  /** Tarifa en % para quien no declara, si es otra. */
  rateNoDeclarante: number | null;
  needsConfirmation: boolean;
}

interface WithholdingTable {
  from: string;
  to: string | null;
  label: string;
  rates: WithholdingRate[];
}

const R = (
  concept: WithholdingConcept,
  baseUvt: number,
  rate: number,
  rateNoDeclarante: number | null = null,
): WithholdingRate => ({ concept, baseUvt, rate, rateNoDeclarante, needsConfirmation: true });

const COMMON_TAIL = [
  R('honorarios', 0, 11, 10),
  R('comisiones', 0, 11, 10),
  R('arrendamiento_muebles', 0, 4),
  R('transporte', 10, 3.5),
  R('servicios_temporales', 2, 1),
];

/** Los tramos por fecha. Todos «por confirmar» (ver el encabezado). */
export const WITHHOLDING_TABLES: WithholdingTable[] = [
  {
    from: '2025-06-01',
    to: '2026-05-07',
    label: 'Decreto 572 de 2025',
    rates: [
      R('compras', 10, 2.5, 3.5),
      R('servicios', 2, 4, 6),
      R('arrendamiento_inmuebles', 10, 3.5),
      ...COMMON_TAIL,
    ],
  },
  {
    from: '2026-05-08',
    to: '2026-06-30',
    label: 'Bases anteriores al Decreto 572 (suspensión del Consejo de Estado)',
    rates: [
      R('compras', 27, 2.5, 3.5),
      R('servicios', 4, 4, 6),
      R('arrendamiento_inmuebles', 27, 3.5),
      ...COMMON_TAIL,
    ],
  },
  {
    from: '2026-07-01',
    to: null,
    label: 'Decreto 572 de 2025 (de nuevo vigente)',
    rates: [
      R('compras', 10, 2.5, 3.5),
      R('servicios', 2, 4, 6),
      R('arrendamiento_inmuebles', 10, 3.5),
      ...COMMON_TAIL,
    ],
  },
];

/** La tabla de retención de un día, o null si el día es anterior a lo que Cortex tiene. */
export function withholdingTableOn(day: string): WithholdingTable | null {
  return WITHHOLDING_TABLES.find((t) => day >= t.from && (t.to === null || day <= t.to)) ?? null;
}

export function withholdingRate(concept: WithholdingConcept, day: string): WithholdingRate | null {
  return withholdingTableOn(day)?.rates.find((r) => r.concept === concept) ?? null;
}

/**
 * El concepto que sugiere una tarifa efectiva (retención / base). Es una
 * PISTA, no un dato: 3,5 % puede ser compras a un no declarante o arriendo de
 * un local; 4 %, servicios o arriendo de muebles. Lo ambiguo devuelve null.
 */
export function conceptFromRate(effectivePct: number): WithholdingConcept | null {
  const near = (x: number) => Math.abs(effectivePct - x) < 0.15;
  if (near(2.5)) return 'compras';
  if (near(6)) return 'servicios';
  if (near(10) || near(11)) return 'honorarios';
  if (near(1)) return 'servicios_temporales';
  return null;
}

// ---------------------------------------------------------------------------
// Topes de las obligaciones nuevas (por confirmar su aplicación)
// ---------------------------------------------------------------------------

/** Impuesto al patrimonio, personas naturales: patrimonio líquido al 1 de enero (art. 292-3 ET). */
export const PATRIMONIO_THRESHOLD_UVT = 72_000;

/** Precios de transferencia (art. 260-5 ET): patrimonio bruto o ingresos brutos al 31 de diciembre. */
export const TRANSFER_PRICING_PATRIMONIO_UVT = 100_000;
export const TRANSFER_PRICING_INGRESOS_UVT = 61_000;

export interface ThresholdTest {
  applies: boolean | null;
  reason: string;
  needsConfirmation: true;
}

/** ¿Llega al tope del impuesto al patrimonio? null = no hay con qué saberlo. */
export function patrimonioTest(input: {
  personType: 'juridica' | 'natural';
  patrimonioLiquido: number | null;
  year: number;
}): ThresholdTest {
  const uvt = uvtFor(input.year);
  if (input.personType === 'juridica')
    return {
      applies: null,
      reason:
        'Para personas jurídicas el impuesto al patrimonio sólo aplica en casos especiales (y hubo cambios por la emergencia económica de diciembre de 2025): lo decide tu contador.',
      needsConfirmation: true,
    };
  if (input.patrimonioLiquido === null || !uvt)
    return {
      applies: null,
      reason: `Aplica a personas naturales con patrimonio líquido de ${PATRIMONIO_THRESHOLD_UVT.toLocaleString('es-CO')} UVT o más al 1 de enero; no tengo el patrimonio para compararlo.`,
      needsConfirmation: true,
    };
  const tope = PATRIMONIO_THRESHOLD_UVT * uvt;
  return {
    applies: input.patrimonioLiquido >= tope,
    reason: `Tope: ${PATRIMONIO_THRESHOLD_UVT.toLocaleString('es-CO')} UVT = $ ${Math.round(tope).toLocaleString('es-CO')} (UVT ${input.year}).`,
    needsConfirmation: true,
  };
}

/** ¿Le aplica el régimen de precios de transferencia? */
export function transferPricingTest(input: {
  vinculadosExterior: boolean;
  patrimonioBruto: number | null;
  ingresosBrutos: number | null;
  year: number;
}): ThresholdTest {
  if (!input.vinculadosExterior)
    return {
      applies: false,
      reason:
        'Sin operaciones con vinculados del exterior (ni con zonas francas o jurisdicciones no cooperantes) no aplica.',
      needsConfirmation: true,
    };
  const uvt = uvtFor(input.year);
  if (!uvt || (input.patrimonioBruto === null && input.ingresosBrutos === null))
    return {
      applies: null,
      reason: `Aplica si al 31 de diciembre el patrimonio bruto es de ${TRANSFER_PRICING_PATRIMONIO_UVT.toLocaleString('es-CO')} UVT o más, o los ingresos brutos de ${TRANSFER_PRICING_INGRESOS_UVT.toLocaleString('es-CO')} UVT o más; no tengo esas cifras.`,
      needsConfirmation: true,
    };
  const byPatrimonio = (input.patrimonioBruto ?? 0) >= TRANSFER_PRICING_PATRIMONIO_UVT * uvt;
  const byIngresos = (input.ingresosBrutos ?? 0) >= TRANSFER_PRICING_INGRESOS_UVT * uvt;
  return {
    applies: byPatrimonio || byIngresos,
    reason: byPatrimonio
      ? 'El patrimonio bruto pasa el tope de 100.000 UVT.'
      : byIngresos
        ? 'Los ingresos brutos pasan el tope de 61.000 UVT.'
        : 'Ni el patrimonio bruto ni los ingresos llegan a los topes.',
    needsConfirmation: true,
  };
}
