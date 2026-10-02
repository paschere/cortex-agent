import { generateObject } from 'ai';
import { z } from 'zod';
import { utilityModel } from '../model';
import { repairStructured } from '../structured';
import { normalizeText } from './shape';
import {
  type CategorySource,
  LEDGER_CATEGORIES,
  type LedgerDirection,
  type LedgerKind,
} from './types';

/**
 * LA CATEGORÍA DE CADA PESO, EN ORDEN DE QUIÉN SABE MÁS.
 *
 *   1. UNA PERSONA. `category_source = 'person'` no lo vuelve a tocar nada
 *      automático: ni una regla nueva, ni el modelo, ni una re-ingesta.
 *   2. LAS REGLAS DE LA EMPRESA (`ledger_category_rules`), que nacen de las
 *      correcciones: «los pagos a Rappi son mercadeo». La más específica (el
 *      patrón más largo) gana.
 *   3. LAS REGLAS DE SERIE: lo que cualquier extracto colombiano dice igual —
 *      PILA, EPM, DIAN, 4x1000 — más lo que la fuente ya dice sola (una factura
 *      de venta es venta; una de compra sin más pista, proveedores).
 *   4. EL MODELO, para lo que nadie reconoce, en tandas pequeñas con tope por
 *      corrida, y nunca dos veces por lo mismo: lo que ya clasificó para una
 *      contraparte se reutiliza (`signatureOf`).
 *
 * Las reglas comparan FRASES COMPLETAS sobre el texto normalizado (sin
 * tildes, minúsculas): «ica» reconoce «PAGO ICA BOGOTA» pero no «MEDICAMENTOS».
 */

export type RuleField = 'counterparty' | 'description' | 'any';
export type RuleDirection = LedgerDirection | 'any';

export interface CategoryRule {
  /** El id de la regla de la empresa; null en las de serie. */
  id: string | null;
  field: RuleField;
  /** Texto ya normalizado (normalizeText). */
  pattern: string;
  direction: RuleDirection;
  category: string;
}

/** Lo que una regla necesita mirar de un movimiento. */
export interface Categorizable {
  direction: LedgerDirection;
  kind: LedgerKind;
  counterpartyName?: string | null;
  description: string;
  sourceKind?: string | null;
  category?: string | null;
  categorySource?: CategorySource | null;
}

export interface CategoryDecision {
  category: string;
  source: CategorySource;
  ruleId: string | null;
}

function phraseIn(text: string, phrase: string): boolean {
  if (!phrase) return false;
  return ` ${text} `.includes(` ${phrase} `);
}

export function ruleMatches(rule: CategoryRule, m: Categorizable): boolean {
  if (rule.direction !== 'any' && rule.direction !== m.direction) return false;
  const who = normalizeText(m.counterpartyName);
  const what = normalizeText(m.description);
  if (rule.field === 'counterparty') return phraseIn(who, rule.pattern);
  if (rule.field === 'description') return phraseIn(what, rule.pattern);
  return phraseIn(who, rule.pattern) || phraseIn(what, rule.pattern);
}

function out(category: string, patterns: string[]): CategoryRule[] {
  return patterns.map((p) => ({
    id: null,
    field: 'any',
    pattern: normalizeText(p),
    direction: 'out',
    category,
  }));
}

function inbound(category: string, patterns: string[]): CategoryRule[] {
  return patterns.map((p) => ({
    id: null,
    field: 'any',
    pattern: normalizeText(p),
    direction: 'in',
    category,
  }));
}

/**
 * Las reglas de serie, en orden: la primera que reconoce gana. Bancos va antes
 * que impuestos para que «IVA COMISION» sea un cobro del banco y no un pago a
 * la DIAN; mercadeo antes que software para que «GOOGLE ADS» sea pauta.
 */
