import { UVT_BY_YEAR } from '../payables/checks';
import {
  type Applies,
  COMMERCIAL_COMPANIES,
  type ComplianceProfile,
  SUPERVISOR_LABEL,
  type Sector,
} from './shape';

/**
 * ¿LE APLICA? — RNBD, SAGRILAFT Y PTEE CONTRA LAS CIFRAS DEL PERFIL.
 *
 * ===========================================================================
 * LOS UMBRALES ESTÁN AQUÍ PARA SER CONFIRMADOS, NO CREÍDOS
 * ===========================================================================
 * Cada umbral lleva su fuente y TODOS salen con `needsConfirmation: true` y la
 * frase «confirma con tu oficial de cumplimiento» (o con tu abogado). La
 * Superintendencia de Sociedades cambia la Circular Básica Jurídica por
 * circulares externas y los valores del salario mínimo y de la UVT cambian
 * cada año; un número equivocado aquí diría «no te aplica» a quien sí.
 *
 *   RNBD (SIC): Decreto 1074 de 2015 (Sección 2.2.2.26), modificado por el
 *     Decreto 090 de 2018 — sociedades y ESAL con activos totales superiores a
 *     100.000 UVT, y personas jurídicas de naturaleza pública.
 *   SAGRILAFT: Circular Básica Jurídica de la Supersociedades, Capítulo X —
 *     empresas vigiladas o supervisadas por la Supersociedades con ingresos
 *     totales o activos iguales o superiores a 40.000 SMLMV al 31 de diciembre
 *     del año anterior; para ciertos sectores de mayor riesgo, 30.000 SMLMV.
 *   PTEE: Circular Básica Jurídica, Capítulo XIII — sociedades supervisadas
 *     con ingresos o activos de 30.000 SMLMV o más que además hicieron
 *     negocios internacionales de más de 100 SMLMV, contrataron con el Estado
 *     por más de 500 SMLMV, o son de ciertos sectores.
 *
 * Si la empresa la vigila OTRA superintendencia (Financiera, Salud,
 * Transporte, Solidaria), su sistema de prevención es el de esa entidad
 * (SARLAFT, SIPLAFT…) y aquí sólo se dice eso.
 */

/** Salario mínimo mensual legal vigente por año. Actualizar cada diciembre. */
export const SMLMV_BY_YEAR: Readonly<Record<number, number>> = {
  2024: 1_300_000,
  2025: 1_423_500,
};

export const RNBD_ASSETS_UVT = 100_000;
export const SAGRILAFT_GENERAL_SMLMV = 40_000;
export const SAGRILAFT_SECTOR_SMLMV = 30_000;
export const SAGRILAFT_SECTORS: readonly Sector[] = [
  'inmobiliario',
  'metales_preciosos',
  'servicios_juridicos',
  'servicios_contables',
  'construccion',
  'vehiculos',
];
export const PTEE_SIZE_SMLMV = 30_000;
export const PTEE_INTERNATIONAL_SMLMV = 100;
export const PTEE_STATE_CONTRACTS_SMLMV = 500;
export const PTEE_SECTORS: readonly Sector[] = [
  'farmaceutico',
  'infraestructura',
  'construccion',
  'manufactura',
  'minero_energetico',
  'tic',
];

export const CONFIRM_OFFICER = 'Confirma con tu oficial de cumplimiento o tu abogado.';

function nearest(
  table: Readonly<Record<number, number>>,
  year: number,
): { year: number; value: number } {
  const years = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);
  const pick = years.filter((y) => y <= year).pop() ?? (years[years.length - 1] as number);
  return { year: pick, value: table[pick] as number };
}

/** El SMLMV con el que se miden las cifras de `figuresYear`, y si es el de ese año. */
export function smlmvFor(year: number): { value: number; exact: boolean; year: number } {
  const n = nearest(SMLMV_BY_YEAR, year);
  return { value: n.value, exact: n.year === year, year: n.year };
}

export function uvtFor(year: number): { value: number; exact: boolean; year: number } {
  const n = nearest(UVT_BY_YEAR, year);
  return { value: n.value, exact: n.year === year, year: n.year };
}

export interface Applicability {
  applies: Applies;
  /** El sistema que aplicaría (p. ej. «SARLAFT de la Superintendencia Financiera»). */
  regime: string | null;
  reasons: string[];
  needsConfirmation: true;
}

function fmt(n: number): string {
  return `$${Math.round(n).toLocaleString('es-CO')}`;
}

