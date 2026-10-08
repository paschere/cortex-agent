import { amount, clip, currencyCode, day } from './providers/common';

/**
 * LA NÓMINA QUE SE LEE DE LA CONTABILIDAD, PURO (migración 0217).
 *
 * Siigo Nube no tiene endpoint de nómina: su API pública (siigoapi.docs.apiary.io,
 * developers.siigo.com/docs/siigoapi y el SDK SiigoSAS/siigo_sdk_javascript)
 * trae productos, clientes, facturas, compras, notas crédito, recibos,
 * comprobantes contables (`/v1/journals`), documento soporte y reportes
 * (balance de prueba). Ni «nómina», ni «empleados», ni «nómina electrónica».
 * Lo que SÍ existe es el comprobante contable que Siigo Nómina (o el contador)
 * deja en la contabilidad: una línea por cuenta PUC con el tercero y el valor.
 * Este archivo lo lee:
 *
 *   gastos de personal  5105 (administración), 5205 (ventas), 7205 (producción)
 *                       por subcuenta: sueldos, extras, auxilio de transporte,
 *                       cesantías, prima, aportes ARL/EPS/AFP/caja/ICBF/SENA…
 *   2505                salarios por pagar          → neto a pagar
 *   2370, 2365, 2380    retenciones y aportes de nómina, retención en la
 *                       fuente, acreedores varios   → deducciones
 *   2510–2525           cesantías, intereses, prima y vacaciones consolidadas
 *                                                    → provisiones
 *
 * Un comprobante es «de nómina» si trae sueldos (gasto) o salarios por pagar
 * (2505 a crédito); de él se guardan sólo las líneas de esas cuentas, nunca el
 * banco ni lo demás. Nada de este archivo habla con Siigo ni con la base.
 */

export const PAYROLL_GROUPS = [
  'devengado',
  'prestaciones',
  'aportes',
  'otros_personal',
  'neto',
  'deducciones',
  'provisiones',
] as const;
export type PayrollGroup = (typeof PAYROLL_GROUPS)[number];

export const PAYROLL_GROUP_LABEL: Record<PayrollGroup, string> = {
  devengado: 'Devengado',
  prestaciones: 'Prestaciones sociales',
  aportes: 'Aportes de la empresa',
  otros_personal: 'Otros gastos de personal',
  neto: 'Neto a pagar (2505)',
  deducciones: 'Deducciones y retenciones',
  provisiones: 'Provisiones',
};

/** Gastos de personal por clase de cuenta: administración, ventas y producción. */
const EXPENSE_PREFIXES = ['5105', '5205', '7205'];

/** Subcuenta (dígitos 5–6) → concepto, para las tres clases de gasto. */
const EXPENSE_SUB: Record<string, { group: PayrollGroup; concept: string }> = {
  '03': { group: 'devengado', concept: 'Salario integral' },
  '06': { group: 'devengado', concept: 'Sueldos' },
  '12': { group: 'devengado', concept: 'Jornales' },
  '15': { group: 'devengado', concept: 'Horas extras y recargos' },
  '18': { group: 'devengado', concept: 'Comisiones' },
  '21': { group: 'devengado', concept: 'Viáticos' },
  '24': { group: 'devengado', concept: 'Incapacidades' },
  '27': { group: 'devengado', concept: 'Auxilio de transporte' },
  '30': { group: 'prestaciones', concept: 'Cesantías' },
  '33': { group: 'prestaciones', concept: 'Intereses sobre cesantías' },
  '36': { group: 'prestaciones', concept: 'Prima de servicios' },
  '39': { group: 'prestaciones', concept: 'Vacaciones' },
  '42': { group: 'devengado', concept: 'Primas extralegales' },
  '45': { group: 'devengado', concept: 'Auxilios' },
  '48': { group: 'devengado', concept: 'Bonificaciones' },
  '51': { group: 'otros_personal', concept: 'Dotación' },
  '54': { group: 'otros_personal', concept: 'Seguros' },
  '57': { group: 'otros_personal', concept: 'Cuotas partes de pensiones' },
  '60': { group: 'otros_personal', concept: 'Indemnizaciones laborales' },
  '63': { group: 'otros_personal', concept: 'Capacitación al personal' },
  '66': { group: 'otros_personal', concept: 'Gastos deportivos y de recreación' },
  '68': { group: 'aportes', concept: 'Aportes a la ARL' },
  '69': { group: 'aportes', concept: 'Aportes a la EPS' },
  '70': { group: 'aportes', concept: 'Aportes a pensiones y cesantías' },
  '72': { group: 'aportes', concept: 'Aportes a la caja de compensación' },
  '75': { group: 'aportes', concept: 'Aportes al ICBF' },
  '78': { group: 'aportes', concept: 'Aportes al SENA' },
  '95': { group: 'otros_personal', concept: 'Otros gastos de personal' },
};

