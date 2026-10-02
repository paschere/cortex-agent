/**
 * EL CONTRATO DEL LIBRO DE PLATA.
 *
 * Un solo libro de movimientos para toda la plata de la empresa: lo que entró
 * y salió (liquidado) y lo que va a entrar o salir (esperado: por cobrar, por
 * pagar). Se llena desde cualquier fuente —Siigo/Alegra/QuickBooks, extractos
 * del banco, pagos registrados, facturas leídas de documentos, hojas de
 * cálculo, el chat— y cada fila dice de dónde salió.
 *
 * Este archivo es el acuerdo entre las dos mitades que se construyen a la vez:
 * el libro (store, ingesta, herramientas que escriben) y la proyección de caja
 * (motor puro de 13 semanas con escenarios). Ninguna de las dos lo cambia sin
 * la otra: agregar campos opcionales sí, cambiar o quitar, no.
 *
 * Montos: números positivos en unidades de la moneda (pesos, no centavos), con
 * `direction` diciendo el sentido. Fechas: ISO `YYYY-MM-DD` (día de Bogotá
 * cuando la fuente no trae hora).
 */

export type LedgerDirection = 'in' | 'out';

/**
 * income/expense: plata que ya se movió (o se moverá) sin factura de por medio.
 * receivable/payable: una factura por cobrar / por pagar, con vencimiento.
 * transfer: entre cuentas propias; no cuenta como ingreso ni gasto.
 */
export type LedgerKind = 'income' | 'expense' | 'receivable' | 'payable' | 'transfer';

/** expected: todavía no pasa. settled: ya pasó. cancelled: anulada, no cuenta. */
export type LedgerStatus = 'expected' | 'settled' | 'cancelled';

export type LedgerSourceKind =
  | 'accounting'
  | 'bank'
  | 'payment'
  | 'document'
  | 'sheet'
  | 'manual'
  | 'chat';

export interface LedgerSource {
  kind: LedgerSourceKind;
  /** 'siigo', 'alegra', 'quickbooks', 'extracto · Bancolombia ahorros', … */
  system?: string | null;
  /** La identidad del movimiento EN su fuente: re-ingerirlo no lo duplica. */
  ref: string;
}

/** Quién puso la categoría: una regla, el modelo, o una persona (manda). */
export type CategorySource = 'rule' | 'model' | 'person';

export interface LedgerMovement {
  id: string;
  direction: LedgerDirection;
  kind: LedgerKind;
  status: LedgerStatus;
  amount: number;
  currency: string;
  /** Emisión (facturas) o fecha del movimiento (lo liquidado). */
  date: string;
  /** Vencimiento de lo esperado, si lo hay. */
  dueDate?: string | null;
  /** Cuándo se liquidó, si ya pasó. */
  settledAt?: string | null;
  /** Saldo pendiente de una factura (receivable/payable) si es parcial. */
  outstanding?: number | null;
  counterpartyName?: string | null;
  counterpartyTaxId?: string | null;
  category?: string | null;
  categorySource?: CategorySource | null;
  description: string;
  /** Cuenta de caja propia (banco, efectivo) donde pasó, si se sabe. */
  accountId?: string | null;
  source: LedgerSource;
}

export interface CashAccount {
  id: string;
  name: string;
  currency: string;
  /** Último saldo conocido y cuándo. */
  balance: number;
  balanceAt: string;
  source: LedgerSource;
}

/** Las categorías de gasto/ingreso que entiende cualquier dueño. Extensible. */
export const LEDGER_CATEGORIES = [
  'ventas',
  'otros_ingresos',
  'nomina',
  'arriendo',
  'servicios_publicos',
  'transporte',
  'proveedores',
  'impuestos',
  'bancos_y_financieros',
  'software',
  'mercadeo',
  'mantenimiento',
  'honorarios',
  'otros_gastos',
] as const;
export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number];

// ---------------------------------------------------------------------------
// PROYECCIÓN DE CAJA
// ---------------------------------------------------------------------------

/** Cuánto suele demorar un cliente en pagar después del vencimiento. */
export interface CounterpartyBehavior {
  counterpartyName: string;
  counterpartyTaxId?: string | null;
  /** Días promedio (mediana) de atraso observados; 0 = paga a tiempo. */
  typicalDelayDays: number;
  /** Fracción de facturas que terminó pagando (0–1). */
  collectionRate: number;
  /** Cuántas facturas respaldan la estimación. */
  sample: number;
}