export const BUILTIN_RULES: readonly CategoryRule[] = [
  ...out('bancos_y_financieros', [
    'gmf',
    '4x1000',
    '4 x 1000',
    'cuatro por mil',
    'gravamen movimientos financieros',
    'gravamen mov financieros',
    'comision',
    'comisiones',
    'cuota de manejo',
    'cuota manejo',
    'iva comision',
    'cobro servicio',
    'costo transaccion',
    'intereses',
    'interes sobregiro',
    'sobregiro',
    'pago credito',
    'cuota credito',
    'abono credito',
    'pago tarjeta',
    'tarjeta de credito',
    'leasing',
    'chequera',
  ]),
  ...out('nomina', [
    'nomina',
    'pago nomina',
    'pila',
    'planilla pila',
    'seguridad social',
    'aportes en linea',
    'mi planilla',
    'soi',
    'asopagos',
    'enlace operativo',
    'cesantias',
    'prima de servicios',
    'liquidacion contrato',
    'vacaciones',
    'colpensiones',
    'porvenir',
    'colfondos',
    'proteccion pensiones',
    'caja de compensacion',
    'comfama',
    'colsubsidio',
    'cafam',
    'compensar',
    'comfenalco',
    'parafiscales',
  ]),
  ...out('arriendo', [
    'arriendo',
    'arrendamiento',
    'canon de arrendamiento',
    'canon arriendo',
    'cuota de administracion',
    'inmobiliaria',
  ]),
  ...out('servicios_publicos', [
    'epm',
    'empresas publicas de medellin',
    'codensa',
    'enel',
    'vanti',
    'gas natural',
    'acueducto',
    'eaab',
    'emcali',
    'air e',
    'afinia',
    'celsia',
    'electricaribe',
    'essa',
    'chec',
    'triple a',
    'servicios publicos',
    'energia',
    'aseo',
    'claro',
    'movistar',
    'tigo',
    'etb',
    'wom',
  ]),
  ...out('impuestos', [
    'dian',
    'muisca',
    'retencion',
    'retencion en la fuente',
    'retefuente',
    'reteica',
    'reteiva',
    'ica',
    'industria y comercio',
    'iva',
    'impuesto',
    'impuestos',
    'predial',
    'secretaria de hacienda',
    'hacienda distrital',
    'declaracion de renta',
  ]),
  ...out('mercadeo', [
    'google ads',
    'facebk',
    'facebook',
    'facebook ads',
    'meta ads',
    'meta platforms',
    'instagram',
    'linkedin ads',
    'tiktok',
    'publicidad',
    'pauta',
    'mercadeo',
    'marketing',
  ]),
  ...out('software', [
    'google workspace',
    'google cloud',
    'gsuite',
    'microsoft',
    'office 365',
    'aws',
    'amazon web services',
    'adobe',
    'slack',
    'zoom',
    'notion',
    'github',
    'atlassian',
    'hubspot',
    'siigo',
    'alegra',
    'dropbox',
    'canva',
    'openai',
    'anthropic',
    'shopify',
    'vercel',
    'salesforce',
    'licencia',
    'licencias',
    'suscripcion',
  ]),
  ...out('transporte', [
    'flete',
    'fletes',
    'transporte',
    'transportes',
    'mensajeria',
    'servientrega',
    'coordinadora',
    'interrapidisimo',
    'tcc',
    'deprisa',
    'peaje',
    'peajes',
    'combustible',
    'gasolina',
    'terpel',
    'uber',
    'cabify',
    'didi',
    'taxi',
    'parqueadero',
    'avianca',
    'latam',
  ]),
  ...out('honorarios', [
    'honorarios',
    'asesoria',
    'consultoria',
    'abogado',
    'abogados',
    'contador',
    'revisor fiscal',
    'revisoria fiscal',
    'servicios profesionales',
  ]),
  ...out('mantenimiento', [
    'mantenimiento',
    'reparacion',
    'repuestos',
    'taller',
    'ferreteria',
    'homecenter',
  ]),
  ...inbound('otros_ingresos', [
    'rendimientos',
    'intereses',
    'abono intereses',
    'reintegro',
    'devolucion',
    'reembolso',
  ]),
];

/** Lo que la fuente ya dice sola, cuando ninguna palabra dijo más. */
function byKind(m: Categorizable): string | null {
  if (m.kind === 'receivable') return 'ventas';
  if (m.kind === 'payable') return 'proveedores';
  // Un pago reportado (0098) es plata que un cliente le pagó a la empresa.
  if (m.kind === 'income' && m.direction === 'in' && m.sourceKind === 'payment') return 'ventas';
  if (m.kind === 'income' && m.direction === 'in' && m.sourceKind === 'accounting') return 'ventas';
  return null;
}

/** Las reglas de la empresa, de la más específica a la menos. */
export function sortOrgRules(rules: CategoryRule[]): CategoryRule[] {
  return [...rules].sort(
    (a, b) =>
      b.pattern.length - a.pattern.length ||
      Number(b.field !== 'any') - Number(a.field !== 'any') ||
      String(a.id).localeCompare(String(b.id)),
  );
}

