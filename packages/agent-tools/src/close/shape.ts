import type { ModuleKey } from '../modules/catalog';

/**
 * EL CIERRE DEL MES: EL VOCABULARIO (migración 0192). Puro.
 *
 * Los meses (AAAA-MM), qué mes se está cerrando, la lista guiada con su
 * revisión automática y la regla del candado. Lo importan la base
 * (store.ts), las herramientas, el piloto y la pantalla (sólo tipos).
 *
 * LA REVISIÓN AUTOMÁTICA NO DECIDE POR NADIE. Mira los datos y dice «al día» o
 * «faltan 3»; una tarea está LISTA si la revisión dice al día, o si una
 * persona la dio por hecha (con evidencia: «el abono de $1,2M es un préstamo
 * del socio») o por no aplica. Una lectura que falló es «no pude revisar»,
 * nunca «al día».
 */

export const CLOSE_STATUSES = ['abierto', 'en_cierre', 'cerrado'] as const;
export type CloseStatus = (typeof CLOSE_STATUSES)[number];

export const CLOSE_STATUS_LABEL: Record<CloseStatus, string> = {
  abierto: 'Abierto',
  en_cierre: 'En cierre',
  cerrado: 'Cerrado',
};

export const TASK_STATUSES = ['pendiente', 'hecha', 'no_aplica'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  pendiente: 'Pendiente',
  hecha: 'Hecha',
  no_aplica: 'No aplica',
};

export type AutoState = 'ok' | 'pendiente' | 'no_aplica' | 'error' | 'manual';

export interface AutoCheck {
  state: AutoState;
  /** Cuántas cosas faltan (cuando se pueden contar). */
  count?: number;
  /** En una frase: qué vio la revisión. */
  detail: string;
}

// ---------------------------------------------------------------------------
// Meses
// ---------------------------------------------------------------------------

const PERIOD_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isPeriod(value: unknown): value is string {
  return typeof value === 'string' && PERIOD_RE.test(value);
}

export function periodOf(day: string): string {
  return day.slice(0, 7);
}

export function periodStart(period: string): string {
  return `${period}-01`;
}