/** Un gasto/ingreso que se repite, detectado del historial o declarado. */
export interface RecurringFlow {
  id: string;
  label: string;
  direction: LedgerDirection;
  amount: number;
  currency: string;
  every: 'week' | 'month';
  /** Día del mes (month) o de la semana 1–7 (week) en que suele pasar. */
  anchor: number;
  category?: string | null;
  /** detected: lo infirió el motor; declared: lo dijo una persona. */
  origin: 'detected' | 'declared';
  /** Ocurrencias que lo respaldan (detected). */
  sample?: number;
  /**
   * Contraparte, si siempre es la misma (arrendador, EPM). Opcional: sirve para
   * no contar dos veces un pago que ya está como factura por pagar, y para que
   * un escenario («se va Nexa») lo encuentre.
   */
  counterpartyName?: string | null;
  /**
   * La identidad ESTABLE de un recurrente detectado (contraparte o firma,
   * periodicidad y día), para que una persona lo confirme o lo ignore y la
   * decisión le siga valiendo cuando el historial avance. El `id` puede cambiar
   * de una corrida a otra; esto no. Sólo lo trae lo detectado.
   */
  detectedKey?: string | null;
}

export type ScenarioAdjustment =
  | { kind: 'delay_counterparty'; counterpartyName: string; days: number }
  | { kind: 'drop_counterparty'; counterpartyName: string }
  | {
      kind: 'add_recurring';
      label: string;
      direction: LedgerDirection;
      amount: number;
      every: 'week' | 'month';
      start: string;
    }
  | { kind: 'scale_category'; category: string; factor: number }
  | { kind: 'one_off'; label: string; direction: LedgerDirection; amount: number; date: string };

export interface Scenario {
  id: string;
  label: string;
  adjustments: ScenarioAdjustment[];
}

export interface ForecastInput {
  /** Hoy (día de Bogotá). */
  asOf: string;
  currency: string;
  accounts: CashAccount[];
  movements: LedgerMovement[];
  recurring?: RecurringFlow[];
  behavior?: CounterpartyBehavior[];
  horizonWeeks?: number;
  scenario?: Scenario | null;
  /** Debajo de esto la caja «se aprieta» y hay alerta. */
  minimumCash?: number | null;
  /**
   * Proyectar lo que todavía no se ha facturado a los clientes que facturan
   * casi todos los meses («Ventas estimadas a Nexa»), con menos probabilidad.
   * Por defecto, sí.
   */
  includeEstimatedSales?: boolean;
  /**
   * Detectar lo que se repite del historial. Por defecto sí, y lo declarado en
   * `recurring` se SUMA a lo detectado (lo declarado manda cuando hablan de lo
   * mismo). `false`: sólo la lista `recurring`.
   */
  detectRecurring?: boolean;
  /** `detectedKey` de recurrentes detectados que una persona dijo que ignore. */
  ignoredRecurring?: string[];
  /** `detectedKey` de recurrentes detectados que una persona confirmó. */
  confirmedRecurring?: string[];
}

/** Una línea de la proyección: por qué ese peso está en esa semana. */
export interface ForecastItem {
  label: string;
  direction: LedgerDirection;
  amount: number;
  /** Monto ya ponderado por la probabilidad de que pase. */
  expectedAmount: number;
  probability: number;
  expectedDate: string;
  movementId?: string | null;
  recurringId?: string | null;
  /** En palabras: «vence el 3 nov; Nexa suele pagar 12 días tarde». */
  reason: string;
  /** Contraparte y categoría, si se saben (para agrupar y explicar). Opcionales. */
  counterpartyName?: string | null;
  category?: string | null;
  /**
   * De dónde salió: un movimiento del libro, algo que se repite, el escenario,
   * o una venta todavía no facturada estimada del ritmo del cliente.
   */
  from?: 'movement' | 'recurring' | 'scenario' | 'estimate';
}

export interface ForecastWeek {
  /** Lunes de la semana. */
  start: string;
  opening: number;
  inflows: number;
  outflows: number;
  closing: number;
  items: ForecastItem[];
}

export interface ForecastAlert {
  kind: 'low_cash' | 'negative_cash' | 'concentration' | 'late_payer' | 'big_outflow';
  week?: string | null;
  severity: 'info' | 'warn' | 'critical';
  message: string;
}

export interface ForecastResult {
  asOf: string;
  currency: string;
  startingCash: number;
  weeks: ForecastWeek[];
  lowest: { week: string; closing: number };
  alerts: ForecastAlert[];
  /** Supuestos dichos en palabras, para que nada sea caja negra. */
  assumptions: string[];
  scenario?: Scenario | null;
  /** La caja mínima usada para las alertas (la fijada o un mes de gastos fijos); 0 = ninguna. */
  minimumCash?: number;
  /** Cuántas cuentas en la moneda pedida suman la caja inicial. */
  accountCount?: number;
}
