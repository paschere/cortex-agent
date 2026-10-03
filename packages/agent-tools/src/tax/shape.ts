import { z } from 'zod';

/**
 * EL VOCABULARIO DEL CALENDARIO TRIBUTARIO (migración 0180).
 *
 * Aquí sólo hay tipos, etiquetas y funciones puras: qué es un perfil
 * tributario, qué clases de obligación existen, cómo se lee un NIT. Nada de
 * base de datos, nada de reloj. El motor (engine.ts) y las tablas de fechas
 * (calendar-co.ts) viven aparte para que se puedan probar sin nada alrededor.
 */

// ---------------------------------------------------------------------------
// El perfil
// ---------------------------------------------------------------------------

export const PERSON_TYPES = ['juridica', 'natural'] as const;
export type PersonType = (typeof PERSON_TYPES)[number];

export const IVA_PERIODICITIES = ['none', 'bimestral', 'cuatrimestral'] as const;
export type IvaPeriodicity = (typeof IVA_PERIODICITIES)[number];

export const ICA_CITIES = ['bogota', 'medellin', 'cali', 'barranquilla', 'otra'] as const;
export type IcaCity = (typeof ICA_CITIES)[number];

export const ICA_PERIODICITIES = ['bimestral', 'anual', 'mensual'] as const;
export type IcaPeriodicity = (typeof ICA_PERIODICITIES)[number];

export const ICA_CITY_LABEL: Record<IcaCity, string> = {
  bogota: 'Bogotá',
  medellin: 'Medellín',
  cali: 'Cali',
  barranquilla: 'Barranquilla',
  otra: 'Otra ciudad',
};

export interface IcaActivityProfile {
  /** Código CIIU o de la actividad en el municipio. */
  code: string;
  label: string;
  /** Tarifa por mil (11,04 = 11,04 ‰). */
  ratePerMil: number;
}

export const icaActivitySchema = z.object({
  code: z.string().trim().min(1).max(12),
  label: z.string().trim().min(1).max(120),
  ratePerMil: z.number().min(0).max(100),
});

