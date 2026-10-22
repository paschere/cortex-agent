import type { SupabaseClient } from '@supabase/supabase-js';
import { type MonthlyResult, monthLabel, readMonthlyPnl } from '../statements/monthly';
import { moneyText } from '../ledger/shape';
import { PAYROLL_GROUP_LABEL, type PayrollGroup, classifyPayrollAccount } from './payroll';
import type { PersonnelAccount } from './providers/reports';

/**
 * EL COSTO DE LA NÓMINA, EN VIVO DESDE EL BALANCE DE PRUEBA.
 *
 * Cuando no hay nómina sincronizada (la opción «Nómina» apagada, o aún sin
 * datos) pero el programa contable se puede leer en vivo (Siigo), el costo de
 * personal sale del balance de prueba de cada mes: las cuentas 5105
 * (administración), 5205 (ventas) y 7205 (producción) por subcuenta. Base
 * causación. Sólo totales de la empresa: nunca hay datos por persona aquí.
 */

export type PayrollArea = 'administracion' | 'ventas' | 'produccion';
export const PAYROLL_AREA_LABEL: Record<PayrollArea, string> = {
  administracion: 'Administración (5105)',
  ventas: 'Ventas (5205)',
  produccion: 'Producción (7205)',
};
const AREA_BY_PREFIX: Record<string, PayrollArea> = {
  '5105': 'administracion',
  '5205': 'ventas',
  '7205': 'produccion',
};

export interface LivePayrollConcept {
  concept: string;
  group: PayrollGroup;
  amount: number;
}

export interface LivePayrollMonth {
  /** AAAA-MM. */
  period: string;
  total: number;
  byArea: Record<PayrollArea, number>;
  byGroup: Partial<Record<PayrollGroup, number>>;
  conceptos: LivePayrollConcept[];
  inProgress: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const titleCase = (s: string) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1).toLowerCase() : t;
};

/** Un mes de gasto de personal por cuenta → la fila de costo. Puro. */
export function livePayrollMonth(
  period: string,
  accounts: PersonnelAccount[],
  inProgress = false,
): LivePayrollMonth {
  const byArea: Record<PayrollArea, number> = { administracion: 0, ventas: 0, produccion: 0 };
  const byGroup: Partial<Record<PayrollGroup, number>> = {};
  const concepts = new Map<string, LivePayrollConcept>();
  let total = 0;
  for (const a of accounts) {
    const code = a.code.replace(/\D/g, '');
    const area = AREA_BY_PREFIX[code.slice(0, 4)];
    if (!area || code.length <= 4) continue;
    const cls = classifyPayrollAccount(code);
    const group: PayrollGroup = cls?.group ?? 'otros_personal';
    byArea[area] = round2(byArea[area] + a.amount);
    byGroup[group] = round2((byGroup[group] ?? 0) + a.amount);
    total = round2(total + a.amount);
    // El mismo concepto en las tres áreas se junta (misma subcuenta).
    const key = code.slice(4);
    const label = titleCase(a.name) || cls?.concept || `Cuenta ${code}`;
    const prev = concepts.get(key);
    if (prev) prev.amount = round2(prev.amount + a.amount);
    else concepts.set(key, { concept: label, group, amount: round2(a.amount) });
  }
  return {
    period,
    total,
    byArea,
    byGroup,
    conceptos: [...concepts.values()].sort((x, y) => y.amount - x.amount),
    inProgress,
  };
}

export interface LivePayrollRange {
  year: number;
  fromMonth: number;
  throughMonth: number;
}

/** «Los últimos N meses» o un rango de un año → tramos de un solo año. Puro. */
export function livePayrollRanges(
  input: {
    months: number;
    period?: string | null;
    year?: number | null;
    fromMonth?: number | null;
    throughMonth?: number | null;
  },
  today: string,
): LivePayrollRange[] {
  const thisYear = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7));
  if (input.period) {
    return [{ year: Number(input.period.slice(0, 4)), fromMonth: Number(input.period.slice(5, 7)), throughMonth: Number(input.period.slice(5, 7)) }];
  }
  if (input.year || input.fromMonth || input.throughMonth) {
    const year = Math.min(Math.max(input.year ?? thisYear, thisYear - 5), thisYear);
    const last = year === thisYear ? thisMonth : 12;
    const through = Math.min(Math.max(input.throughMonth ?? last, 1), last);
    const from = Math.min(Math.max(input.fromMonth ?? 1, 1), through);
    return [{ year, fromMonth: from, throughMonth: through }];
  }
  const out: LivePayrollRange[] = [];
  let y = thisYear;
  let m = thisMonth;
  let left = Math.max(1, Math.min(input.months, 36));
  while (left > 0) {
    const take = Math.min(left, m);
    out.unshift({ year: y, fromMonth: m - take + 1, throughMonth: m });
    left -= take;
    y -= 1;
    m = 12;
  }
  return out;
}

