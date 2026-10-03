import type { Liquidation } from './engine';
import { ARL_RATES, RATES } from './params';

/**
 * LO QUE SALE DE UNA NÓMINA APROBADA (0194), puro: tres archivos.
 *
 * 1. PILA — los datos de la planilla por persona (días, IBC y cotización por
 *    subsistema, novedades), en un CSV «para cargar en tu operador». NO es el
 *    archivo plano oficial de la Resolución 2388 de 2016 (posiciones fijas):
 *    cada operador (SOI, Aportes en Línea, Mi Planilla…) tiene su importador o
 *    su plantilla de Excel, y este CSV trae las columnas para llenarla sin
 *    volver a calcular nada. Las cotizaciones van redondeadas a la centena
 *    superior, como las cobra el operador.
 *
 * 2. Nómina electrónica — el resumen por persona con devengados y deducciones
 *    agrupados como los pide la DIAN (Resolución 000013 de 2021), para cargar
 *    en el proveedor tecnológico. Las APIs públicas de Siigo y Alegra no
 *    reciben documentos de nómina (verificado 2026-10), así que Cortex no la
 *    transmite: la exporta y explica cómo cargarla.
 *
 * 3. Instrucciones de pago — quién, cuánto y a qué cuenta (enmascarada). Cortex
 *    nunca mueve plata: la persona paga desde su banco.
 *
 * Todos llevan salarios: los arma sólo quien administra (la ruta lo revisa).
 */

export interface EmployeeForExport {
  id: string;
  name: string;
  documentType: string;
  documentNumber: string;
  contractType: string;
  integral: boolean;
  arlClass: 1 | 2 | 3 | 4 | 5;
  eps: string | null;
  afp: string | null;
  ccf: string | null;
  arl: string | null;
  bankName: string | null;
  bankAccountType: string | null;
  bankAccountLast4: string | null;
  apprenticePhase: 'lectiva' | 'productiva' | null;
  startDate: string;
  endDate: string | null;
  costCenter: string | null;
}

function cell(v: unknown): string {
  if (v == null) return '';
  const s = String(v);
  // Neutraliza fórmulas al abrir en Excel.
  const safe = /^[=+\-@]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",;\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(',')).join('\n');
}

const up100 = (n: number) => (n <= 0 ? 0 : Math.ceil(n / 100) * 100);

function amountOf(l: Liquidation, code: string): number {
  return l.lines.filter((x) => x.code === code).reduce((s, x) => s + x.amount, 0);
}

/** Tipo de cotizante PILA (Resolución 2388 de 2016). */
function cotizanteType(e: EmployeeForExport): string {
  if (e.contractType === 'aprendizaje') return e.apprenticePhase === 'productiva' ? '19' : '12';
  return '01';
}

/** Junta las liquidaciones del mismo mes por persona (quincenas → mes). */
export function mergeMonth(list: Liquidation[]): Liquidation[] {
  const by = new Map<string, Liquidation>();
  for (const l of list) {
    if (l.excluded) continue;
    const prev = by.get(l.employeeId);
    if (!prev) {
      by.set(l.employeeId, { ...l, lines: [...l.lines], warnings: [...l.warnings] });
      continue;
    }
    prev.lines.push(...l.lines);
    prev.days = {
      contract: prev.days.contract + l.days.contract,
      salary: prev.days.salary + l.days.salary,
      worked: prev.days.worked + l.days.worked,
      vacation: prev.days.vacation + l.days.vacation,
      incapacity: prev.days.incapacity + l.days.incapacity,
      paidLeave: prev.days.paidLeave + l.days.paidLeave,
      unpaid: prev.days.unpaid + l.days.unpaid,
    };
    prev.ibc = {
      salud: prev.ibc.salud + l.ibc.salud,
      pension: prev.ibc.pension + l.ibc.pension,
      arl: prev.ibc.arl + l.ibc.arl,
      parafiscales: prev.ibc.parafiscales + l.ibc.parafiscales,
    };
    prev.period = { ...prev.period, end: l.period.end };
  }
  return [...by.values()];
}

export const PILA_HEADER = [
  'tipo_documento',
  'numero_documento',
  'nombre',
  'tipo_cotizante',
  'salario_integral',
  'novedad_ING',
  'novedad_RET',
  'novedad_VAC',
  'novedad_IGE',
  'novedad_IRL',
  'novedad_LMA',
  'novedad_SLN',
  'novedad_VST',
  'dias_pension',
  'dias_salud',
  'dias_arl',
  'dias_ccf',
  'ibc_pension',
  'ibc_salud',
  'ibc_arl',
  'ibc_ccf',
  'afp',
  'tarifa_pension',
  'cotizacion_pension',
  'fondo_solidaridad',
  'eps',
  'tarifa_salud',
  'cotizacion_salud',
  'arl',
  'clase_riesgo',
  'tarifa_arl',
  'cotizacion_arl',
  'ccf',
  'cotizacion_ccf',
  'cotizacion_icbf',
  'cotizacion_sena',
  'exonerado_114_1',
];

