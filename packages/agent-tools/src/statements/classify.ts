import {
  PAYROLL_CONFIDENTIAL_KEY,
  PAYROLL_CONFIDENTIAL_LABEL,
  isPayrollCategory,
} from '../ledger/privacy';
import { categoryLabel } from '../ledger/shape';

/**
 * CÓMO CUENTA CADA CATEGORÍA DE GASTO EN EL ESTADO DE RESULTADOS (0191).
 *
 * El libro de plata sabe en QUÉ se fue la plata (nómina, arriendo,
 * proveedores…), no qué TIPO de gasto es. Para la utilidad bruta, la
 * operacional, el punto de equilibrio y el EBITDA hace falta decirlo:
 *
 *   costo       costo de lo vendido: lo que se compra para vender o producir
 *               (sube y baja con las ventas). Resta en la utilidad bruta.
 *   variable    gasto que sube con las ventas sin ser costo (fletes,
 *               comisiones). Resta en la operacional y en el margen de
 *               contribución.
 *   fijo        gasto que se paga se venda o no (nómina, arriendo, software).
 *               Es lo que el punto de equilibrio tiene que cubrir.
 *   financiero  intereses, comisiones bancarias, 4x1000: debajo de la
 *               utilidad operacional (no entra al EBITDA).
 *   impuestos   impuestos pagados: también debajo de la operacional.
 *
 * El defecto de abajo es una decisión razonable para una pyme colombiana, no
 * una verdad: cada empresa lo cambia en /estados (`statement_settings`) y la
 * pantalla dice siempre cuál clasificación usó.
 */

export const EXPENSE_CLASSES = ['costo', 'variable', 'fijo', 'financiero', 'impuestos'] as const;
export type ExpenseClass = (typeof EXPENSE_CLASSES)[number];

export const EXPENSE_CLASS_LABEL: Record<ExpenseClass, string> = {
  costo: 'Costo de ventas',
  variable: 'Gasto variable',
  fijo: 'Gasto fijo',
  financiero: 'Gasto financiero',
  impuestos: 'Impuestos',
};

export const DEFAULT_CLASSES: Readonly<Record<string, ExpenseClass>> = {
  proveedores: 'costo',
  transporte: 'variable',
  nomina: 'fijo',
  arriendo: 'fijo',
  servicios_publicos: 'fijo',
  software: 'fijo',
  mercadeo: 'fijo',
  mantenimiento: 'fijo',
  honorarios: 'fijo',
  otros_gastos: 'fijo',
  sin_categoria: 'fijo',
  bancos_y_financieros: 'financiero',
  impuestos: 'impuestos',
};

export type CategoryClasses = Record<string, ExpenseClass>;

export function isExpenseClass(value: unknown): value is ExpenseClass {
  return typeof value === 'string' && (EXPENSE_CLASSES as readonly string[]).includes(value);
}

/** Lo guardado sobre el defecto; lo que no es una clase válida se ignora. */
export function mergeClasses(saved: Record<string, unknown> | null | undefined): CategoryClasses {
  const out: CategoryClasses = { ...DEFAULT_CLASSES };
  for (const [k, v] of Object.entries(saved ?? {})) if (isExpenseClass(v)) out[k] = v;
  return out;
}

/**
 * La clase de una categoría del libro. La nómina doblada para quien no
 * administra («nomina (confidencial)») es nómina. Una categoría nueva, que
 * nadie clasificó, es fija: es lo prudente para el punto de equilibrio.
 */
export function classOf(category: string, classes: CategoryClasses): ExpenseClass {
  if (category === PAYROLL_CONFIDENTIAL_KEY || isPayrollCategory(category))
    return classes.nomina ?? 'fijo';
  return classes[category] ?? 'fijo';
}

/** Cómo se dice una categoría del libro en el estado de resultados. */
export function expenseCategoryLabel(category: string): string {
  if (category === PAYROLL_CONFIDENTIAL_KEY) return PAYROLL_CONFIDENTIAL_LABEL;
  if (category === 'sin_categoria') return 'Sin categoría';
  return categoryLabel(category);
}
