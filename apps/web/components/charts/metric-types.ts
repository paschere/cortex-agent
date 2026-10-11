import type { ChartTone } from './colors';
import type { DayPoint, DrillRecord, ProjectionPoint } from './interactive';

/**
 * Lo que un gráfico de métrica necesita, todo serializable: viaja del servidor
 * al navegador tal cual (por eso no hay funciones; las cifras se escriben con
 * `fmt` y `currency`).
 */

export interface MetricEvent {
  /** Día del evento (`AAAA-MM-DD`). */
  date: string;
  /** «Nómina», «Vence FE-2231». */
  label: string;
  tone?: ChartTone;
}

export interface MetricModel {
  id: string;
  /** «Caja», «Te deben vencido». */
  label: string;
  /** Una frase corta bajo el nombre en la tira de indicadores. */
  hint?: string;
  fmt: 'money' | 'count';
  currency: string;
  /** Rótulo de la unidad cuando es un conteo («cosas»). */
  unit?: string;
  /** `stock`: un saldo (caja, deuda). `flow`: lo que pasa por día (ventas, pagos). */
  kind: 'stock' | 'flow';
  tone: ChartTone;
  /** ¿Subir es bueno? (la caja sí; lo vencido no). */
  goodWhenUp: boolean;
  daily: DayPoint[];
  /** Sólo `stock`: lo que viene, con su rango probable. */
  projection?: ProjectionPoint[];
  /** Sólo `flow`: la serie ya incluye días futuros (lo que vence). */
  futureInDaily?: boolean;
  /** Entradas y salidas del día, para las barras opcionales de la caja. */
  inOut?: { inflow: DayPoint[]; outflow: DayPoint[] };
  threshold?: { value: number; label: string };
  events?: MetricEvent[];
  records?: DrillRecord[];
  /** Cómo se buscan los registros de un punto: por fecha (`flow`) o los abiertos al cierre (`stock`). Por defecto, el `kind`. */
  recordsKind?: 'flow' | 'stock';
  /** La pantalla completa de donde sale la cifra. */
  fullHref?: string;
  fullLabel?: string;
  /** Con qué verbo se llaman los registros: «movimientos», «facturas». */
  recordsNoun?: string;
}