/**
 * Las filas de la planilla de un mes. `month` = `YYYY-MM`. Las cotizaciones
 * son las de la liquidación (empleado + empleador) redondeadas a la centena.
 */
export function pilaRows(
  month: string,
  employees: EmployeeForExport[],
  liquidations: Liquidation[],
): {
  header: string[];
  rows: unknown[][];
  totals: Record<'pension' | 'salud' | 'arl' | 'ccf' | 'icbf' | 'sena' | 'fsp', number>;
} {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const rows: unknown[][] = [];
  const totals = { pension: 0, salud: 0, arl: 0, ccf: 0, icbf: 0, sena: 0, fsp: 0 };
  for (const l of mergeMonth(liquidations)) {
    const e = byId.get(l.employeeId);
    if (!e) continue;
    const reportDays = Math.min(30, Math.max(0, l.days.contract - l.days.unpaid));
    const pension = up100(amountOf(l, 'pension_empleado') + amountOf(l, 'pension_empleador'));
    const salud = up100(amountOf(l, 'salud_empleado') + amountOf(l, 'salud_empleador'));
    const fsp = up100(amountOf(l, 'fondo_solidaridad'));
    const arl = up100(amountOf(l, 'arl'));
    const ccf = up100(amountOf(l, 'caja'));
    const icbf = up100(amountOf(l, 'icbf'));
    const sena = up100(amountOf(l, 'sena'));
    const exonerated = l.lines.some((x) => x.code === 'exoneracion_1141');
    const has = (code: string) => l.lines.some((x) => x.code === code);
    totals.pension += pension;
    totals.salud += salud;
    totals.fsp += fsp;
    totals.arl += arl;
    totals.ccf += ccf;
    totals.icbf += icbf;
    totals.sena += sena;
    rows.push([
      e.documentType,
      e.documentNumber,
      e.name,
      cotizanteType(e),
      e.integral ? 'X' : '',
      e.startDate.slice(0, 7) === month ? 'X' : '',
      e.endDate && e.endDate.slice(0, 7) === month ? 'X' : '',
      has('vacaciones') ? 'X' : '',
      has('incapacidad_general') ? 'X' : '',
      has('incapacidad_laboral') ? 'X' : '',
      has('licencia_maternidad') || has('licencia_paternidad') ? 'X' : '',
      l.days.unpaid > 0 ? 'X' : '',
      l.lines.some(
        (x) =>
          x.code.startsWith('hora_extra') ||
          x.code.startsWith('recargo') ||
          x.code === 'comision' ||
          x.code === 'bonificacion_salarial',
      )
        ? 'X'
        : '',
      reportDays,
      reportDays,
      Math.min(30, l.days.worked),
      reportDays,
      l.ibc.pension,
      l.ibc.salud,
      l.ibc.arl,
      l.ibc.parafiscales,
      e.afp ?? '',
      pension ? RATES.pensionEmpleado + RATES.pensionEmpleador : 0,
      pension,
      fsp,
      e.eps ?? '',
      exonerated ? RATES.saludEmpleado : RATES.saludEmpleado + RATES.saludEmpleador,
      salud,
      e.arl ?? '',
      e.arlClass,
      ARL_RATES[e.arlClass],
      arl,
      e.ccf ?? '',
      ccf,
      icbf,
      sena,
      exonerated ? 'S' : 'N',
    ]);
  }
  return { header: PILA_HEADER, rows, totals };
}

export const PILA_GUIDE = [
  'Este archivo trae los datos de la planilla PILA por persona: días, IBC y cotización de cada subsistema, ya calculados por Cortex.',
  'NO es el archivo plano oficial de la Resolución 2388 de 2016: cárgalo con la plantilla o el importador de tu operador (SOI, Aportes en Línea, Mi Planilla, Asopagos, Enlace Operativo…) o cópialo a la planilla en línea.',
  'Las cotizaciones vienen redondeadas a la centena superior; el operador recalcula y manda su valor. Si alguna cifra no coincide, gana la del operador y conviene revisar la novedad.',
  'Verifica los nombres de EPS, AFP, ARL y caja tal como los tiene tu operador, y paga antes de la fecha que te toca por los dos últimos dígitos del NIT (está en Impuestos).',
];