/** Las subcuentas que hacen de un comprobante uno «de nómina». */
const SALARY_SUB = new Set(['03', '06', '12']);

const LIABILITY: Record<string, { group: PayrollGroup; concept: string }> = {
  '2505': { group: 'neto', concept: 'Salarios por pagar' },
  '2370': { group: 'deducciones', concept: 'Retenciones y aportes de nómina' },
  '2365': { group: 'deducciones', concept: 'Retención en la fuente' },
  '2380': { group: 'deducciones', concept: 'Descuentos a acreedores (libranzas, embargos)' },
  '2510': { group: 'provisiones', concept: 'Cesantías consolidadas' },
  '2515': { group: 'provisiones', concept: 'Intereses sobre cesantías' },
  '2520': { group: 'provisiones', concept: 'Prima de servicios por pagar' },
  '2525': { group: 'provisiones', concept: 'Vacaciones consolidadas' },
};

export type PayrollMovement = 'debit' | 'credit';

export interface PayrollClass {
  group: PayrollGroup;
  concept: string;
  /** Gasto (sube con el débito) o pasivo (sube con el crédito). */
  nature: 'expense' | 'liability';
  /** Marca sueldos: con ellos el comprobante es de nómina. */
  salary: boolean;
}

/** Qué es una cuenta PUC para la nómina, o null si no es de nómina. */
export function classifyPayrollAccount(rawCode: string | null | undefined): PayrollClass | null {
  const code = String(rawCode ?? '').replace(/\D/g, '');
  if (code.length < 4) return null;
  const head = code.slice(0, 4);
  if (EXPENSE_PREFIXES.includes(head)) {
    // 5105 sin subcuenta (cuenta mayor) no dice qué concepto es.
    const sub = code.length >= 6 ? code.slice(4, 6) : '';
    const hit = EXPENSE_SUB[sub] ?? {
      group: 'otros_personal' as PayrollGroup,
      concept: 'Gastos de personal',
    };
    return { ...hit, nature: 'expense', salary: SALARY_SUB.has(sub) };
  }
  const liab = LIABILITY[head];
  if (liab) return { ...liab, nature: 'liability', salary: false };
  return null;
}

// ---------------------------------------------------------------------------
// El comprobante de Siigo → líneas de nómina
// ---------------------------------------------------------------------------

export interface NormalizedPayrollLine {
  lineIndex: number;
  accountCode: string;
  movement: PayrollMovement;
  group: PayrollGroup;
  concept: string;
  /** Siempre positivo; el sentido lo dice `movement`. */
  amount: number;
  personTaxId?: string;
  description?: string;
}

export interface NormalizedPayrollJournal {
  journalId: string;
  name?: string;
  /** AAAA-MM-DD. */
  date: string;
  /** AAAA-MM. */
  period: string;
  currency: string;
  lines: NormalizedPayrollLine[];
}

interface RawJournalItem {
  account?: { code?: string; movement?: string };
  customer?: { identification?: string };
  description?: string;
  value?: number;
}
export interface SiigoJournal {
  id?: string;
  name?: string;
  date?: string;
  currency?: { code?: string } | null;
  items?: RawJournalItem[];
}

/**
 * Un comprobante contable de Siigo como nómina, o null si no lo es (no trae
 * sueldos ni salarios por pagar a crédito) o no se puede leer (sin id/fecha).
 */
export function normalizeSiigoPayrollJournal(j: SiigoJournal): NormalizedPayrollJournal | null {
  const id = clip(j.id, 120);
  const date = day(j.date);
  if (!id || !date) return null;
  const lines: NormalizedPayrollLine[] = [];
  let isPayroll = false;
  (j.items ?? []).forEach((item, lineIndex) => {
    const cls = classifyPayrollAccount(item.account?.code);
    const value = amount(item.value);
    const movement = String(item.account?.movement ?? '').toLowerCase();
    if (!cls || value === undefined || value <= 0) return;
    if (movement !== 'debit' && movement !== 'credit') return;
    if (cls.salary && movement === 'debit') isPayroll = true;
    if (cls.group === 'neto' && movement === 'credit') isPayroll = true;
    const taxId = String(item.customer?.identification ?? '').replace(/\D/g, '');
    lines.push({
      lineIndex,
      accountCode: String(item.account?.code ?? '').replace(/\D/g, ''),
      movement,
      group: cls.group,
      concept: cls.concept,
      amount: value,
      personTaxId: taxId ? taxId.slice(0, 30) : undefined,
      description: clip(item.description, 400),
    });
  });
  if (!isPayroll || !lines.length) return null;
  return {
    journalId: id,
    name: clip(j.name, 120),
    date,
    period: date.slice(0, 7),
    currency: currencyCode(j.currency?.code) ?? 'COP',
    lines,
  };
}