/** El último día del mes. */
export function periodEnd(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${period}-${String(last).padStart(2, '0')}`;
}

export function shiftPeriod(period: string, months: number): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MONTHS = [
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

/** «septiembre» (o «septiembre de 2025» si no es de este año ni del anterior inmediato). */
export function monthName(period: string, opts: { withYear?: boolean } = {}): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  const name = MONTHS[m - 1] ?? period;
  return opts.withYear ? `${name} de ${y}` : name;
}

/** «Septiembre de 2026». */
export function periodLabel(period: string): string {
  const s = monthName(period, { withYear: true });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * El mes que toca cerrar: el anterior mientras siga sin cerrar (el cierre se
 * hace en los primeros días del mes siguiente); cerrado el anterior, el que
 * corre.
 */
export function defaultClosePeriod(
  today: string,
  statusOf: (period: string) => CloseStatus | null,
): string {
  const current = periodOf(today);
  const previous = shiftPeriod(current, -1);
  return statusOf(previous) === 'cerrado' ? current : previous;
}

// ---------------------------------------------------------------------------
// La lista
// ---------------------------------------------------------------------------

export const CLOSE_TASK_KEYS = [
  'extractos',
  'conciliacion',
  'facturas_proveedor',
  'causacion',
  'recibos',
  'pagos_proveedor',
  'sin_categoria',
  'nomina',
  'impuestos',
  'inventario',
  'provisiones',
  'depreciacion',
] as const;
export type CloseTaskKey = (typeof CLOSE_TASK_KEYS)[number];

export interface CloseTaskDef {
  key: CloseTaskKey;
  /** Con el mes: «Extractos del banco importados hasta el 30 de septiembre». */
  title: (period: string) => string;
  /** Qué es y por qué importa, en una línea. */
  help: string;
  /** Sólo existe si este módulo está prendido. */
  module?: ModuleKey;
  /** Lo arregla: una pantalla y una frase para Cortex. */
  fix: { href: string; label: string; prompt: string };
  /** true: la revisa Cortex. false: un recordatorio que marca una persona. */
  auto: boolean;
}

function dayOfMonth(period: string): string {
  const end = periodEnd(period);
  return `${Number(end.slice(8, 10))} de ${monthName(period)}`;
}

export const CLOSE_TASKS: readonly CloseTaskDef[] = [
  {
    key: 'extractos',
    title: (p) => `Extractos del banco importados hasta el ${dayOfMonth(p)}`,
    help: 'Cada cuenta del banco con su extracto hasta fin de mes: sin eso, lo demás se revisa a ciegas.',
    fix: {
      href: '/payments',
      label: 'Importar extracto',
      prompt: 'Te paso el extracto del banco de fin de mes para importarlo',
    },
    auto: true,
  },
  {
    key: 'conciliacion',
    title: () => 'Movimientos del banco conciliados o explicados',
    help: 'Cada abono del mes atado a la factura que paga, o explicado (préstamo, aporte, devolución).',
    fix: {
      href: '/payments',
      label: 'Conciliar',
      prompt: '¿Qué abonos del banco no tienen factura este mes?',
    },
    auto: true,
  },
  {
    key: 'facturas_proveedor',
    title: () => 'Facturas de proveedor del mes revisadas y aprobadas',
    help: 'Lo que llegó de proveedores con fecha del mes, sin nada esperando visto bueno.',
    module: 'payables',
    fix: {
      href: '/pagar',
      label: 'Ver por aprobar',
      prompt: '¿Qué facturas de proveedor tengo por aprobar?',
    },
    auto: true,
  },
  {
    key: 'causacion',
    title: () => 'Facturas de proveedor causadas en el programa contable',
    help: 'Cada factura aprobada del mes registrada como compra en Siigo, Alegra o QuickBooks.',
    fix: {
      href: '/cierre?tab=registrar',
      label: 'Causar',
      prompt: 'Causa en el programa contable las facturas de proveedor aprobadas del mes',
    },
    auto: true,
  },
  {
    key: 'recibos',
    title: () => 'Recibos de caja registrados',
    help: 'Cada pago de cliente que entró al banco, registrado contra su factura en el programa.',
    fix: {
      href: '/cierre?tab=registrar',
      label: 'Registrar recibos',
      prompt: 'Registra en el programa contable los recibos de caja del mes',
    },
    auto: true,
  },
  {
    key: 'pagos_proveedor',
    title: () => 'Pagos a proveedores registrados',
    help: 'Cada factura de proveedor que el banco ya pagó, registrada como pagada en el programa.',
    fix: {
      href: '/cierre?tab=registrar',
      label: 'Registrar pagos',
      prompt: 'Registra en el programa contable los pagos a proveedores del mes',
    },
    auto: true,
  },
  {
    key: 'sin_categoria',
    title: () => 'Ningún movimiento del libro sin categoría',
    help: 'Lo que entró y salió del mes con su categoría: de ahí salen el resultado y el presupuesto.',
    module: 'finance',
    fix: {
      href: '/finance',
      label: 'Categorizar',
      prompt: '¿Qué movimientos de este mes no tienen categoría?',
    },
    auto: true,
  },
  {
    key: 'nomina',
    title: () => 'Nómina del mes registrada',
    help: 'El pago de la nómina del mes anotado en el libro (y en el programa, si se lleva allá).',
    module: 'payroll',
    fix: { href: '/finance', label: 'Ver el libro', prompt: 'Anota el pago de la nómina de ' },
    auto: true,
  },
  {
    key: 'impuestos',
    title: () => 'Obligaciones tributarias del mes presentadas',
    help: 'Lo que vencía este mes con la DIAN y el municipio, presentado o pagado.',
    module: 'taxes',
    fix: {
      href: '/impuestos',
      label: 'Ver el calendario',
      prompt: '¿Qué impuestos vencen este mes y cuáles faltan?',
    },
    auto: true,
  },
  {
    key: 'inventario',
    title: () => 'Conteo de inventario hecho',
    help: 'Un conteo físico al cierre (o en los primeros días del mes siguiente) y sus ajustes.',
    module: 'inventory',
    fix: {
      href: '/inventario',
      label: 'Registrar conteo',
      prompt: 'Registra el conteo de inventario de ',
    },
    auto: true,
  },
  {
    key: 'provisiones',
    title: () => 'Causaciones y provisiones del mes',
    help: 'Lo que se debe aunque no se haya pagado: arriendo, servicios, honorarios, prestaciones sociales (cesantías, prima, vacaciones).',
    fix: {
      href: '/cierre',
      label: 'Marcar',
      prompt: '¿Qué provisiones debería causar este mes?',
    },
    auto: false,
  },
  {
    key: 'depreciacion',
    title: () => 'Depreciación y amortizaciones del mes',
    help: 'La depreciación de los activos fijos y la amortización de lo pagado por anticipado, en el programa contable.',
    fix: {
      href: '/cierre',
      label: 'Marcar',
      prompt: 'Recuérdame cómo se registra la depreciación del mes',
    },
    auto: false,
  },
];

export function taskDef(key: string): CloseTaskDef | undefined {
  return CLOSE_TASKS.find((t) => t.key === key);
}

/** Las tareas que corren para esta empresa: las de módulos apagados no existen. */
export function tasksFor(modulesOn: ReadonlySet<ModuleKey>): CloseTaskDef[] {
  return CLOSE_TASKS.filter((t) => !t.module || modulesOn.has(t.module));
}

// ---------------------------------------------------------------------------
// La revisión automática, de los datos a un estado
// ---------------------------------------------------------------------------

/**
 * Lo que la base dijo del mes. `undefined` = esa lectura falló (la tarea queda
 * «no pude revisar»); `null` en lo que depende del programa contable = no hay
 * programa conectado que sepa escribirlo.
 */
export interface CloseCheckData {
  /** Por cuenta de banco: el último día con movimiento del extracto. */
  bankAccounts?: Array<{ name: string; lastDate: string | null }>;
  /** Abonos del banco del mes sin factura (ni sugerida aceptada). */
  bankUnmatched?: { count: number; amount: number };
  /** Facturas de proveedor del mes esperando revisión o aprobación. */
  payablesAwaiting?: number;
  /** Aprobadas sin causar. null: sin programa que lo haga. */
  purchasesToBook?: number | null;
  receiptsToRegister?: number | null;
  supplierPaymentsToRegister?: number | null;
  /** Movimientos del mes que cuentan y no tienen categoría. */
  uncategorized?: { count: number; amount: number };
  /** ¿Hay salida de nómina con fecha del mes? */
  payrollRecorded?: boolean;
  /** Obligaciones que vencían en el mes y siguen pendientes. */
  taxPending?: Array<{ title: string; dueDate: string }>;
  /** Cuántas obligaciones vencían en el mes en total. */
  taxDue?: number;
  /** ¿Hay un conteo de inventario cerca del fin de mes? */
  inventoryCounted?: boolean;
}

const ERROR_CHECK: AutoCheck = {
  state: 'error',
  detail: 'No pude revisarlo ahora; vuelve a intentar en un momento.',
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function money(n: number): string {
  return `$ ${Math.round(n).toLocaleString('es-CO')}`;
}

/** Margen para el extracto: el último movimiento puede ser del último día hábil. */
export const STATEMENT_GRACE_DAYS = 3;

export function evaluateCheck(key: CloseTaskKey, data: CloseCheckData, period: string): AutoCheck {
  const end = periodEnd(period);
  switch (key) {
    case 'extractos': {
      if (!data.bankAccounts) return ERROR_CHECK;
      if (data.bankAccounts.length === 0)
        return {
          state: 'pendiente',
          count: 1,
          detail: 'Todavía no hay ningún extracto del banco importado.',
        };
      const cutoff = shiftDay(end, -STATEMENT_GRACE_DAYS);
      const behind = data.bankAccounts.filter((a) => !a.lastDate || a.lastDate < cutoff);
      if (!behind.length)
        return {
          state: 'ok',
          detail: `${plural(data.bankAccounts.length, 'cuenta', 'cuentas')} con extracto hasta fin de mes.`,
        };
      return {
        state: 'pendiente',
        count: behind.length,
        detail: `Falta el extracto hasta fin de mes de ${behind
          .slice(0, 4)
          .map((a) => `${a.name}${a.lastDate ? ` (va hasta el ${shortDay(a.lastDate)})` : ''}`)
          .join(', ')}${behind.length > 4 ? '…' : ''}.`,
      };
    }
    case 'conciliacion': {
      if (!data.bankUnmatched) return ERROR_CHECK;
      const { count, amount } = data.bankUnmatched;
      return count === 0
        ? { state: 'ok', detail: 'Todos los abonos del mes están atados a su factura.' }
        : {
            state: 'pendiente',
            count,
            detail: `${plural(count, 'abono', 'abonos')} del banco sin factura (${money(amount)}). Átalos o explícalos.`,
          };
    }
    case 'facturas_proveedor': {
      if (data.payablesAwaiting === undefined) return ERROR_CHECK;
      const n = data.payablesAwaiting;
      return n === 0
        ? { state: 'ok', detail: 'Ninguna factura del mes espera revisión o aprobación.' }
        : {
            state: 'pendiente',
            count: n,
            detail: `${plural(n, 'factura de proveedor espera', 'facturas de proveedor esperan')} revisión o aprobación.`,
          };
    }
    case 'causacion':
      return programCheck(
        data.purchasesToBook,
        'factura aprobada sin causar',
        'facturas aprobadas sin causar',
        'Todas las facturas aprobadas del mes están causadas.',
      );
    case 'recibos':
      return programCheck(
        data.receiptsToRegister,
        'pago de cliente sin recibo de caja',
        'pagos de clientes sin recibo de caja',
        'Todos los pagos de clientes del mes tienen su recibo.',
      );
    case 'pagos_proveedor':
      return programCheck(
        data.supplierPaymentsToRegister,
        'pago a proveedor sin registrar',
        'pagos a proveedores sin registrar',
        'Todos los pagos a proveedores del mes están registrados.',
      );
    case 'sin_categoria': {
      if (!data.uncategorized) return ERROR_CHECK;
      const { count, amount } = data.uncategorized;
      return count === 0
        ? { state: 'ok', detail: 'Todos los movimientos del mes tienen categoría.' }
        : {
            state: 'pendiente',
            count,
            detail: `${plural(count, 'movimiento', 'movimientos')} sin categoría (${money(amount)}).`,
          };
    }
    case 'nomina':
      if (data.payrollRecorded === undefined) return ERROR_CHECK;
      return data.payrollRecorded
        ? { state: 'ok', detail: 'Hay pago de nómina anotado en el mes.' }
        : {
            state: 'pendiente',
            count: 1,
            detail: 'No veo el pago de la nómina del mes en el libro.',
          };
    case 'impuestos': {
      if (!data.taxPending) return ERROR_CHECK;
      if (data.taxPending.length === 0)
        return data.taxDue === 0
          ? { state: 'no_aplica', detail: 'No vencía ninguna obligación este mes.' }
          : { state: 'ok', detail: 'Lo que vencía este mes está presentado o pagado.' };
      return {
        state: 'pendiente',
        count: data.taxPending.length,
        detail: `Falta: ${data.taxPending
          .slice(0, 3)
          .map((t) => `${t.title} (vencía el ${shortDay(t.dueDate)})`)
          .join('; ')}${data.taxPending.length > 3 ? '…' : ''}.`,
      };
    }
    case 'inventario':
      if (data.inventoryCounted === undefined) return ERROR_CHECK;
      return data.inventoryCounted
        ? { state: 'ok', detail: 'Hay un conteo físico registrado al cierre.' }
        : {
            state: 'pendiente',
            count: 1,
            detail: 'No hay conteo de inventario registrado cerca del fin de mes.',
          };
    case 'provisiones':
    case 'depreciacion':
      return { state: 'manual', detail: 'Recordatorio: lo marca una persona cuando lo hizo.' };
  }
}

function programCheck(
  value: number | null | undefined,
  one: string,
  many: string,
  okDetail: string,
): AutoCheck {
  if (value === undefined) return ERROR_CHECK;
  if (value === null)
    return {
      state: 'no_aplica',
      detail: 'Sin programa contable conectado: se registra a mano donde lleven la contabilidad.',
    };
  return value === 0
    ? { state: 'ok', detail: okDetail }
    : { state: 'pendiente', count: value, detail: `${plural(value, one, many)}.` };
}

export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** «30 sep». */
export function shortDay(day: string): string {
  const [, m, d] = day.split('-');
  return `${Number(d)} ${(MONTHS[Number(m) - 1] ?? '').slice(0, 3)}`.trim();
}

// ---------------------------------------------------------------------------
// Listo, progreso y candado
// ---------------------------------------------------------------------------

export interface TaskLike {
  key: string;
  status: TaskStatus;
  auto: AutoCheck | null;
}

/** Lista: la revisión dice al día o no aplica, o una persona la cerró. */
export function taskReady(t: TaskLike): boolean {
  if (t.status === 'hecha' || t.status === 'no_aplica') return true;
  return t.auto?.state === 'ok' || t.auto?.state === 'no_aplica';
}

export function progressOf(tasks: readonly TaskLike[]): { done: number; total: number } {
  return { done: tasks.filter(taskReady).length, total: tasks.length };
}

export interface PeriodLockLike {
  status: CloseStatus;
  override_until: string | null;
}

/** ¿Están bloqueados los cambios de Cortex en este mes ahora? */
export function isLocked(p: PeriodLockLike | null | undefined, now: Date = new Date()): boolean {
  if (!p || p.status !== 'cerrado') return false;
  return !(p.override_until && Date.parse(p.override_until) > now.getTime());
}

/** Minutos que dura una ventana de cambios en un mes cerrado. */
export const OVERRIDE_MINUTES = 120;

export class PeriodLockedError extends Error {
  constructor(
    readonly period: string,
    action: string,
  ) {
    super(
      `${periodLabel(period)} está cerrado: no se puede ${action} con fecha de ese mes. Un administrador puede reabrirlo o abrir una ventana de cambios en /cierre.`,
    );
    this.name = 'PeriodLockedError';
  }
}

/** «Cierre de septiembre: faltan 4 cosas». */
export function closeHeadline(period: string, pending: number): string {
  if (pending === 0) return `Cierre de ${monthName(period)}: todo listo para cerrar`;
  return `Cierre de ${monthName(period)}: ${pending === 1 ? 'falta 1 cosa' : `faltan ${pending} cosas`}`;
}