export const NE_HEADER = [
  'tipo_documento',
  'numero_documento',
  'nombre',
  'periodo_inicio',
  'periodo_fin',
  'dias_trabajados',
  'sueldo',
  'auxilio_transporte',
  'horas_extra_y_recargos',
  'vacaciones',
  'incapacidades',
  'licencias',
  'comisiones',
  'bonificaciones_salariales',
  'bonificaciones_no_salariales',
  'total_devengado',
  'salud',
  'pension',
  'fondo_solidaridad',
  'retencion_fuente',
  'otras_deducciones',
  'total_deducciones',
  'neto',
];

/** Nómina electrónica: el resumen por persona del mes (para el proveedor). */
export function electronicPayrollRows(
  employees: EmployeeForExport[],
  liquidations: Liquidation[],
): { header: string[]; rows: unknown[][] } {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const rows: unknown[][] = [];
  for (const l of mergeMonth(liquidations)) {
    const e = byId.get(l.employeeId);
    if (!e) continue;
    const dev = l.lines.filter((x) => x.group === 'devengado');
    const ded = l.lines.filter((x) => x.group === 'deduccion');
    const s = (pred: (code: string) => boolean, list = dev) =>
      list.filter((x) => pred(x.code)).reduce((t, x) => t + x.amount, 0);
    const totalDev = s(() => true);
    const totalDed = s(() => true, ded);
    rows.push([
      e.documentType,
      e.documentNumber,
      e.name,
      l.period.start,
      l.period.end,
      l.days.worked,
      s((c) => c === 'salario' || c === 'apoyo_sostenimiento'),
      s((c) => c === 'auxilio_transporte'),
      s((c) => c.startsWith('hora_extra') || c.startsWith('recargo')),
      s((c) => c === 'vacaciones'),
      s((c) => c.startsWith('incapacidad')),
      s((c) => c.startsWith('licencia')),
      s((c) => c === 'comision'),
      s((c) => c === 'bonificacion_salarial'),
      s((c) => c === 'bonificacion_no_salarial'),
      totalDev,
      s((c) => c === 'salud_empleado', ded),
      s((c) => c === 'pension_empleado', ded),
      s((c) => c === 'fondo_solidaridad', ded),
      s((c) => c === 'retencion_fuente', ded),
      s((c) => c === 'deduccion', ded),
      totalDed,
      totalDev - totalDed,
    ]);
  }
  return { header: NE_HEADER, rows };
}

export const NE_GUIDE = [
  'La nómina electrónica (documento soporte de pago de nómina, Resolución DIAN 000013 de 2021) se transmite a la DIAN por un proveedor tecnológico o por la solución gratuita de la DIAN, a más tardar en los diez primeros días hábiles del mes siguiente.',
  'Las APIs públicas de Siigo y Alegra no reciben documentos de nómina: Cortex no la transmite. Carga este resumen en el módulo de nómina electrónica de tu proveedor (Siigo Nómina, Alegra Nómina u otro) o en la solución gratuita de la DIAN.',
  'Las cifras son las de la nómina aprobada en Cortex. Si tu proveedor liquida por su cuenta, compara totales antes de transmitir.',
];

export const PAYMENT_HEADER = [
  'nombre',
  'tipo_documento',
  'numero_documento',
  'banco',
  'tipo_cuenta',
  'cuenta_terminada_en',
  'valor_a_pagar',
  'centro_de_costo',
];

/** Instrucciones de pago: a quién, cuánto, a qué cuenta (enmascarada). */
export function paymentRows(
  employees: EmployeeForExport[],
  liquidations: Liquidation[],
): { header: string[]; rows: unknown[][]; total: number } {
  const byId = new Map(employees.map((e) => [e.id, e]));
  const rows: unknown[][] = [];
  let total = 0;
  for (const l of liquidations) {
    if (l.excluded) continue;
    const e = byId.get(l.employeeId);
    if (!e || l.totals.neto <= 0) continue;
    total += l.totals.neto;
    rows.push([
      e.name,
      e.documentType,
      e.documentNumber,
      e.bankName ?? '',
      e.bankAccountType ?? '',
      e.bankAccountLast4 ? `****${e.bankAccountLast4}` : '(sin cuenta registrada)',
      l.totals.neto,
      e.costCenter ?? '',
    ]);
  }
  return { header: PAYMENT_HEADER, rows, total };
}

export const PAYMENT_GUIDE = [
  'Cortex nunca mueve plata: estas son las instrucciones para que la persona autorizada pague desde la sucursal virtual del banco (pago de nómina o dispersión).',
  'Las cuentas salen enmascaradas a propósito: Cortex sólo guarda los últimos cuatro dígitos. El número completo está inscrito en tu banco.',
];