const isCommercial = (p: Pick<ComplianceProfile, 'entityType'>) =>
  COMMERCIAL_COMPANIES.includes(p.entityType) || p.entityType === 'sucursal_extranjera';

const OTHER_SYSTEMS: Partial<Record<ComplianceProfile['supervisor'], string>> = {
  superfinanciera: 'SARLAFT de la Superintendencia Financiera',
  supersalud: 'SARLAFT del sector salud (Superintendencia de Salud)',
  supertransporte: 'SIPLAFT de la Superintendencia de Transporte',
  supersolidaria: 'SARLAFT de la Superintendencia de la Economía Solidaria',
  superservicios: 'el sistema que exija la Superintendencia de Servicios Públicos',
};

/** RNBD: ¿debe inscribir sus bases de datos ante la SIC? */
export function rnbdApplicability(p: ComplianceProfile): Applicability {
  const reasons: string[] = [];
  if (!p.handlesPersonalData) {
    return {
      applies: 'no',
      regime: null,
      reasons: [
        'El perfil dice que la empresa no trata datos personales (ni de empleados ni de clientes); es raro: revísalo.',
      ],
      needsConfirmation: true,
    };
  }
  if (p.entityType === 'persona_natural') {
    return {
      applies: 'no',
      regime: null,
      reasons: [
        'La inscripción en el RNBD la deben hacer sociedades y entidades sin ánimo de lucro de cierto tamaño; una persona natural no, aunque igual debe cumplir la Ley 1581 de 2012.',
      ],
      needsConfirmation: true,
    };
  }
  if (p.assetsCop === null) {
    return {
      applies: 'revisar',
      regime: null,
      reasons: [
        'Faltan los activos totales del año anterior para comparar con el umbral de 100.000 UVT.',
      ],
      needsConfirmation: true,
    };
  }
  const year = p.figuresYear ?? new Date().getUTCFullYear() - 1;
  const uvt = uvtFor(year);
  const threshold = RNBD_ASSETS_UVT * uvt.value;
  reasons.push(
    `Activos de ${fmt(p.assetsCop)} contra ${RNBD_ASSETS_UVT.toLocaleString('es-CO')} UVT (${fmt(threshold)} con la UVT de ${uvt.year}${uvt.exact ? '' : `, no la de ${year}`}).`,
  );
  return {
    applies: p.assetsCop > threshold ? 'si' : 'no',
    regime: null,
    reasons,
    needsConfirmation: true,
  };
}

/** SAGRILAFT (Supersociedades, Capítulo X) — o el sistema de su superintendencia. */
export function sagrilaftApplicability(p: ComplianceProfile): Applicability {
  const other = OTHER_SYSTEMS[p.supervisor];
  if (other) {
    return {
      applies: 'revisar',
      regime: other,
      reasons: [
        `La vigila la ${SUPERVISOR_LABEL[p.supervisor]}: su sistema de prevención de lavado de activos es ${other}, no el SAGRILAFT de la Supersociedades.`,
      ],
      needsConfirmation: true,
    };
  }
  if (!isCommercial(p)) {
    return {
      applies: 'no',
      regime: null,
      reasons: [
        p.entityType === 'esal'
          ? 'Las entidades sin ánimo de lucro no las supervisa la Supersociedades para SAGRILAFT; pueden tener otras obligaciones de prevención según su actividad.'
          : 'El SAGRILAFT de la Supersociedades es para sociedades comerciales y sucursales de sociedades extranjeras.',
      ],
      needsConfirmation: true,
    };
  }
  if (p.revenueCop === null && p.assetsCop === null) {
    return {
      applies: 'revisar',
      regime: 'SAGRILAFT',
      reasons: ['Faltan los ingresos y los activos totales al 31 de diciembre del año anterior.'],
      needsConfirmation: true,
    };
  }
  const year = p.figuresYear ?? new Date().getUTCFullYear() - 1;
  const smlmv = smlmvFor(year);
  const bigger = Math.max(p.revenueCop ?? 0, p.assetsCop ?? 0);
  const inSmlmv = bigger / smlmv.value;
  const sectors = p.sectors.filter((s) => SAGRILAFT_SECTORS.includes(s));
  const reasons = [
    `La mayor de las dos cifras (ingresos o activos) es ${fmt(bigger)} ≈ ${Math.round(inSmlmv).toLocaleString('es-CO')} SMLMV (SMLMV de ${smlmv.year}${smlmv.exact ? '' : `, no el de ${year}`}).`,
  ];
  if (inSmlmv >= SAGRILAFT_GENERAL_SMLMV) {
    reasons.push(
      `Supera el umbral general de ${SAGRILAFT_GENERAL_SMLMV.toLocaleString('es-CO')} SMLMV.`,
    );
    return { applies: 'si', regime: 'SAGRILAFT', reasons, needsConfirmation: true };
  }
  if (sectors.length && inSmlmv >= SAGRILAFT_SECTOR_SMLMV) {
    reasons.push(
      `Es de un sector de mayor riesgo y supera ${SAGRILAFT_SECTOR_SMLMV.toLocaleString('es-CO')} SMLMV.`,
    );
    return { applies: 'si', regime: 'SAGRILAFT', reasons, needsConfirmation: true };
  }
  if (p.sectors.includes('activos_virtuales')) {
    reasons.push(
      'Presta servicios de activos virtuales: la Supersociedades tiene reglas especiales para ese sector.',
    );
    return { applies: 'revisar', regime: 'SAGRILAFT', reasons, needsConfirmation: true };
  }
  const near = inSmlmv >= SAGRILAFT_SECTOR_SMLMV * 0.8;
  reasons.push(
    near
      ? 'Está cerca de los umbrales: si las cifras crecen este año, le aplicaría el próximo.'
      : 'Está por debajo de los umbrales que conocemos.',
  );
  return {
    applies: near ? 'revisar' : 'no',
    regime: 'SAGRILAFT',
    reasons,
    needsConfirmation: true,
  };
}