// ---------------------------------------------------------------------------
// Totales
// ---------------------------------------------------------------------------

export interface PayrollLineRow {
  journalId: string;
  period: string;
  accountCode: string;
  movement: PayrollMovement;
  group: PayrollGroup;
  concept: string;
  amount: number;
  personTaxId: string | null;
}

/** Lo que una línea suma a su grupo: el gasto sube con el débito, el pasivo con el crédito. */
export function signedAmount(row: Pick<PayrollLineRow, 'group' | 'movement' | 'amount'>): number {
  const liability =
    row.group === 'neto' || row.group === 'deducciones' || row.group === 'provisiones';
  const up = liability ? 'credit' : 'debit';
  return row.movement === up ? row.amount : -row.amount;
}

export interface PayrollPeriodTotals {
  period: string;
  devengado: number;
  prestaciones: number;
  aportes: number;
  otrosPersonal: number;
  /** Lo que cuesta la nómina a la empresa: devengado + prestaciones + aportes + otros. */
  costoTotal: number;
  neto: number;
  deducciones: number;
  provisiones: number;
  comprobantes: number;
  personas: number;
  /** Por concepto (sueldos, cesantías…), de mayor a menor. */
  conceptos: Array<{ concept: string; group: PayrollGroup; amount: number }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function summarizePayrollPeriods(rows: readonly PayrollLineRow[]): PayrollPeriodTotals[] {
  const byPeriod = new Map<string, PayrollLineRow[]>();
  for (const r of rows) {
    const list = byPeriod.get(r.period) ?? [];
    list.push(r);
    byPeriod.set(r.period, list);
  }
  return [...byPeriod.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .map(([period, list]) => {
      const sum = (g: PayrollGroup) =>
        round2(list.filter((r) => r.group === g).reduce((s, r) => s + signedAmount(r), 0));
      const devengado = sum('devengado');
      const prestaciones = sum('prestaciones');
      const aportes = sum('aportes');
      const otrosPersonal = sum('otros_personal');
      const concepts = new Map<string, { concept: string; group: PayrollGroup; amount: number }>();
      for (const r of list) {
        const c = concepts.get(r.concept) ?? { concept: r.concept, group: r.group, amount: 0 };
        c.amount = round2(c.amount + signedAmount(r));
        concepts.set(r.concept, c);
      }
      return {
        period,
        devengado,
        prestaciones,
        aportes,
        otrosPersonal,
        costoTotal: round2(devengado + prestaciones + aportes + otrosPersonal),
        neto: sum('neto'),
        deducciones: sum('deducciones'),
        provisiones: sum('provisiones'),
        comprobantes: new Set(list.map((r) => r.journalId)).size,
        personas: new Set(list.map((r) => r.personTaxId).filter(Boolean)).size,
        conceptos: [...concepts.values()].sort((a, b) => b.amount - a.amount),
      };
    });
}

export interface PayrollPerson {
  taxId: string;
  devengado: number;
  neto: number;
  deducciones: number;
}

/** Por persona (sólo las líneas que traen tercero). Es DETALLE CONFIDENCIAL. */
export function summarizePayrollPeople(rows: readonly PayrollLineRow[]): PayrollPerson[] {
  const people = new Map<string, PayrollPerson>();
  for (const r of rows) {
    if (!r.personTaxId) continue;
    const p = people.get(r.personTaxId) ?? {
      taxId: r.personTaxId,
      devengado: 0,
      neto: 0,
      deducciones: 0,
    };
    const v = signedAmount(r);
    if (r.group === 'devengado' || r.group === 'prestaciones')
      p.devengado = round2(p.devengado + v);
    else if (r.group === 'neto') p.neto = round2(p.neto + v);
    else if (r.group === 'deducciones') p.deducciones = round2(p.deducciones + v);
    people.set(r.personTaxId, p);
  }
  return [...people.values()].sort((a, b) => b.neto - a.neto || b.devengado - a.devengado);
}