export interface LivePayrollResult {
  months: LivePayrollMonth[];
  /** Meses sin datos leídos (falta de tiempo o error). */
  missing: string[];
  errors: string[];
  provider: string | null;
}

export async function readLivePayroll(
  db: SupabaseClient,
  opts: {
    ranges: LivePayrollRange[];
    today: string;
    viewerId: string | null;
    read?: typeof readMonthlyPnl;
  },
): Promise<LivePayrollResult> {
  const out: LivePayrollResult = { months: [], missing: [], errors: [], provider: null };
  for (const r of opts.ranges) {
    const res: MonthlyResult = await (opts.read ?? readMonthlyPnl)(db, {
      year: r.year,
      fromMonth: r.fromMonth,
      throughMonth: r.throughMonth,
      today: opts.today,
      viewerId: opts.viewerId,
      requirePersonnel: true,
      sheets: false,
    });
    out.provider = out.provider ?? res.provider;
    for (const row of res.rows)
      out.months.push(livePayrollMonth(row.month, row.personnel ?? [], row.inProgress));
    out.missing.push(...res.missing);
    out.errors.push(...res.errors);
  }
  return out;
}

/** El texto para el chat. Pesos completos; sin datos por persona. */
export function livePayrollMarkdown(
  r: LivePayrollResult,
  opts: { providerLabel: string; from: string; to: string; canSeePeople: boolean },
): string {
  const money = (n: number) => moneyText(n, 'COP');
  const out: string[] = [];
  const withCost = r.months.filter((m) => m.total !== 0);
  if (r.months.length && !withCost.length) {
    out.push(
      `En la contabilidad de ${opts.providerLabel} no hay gasto de personal registrado entre ${opts.from} y ${opts.to} (cuentas 5105, 5205 y 7205). Si la nómina se contabiliza en otra cuenta o en otro lado, dime dónde y la busco ahí.`,
    );
  } else if (withCost.length) {
    out.push(
      `Costo de nómina según la contabilidad de ${opts.providerLabel} (gasto de personal 5105 + 5205 + 7205, base causación, no caja):`,
    );
    for (const m of r.months) {
      const g = (k: PayrollGroup) => m.byGroup[k] ?? 0;
      out.push(
        `**${monthLabel(m.period)}${m.inProgress ? ' (en curso)' : ''}** — total ${money(m.total)}: administración ${money(m.byArea.administracion)}, ventas ${money(m.byArea.ventas)}, producción ${money(m.byArea.produccion)}. ${PAYROLL_GROUP_LABEL.devengado.toLowerCase()} ${money(g('devengado'))}, prestaciones ${money(g('prestaciones'))}, aportes ${money(g('aportes'))}, otros ${money(g('otros_personal'))}.`,
      );
    }
    if (r.months.length > 1)
      out.push(`**Total del período: ${money(round2(r.months.reduce((s, m) => s + m.total, 0)))}**`);
    const top = [...r.months].reverse().find((m) => m.total !== 0);
    if (top)
      out.push(
        `\nPor concepto en ${monthLabel(top.period)}:\n${top.conceptos
          .slice(0, 15)
          .map((c) => `- ${c.concept}: ${money(c.amount)}`)
          .join('\n')}`,
      );
    out.push(
      opts.canSeePeople
        ? '\nPor persona no sale de este cálculo: son totales de la empresa. Si lo necesitas, lo traigo de los comprobantes contables de nómina (cuentas 5105, 5205, 7205 y 2505 por tercero) con la lectura en vivo; o un administrador puede activar «Nómina» en Integraciones → Programa contable → «Qué traer» para tenerla sincronizada y por persona.'
        : '\nSon totales de la empresa; el detalle por persona es confidencial y sólo lo ve quien administra.',
    );
  }
  if (r.missing.length)
    out.push(
      `Faltan ${r.missing.length} mes(es) por leer (${r.missing.map(monthLabel).join(', ')}). Vuelve a pedirlo y continúa desde ahí.`,
    );
  for (const e of r.errors) out.push(e);
  return out.join('\n');
}