/** PTEE (Supersociedades, Capítulo XIII). */
export function pteeApplicability(p: ComplianceProfile): Applicability {
  if (OTHER_SYSTEMS[p.supervisor] || !isCommercial(p)) {
    return {
      applies: 'no',
      regime: null,
      reasons: [
        'El Programa de Transparencia y Ética Empresarial de la Supersociedades es para sociedades bajo su supervisión.',
      ],
      needsConfirmation: true,
    };
  }
  if (p.revenueCop === null && p.assetsCop === null) {
    return {
      applies: 'revisar',
      regime: 'PTEE',
      reasons: ['Faltan los ingresos y los activos totales del año anterior.'],
      needsConfirmation: true,
    };
  }
  const year = p.figuresYear ?? new Date().getUTCFullYear() - 1;
  const smlmv = smlmvFor(year).value;
  const bigger = Math.max(p.revenueCop ?? 0, p.assetsCop ?? 0) / smlmv;
  const reasons: string[] = [];
  if (bigger < PTEE_SIZE_SMLMV) {
    reasons.push(
      `Ingresos y activos por debajo de ${PTEE_SIZE_SMLMV.toLocaleString('es-CO')} SMLMV.`,
    );
    return { applies: 'no', regime: 'PTEE', reasons, needsConfirmation: true };
  }
  const triggers: string[] = [];
  if (p.internationalCop !== null && p.internationalCop / smlmv > PTEE_INTERNATIONAL_SMLMV) {
    triggers.push(`negocios internacionales por más de ${PTEE_INTERNATIONAL_SMLMV} SMLMV`);
  }
  if (p.stateContractsCop !== null && p.stateContractsCop / smlmv > PTEE_STATE_CONTRACTS_SMLMV) {
    triggers.push(`contratos con el Estado por más de ${PTEE_STATE_CONTRACTS_SMLMV} SMLMV`);
  }
  const sectors = p.sectors.filter((s) => PTEE_SECTORS.includes(s));
  if (sectors.length) triggers.push('pertenece a un sector priorizado');
  if (triggers.length) {
    reasons.push(`Tiene el tamaño y ${triggers.join(', ')}.`);
    return { applies: 'si', regime: 'PTEE', reasons, needsConfirmation: true };
  }
  if (p.internationalCop === null || p.stateContractsCop === null) {
    reasons.push(
      'Tiene el tamaño; faltan los negocios internacionales o los contratos con el Estado del año anterior para decidir.',
    );
    return { applies: 'revisar', regime: 'PTEE', reasons, needsConfirmation: true };
  }
  reasons.push(
    'Tiene el tamaño pero no los negocios internacionales, los contratos con el Estado ni el sector que lo exigirían.',
  );
  return { applies: 'no', regime: 'PTEE', reasons, needsConfirmation: true };
}