/**
 * La categoría por reglas, sin modelo. `null` = ninguna regla reconoce esto y
 * le toca al modelo. Una categoría puesta por una persona se devuelve tal cual.
 */
export function categorizeByRules(
  m: Categorizable,
  orgRules: CategoryRule[],
): CategoryDecision | null {
  if (m.categorySource === 'person' && m.category) {
    return { category: m.category, source: 'person', ruleId: null };
  }
  for (const rule of sortOrgRules(orgRules)) {
    if (ruleMatches(rule, m)) return { category: rule.category, source: 'rule', ruleId: rule.id };
  }
  // Una transferencia entre cuentas propias no es ingreso ni gasto.
  if (m.kind === 'transfer') return null;
  const kindFirst = m.kind === 'receivable' ? byKind(m) : null;
  if (kindFirst) return { category: kindFirst, source: 'rule', ruleId: null };
  for (const rule of BUILTIN_RULES) {
    if (ruleMatches(rule, m)) return { category: rule.category, source: 'rule', ruleId: null };
  }
  const fallback = byKind(m);
  return fallback ? { category: fallback, source: 'rule', ruleId: null } : null;
}

/**
 * La identidad de «lo mismo» para no preguntarle dos veces al modelo: el
 * sentido y la contraparte (o, sin contraparte, la descripción sin números,
 * que en un extracto cambian en cada línea: «PAGO PSE 0045123 ACME»).
 */
export function signatureOf(m: Categorizable): string {
  const base = normalizeText(m.counterpartyName) || normalizeText(m.description);
  return `${m.direction}:${base
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)}`;
}

// ---------------------------------------------------------------------------
// El modelo
// ---------------------------------------------------------------------------

export interface ClassifyItem {
  id: string;
  direction: LedgerDirection;
  kind: LedgerKind;
  amount: number;
  currency: string;
  counterparty: string | null;
  description: string;
}

/** Devuelve id → categoría (de LEDGER_CATEGORIES). Lo que no sepa, lo omite. */
export type LedgerClassifier = (items: ClassifyItem[]) => Promise<Record<string, string>>;

/** Por corrida, como mucho esto va al modelo. El resto espera a la siguiente. */
export const MODEL_ITEMS_PER_RUN = 60;
/** Por llamada. Corto: una tanda mala no arrastra cien filas. */
export const MODEL_BATCH = 20;

const classificationSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      category: z.enum(LEDGER_CATEGORIES),
    }),
  ),
});

const SYSTEM = `Clasificas movimientos de plata de una empresa colombiana en UNA categoría de esta lista:
ventas (lo que pagan los clientes), otros_ingresos (intereses, reintegros, devoluciones a favor), nomina (sueldos, seguridad social, PILA, prestaciones), arriendo, servicios_publicos (energía, agua, gas, internet, telefonía), transporte (fletes, mensajería, combustible, peajes, viajes), proveedores (compras de mercancía o insumos), impuestos (DIAN, retenciones, ICA, IVA, predial), bancos_y_financieros (comisiones, 4x1000, intereses de créditos, cuotas de manejo), software (licencias y suscripciones), mercadeo (pauta, publicidad), mantenimiento, honorarios (abogados, contadores, asesores), otros_gastos.
Responde sólo con la categoría de cada id. Si es plata que entra y no hay otra pista, es ventas. Si es plata que sale y no reconoces nada, otros_gastos.`;

export const modelClassifier: LedgerClassifier = async (items) => {
  if (!items.length) return {};
  const lines = items.map((i) =>
    JSON.stringify({
      id: i.id,
      sentido: i.direction === 'in' ? 'entra' : 'sale',
      tipo: i.kind,
      valor: `${Math.round(i.amount)} ${i.currency}`,
      contraparte: i.counterparty ?? '',
      descripcion: i.description.slice(0, 160),
    }),
  );
  const { object } = await generateObject({
    model: utilityModel(),
    schema: classificationSchema,
    system: SYSTEM,
    prompt: `Movimientos:\n${lines.join('\n')}`,
    maxTokens: 1500,
    abortSignal: AbortSignal.timeout(60_000),
    experimental_repairText: repairStructured(['results']),
  });
  const ids = new Set(items.map((i) => i.id));
  const out: Record<string, string> = {};
  for (const r of object.results) if (ids.has(r.id)) out[r.id] = r.category;
  return out;
};