export interface TaxProfile {
  /** Sólo dígitos, sin dígito de verificación. */
  nit: string;
  dv: string | null;
  personType: PersonType;
  granContribuyente: boolean;
  regimenSimple: boolean;
  ivaPeriodicity: IvaPeriodicity;
  agenteRetencion: boolean;
  icaCity: IcaCity | null;
  icaPeriodicity: IcaPeriodicity | null;
  exogena: boolean;
  activosExterior: boolean;
  camaraComercio: boolean;
  nominaElectronica: boolean;
  pila: boolean;
  facturacionElectronica: boolean;
  /** Declara impuesto al patrimonio (lo decide el contador; 0197). */
  impuestoPatrimonio: boolean;
  /** Operaciones con vinculados del exterior: precios de transferencia (0197). */
  vinculadosExterior: boolean;
  /** Último cambio de socios o beneficiarios finales (RUB), `YYYY-MM-DD` (0197). */
  rubLastChange: string | null;
  /** Tarifa de autorretención especial de renta, en % (según el CIIU). */
  autorretencionRate: number | null;
  /** Tarifa SIMPLE consolidada, en % (art. 908 ET, según el grupo). */
  simpleRate: number | null;
  /** Actividades de ICA con su tarifa por mil. */
  icaActivities: IcaActivityProfile[];
  /** Quién responde por los impuestos (contador o responsable). */
  ownerUserId: string | null;
  /** Días de aviso antes de cada fecha. */
  noticeDays: number;
  source: 'manual' | 'rut';
  sourceDocumentId: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Lo que se escribe desde el chat o la pantalla. Lo demás tiene valor por defecto. */
export const taxProfileInputSchema = z.object({
  nit: z
    .string()
    .min(5)
    .max(25)
    .describe('El NIT, con o sin puntos y con o sin dígito de verificación («900.123.456-7»).'),
  dv: z.string().regex(/^\d$/).nullish().describe('El dígito de verificación, si viene aparte.'),
  personType: z.enum(PERSON_TYPES).default('juridica'),
  granContribuyente: z.boolean().default(false),
  regimenSimple: z.boolean().default(false).describe('Régimen Simple de Tributación (RST).'),
  ivaPeriodicity: z
    .enum(IVA_PERIODICITIES)
    .default('none')
    .describe('none = no responsable de IVA; bimestral o cuatrimestral según el RUT.'),
  agenteRetencion: z.boolean().default(false).describe('Agente de retención en la fuente.'),
  icaCity: z.enum(ICA_CITIES).nullish().describe('Ciudad donde declara ICA.'),
  icaPeriodicity: z.enum(ICA_PERIODICITIES).nullish(),
  exogena: z.boolean().default(false).describe('Obligado a reportar información exógena.'),
  activosExterior: z.boolean().default(false),
  camaraComercio: z.boolean().default(true).describe('Tiene matrícula mercantil que renovar.'),
  nominaElectronica: z.boolean().default(false),
  pila: z.boolean().default(false).describe('Paga seguridad social de empleados (PILA).'),
  facturacionElectronica: z.boolean().default(false),
  impuestoPatrimonio: z
    .boolean()
    .default(false)
    .describe('Declara impuesto al patrimonio (confírmalo con el contador).'),
  vinculadosExterior: z
    .boolean()
    .default(false)
    .describe(
      'Tiene operaciones con vinculados del exterior o zonas francas (precios de transferencia).',
    ),
  rubLastChange: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish()
    .describe('Fecha del último cambio de socios o beneficiarios finales (para el RUB).'),
  autorretencionRate: z
    .number()
    .min(0)
    .max(10)
    .nullish()
    .describe(
      'Tarifa de autorretención especial de renta en %, según el CIIU (la da el contador).',
    ),
  simpleRate: z
    .number()
    .min(0)
    .max(20)
    .nullish()
    .describe('Tarifa SIMPLE consolidada en % (art. 908 ET), si está en el Régimen Simple.'),
  icaActivities: z
    .array(icaActivitySchema)
    .max(10)
    .default([])
    .describe('Actividades de ICA con su tarifa por mil.'),
  ownerUserId: z
    .string()
    .uuid()
    .nullish()
    .describe('La persona del equipo que responde por los impuestos (el contador).'),
  noticeDays: z.number().int().min(1).max(60).default(7),
  source: z.enum(['manual', 'rut']).default('manual'),
  sourceDocumentId: z.string().uuid().nullish(),
});
export type TaxProfileInput = z.input<typeof taxProfileInputSchema>;
export type TaxProfileParsed = z.output<typeof taxProfileInputSchema>;

// ---------------------------------------------------------------------------
// El NIT
// ---------------------------------------------------------------------------

/** Los pesos del dígito de verificación de la DIAN, del dígito menos significativo al más. */
const DV_WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

/**
 * El dígito de verificación de un NIT (algoritmo de módulo 11 de la DIAN).
 * Sirve para detectar un NIT mal copiado, no para inventar el DV de nadie.
 */
export function nitCheckDigit(nit: string): string {
  const digits = nit.replace(/\D/g, '');
  let sum = 0;
  for (let i = 0; i < digits.length && i < DV_WEIGHTS.length; i++) {
    sum += Number(digits[digits.length - 1 - i]) * (DV_WEIGHTS[i] as number);
  }
  const mod = sum % 11;
  return String(mod > 1 ? 11 - mod : mod);
}

/**
 * «900.123.456-7» → { nit: '900123456', dv: '7' }.
 *
 * Con guion, lo que va después es el DV. Sin guion y con `dv` aparte, se usa
 * ése. Sin guion y sin `dv`, el número entero es el NIT: NUNCA se le corta el
 * último dígito adivinando que era el DV, porque el calendario se decide por
 * ese dígito y adivinar mal mueve todas las fechas del año.
 */
export function splitNit(raw: string, dv?: string | null): { nit: string; dv: string | null } {
  const text = raw.trim();
  const dash = text.match(/^([\d.\s]+)-\s*(\d)\s*$/);
  if (dash) return { nit: (dash[1] ?? '').replace(/\D/g, ''), dv: dash[2] ?? null };
  return { nit: text.replace(/\D/g, ''), dv: dv?.trim() || null };
}

/** Último dígito del NIT (sin DV), como número 0–9. */
export function lastDigit(nit: string): number {
  return Number(nit.slice(-1));
}

/** Últimos dos dígitos del NIT (sin DV), como número 0–99 («00» → 0). */
export function lastTwoDigits(nit: string): number {
  return Number(nit.slice(-2).padStart(2, '0'));
}

// ---------------------------------------------------------------------------
// Las obligaciones
// ---------------------------------------------------------------------------

export const OBLIGATION_KINDS = [
  'renta',
  'iva',
  'retencion',
  'exogena',
  'activos_exterior',
  'simple_anticipo',
  'simple_declaracion',
  'ica',
  'camara_comercio',
  'nomina_electronica',
  'pila',
  'patrimonio',
  'rub',
  'precios_transferencia',
] as const;
export type ObligationKind = (typeof OBLIGATION_KINDS)[number];

export const OBLIGATION_KIND_LABEL: Record<ObligationKind, string> = {
  renta: 'Renta',
  iva: 'IVA',
  retencion: 'Retención en la fuente',
  exogena: 'Información exógena',
  activos_exterior: 'Activos en el exterior',
  simple_anticipo: 'Anticipo del Régimen Simple',
  simple_declaracion: 'Declaración del Régimen Simple',
  ica: 'ICA',
  camara_comercio: 'Renovación de la matrícula mercantil',
  nomina_electronica: 'Nómina electrónica',
  pila: 'Seguridad social (PILA)',
  patrimonio: 'Impuesto al patrimonio',
  rub: 'Registro de beneficiarios finales (RUB)',
  precios_transferencia: 'Precios de transferencia',
};

export const OBLIGATION_STATUSES = ['pendiente', 'presentada', 'pagada', 'no_aplica'] as const;
export type ObligationStatus = (typeof OBLIGATION_STATUSES)[number];

export const OBLIGATION_STATUS_LABEL: Record<ObligationStatus, string> = {
  pendiente: 'Pendiente',
  presentada: 'Presentada',
  pagada: 'Pagada',
  no_aplica: 'No aplica',
};

/** Una fecha que sale del motor: todavía no es una fila, no tiene estado. */
export interface GeneratedObligation {
  /** Llave natural dentro del año: «iva:B3», «renta:c1». Estable entre generaciones. */
  key: string;
  year: number;
  kind: ObligationKind;
  /** «Bimestre 3 (may–jun 2026)». */
  period: string;
  title: string;
  authority: string;
  form: string | null;
  dueDate: string;
  requiresPayment: boolean;
  needsConfirmation: boolean;
  ruleVersion: string;
  sourceNote: string | null;
}

/** Una obligación guardada (tabla `tax_obligations`), en camelCase. */
export interface TaxObligation extends GeneratedObligation {
  id: string;
  status: ObligationStatus;
  statusAt: string | null;
  statusBy: string | null;
  statusNote: string | null;
  evidenceDocumentId: string | null;
  evidenceUrl: string | null;
  commitmentId: string | null;
}

/**
 * Si una obligación ya se cumplió con este estado. Una declaración que se paga
 * no se cumple con presentarla: la DIAN tiene por no presentada una
 * declaración de retención sin pago (art. 580-1 ET), así que el vencimiento de
 * algo que se paga sólo se cierra con «pagada».
 */
export function isFulfilled(status: ObligationStatus, requiresPayment: boolean): boolean {
  if (status === 'pagada' || status === 'no_aplica') return true;
  return status === 'presentada' && !requiresPayment;
}

const MONTHS_SHORT = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
];

/** Nombre corto del mes 1–12. */
export function monthShort(month: number): string {
  return MONTHS_SHORT[(month - 1 + 12) % 12] ?? '';
}

const MONTHS_LONG = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

export function monthLong(month: number): string {
  return MONTHS_LONG[(month - 1 + 12) % 12] ?? '';
}

/** «2026-03-10» → «10 de marzo». */
export function spanishDay(iso: string): string {
  const [, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} de ${monthLong(m)}`;
}
