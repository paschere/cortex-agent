/**
 * EL CONTRATO DEL REGISTRO DE TRABAJO.
 *
 * Un solo registro de trabajo asignado: cada cosa que alguien del equipo tiene
 * que hacer o hizo, con su responsable, cuándo se abrió, cuándo vence y cuándo
 * se cerró. Se llena desde lo que ya existe (casos de Gerencia, vencimientos,
 * filas de tablas con responsable, cartera asignada, aprobaciones que esperan
 * a alguien, solicitudes) y desde cualquier fuente que Cortex lea (el chat, una
 * hoja, un grupo de WhatsApp de operación).
 *
 * Mide TRABAJO, no personas: resultados y tareas, nunca el contenido de chats
 * o correos personales. Cada persona puede ver todo lo que se mide de ella.
 *
 * Es el acuerdo entre dos mitades que se construyen a la vez: el registro
 * (store, ingesta, herramientas) y las métricas (motor puro). Agregar campos
 * opcionales sí; cambiar o quitar, no.
 *
 * Fechas: ISO (`YYYY-MM-DD` o con hora). Días de Bogotá.
 */

export type WorkSourceKind =
  | 'management_case'
  | 'commitment'
  | 'tracker_row'
  | 'receivable'
  | 'approval'
  | 'request'
  | 'routine'
  | 'manual'
  | 'chat'
  | 'sheet'
  | 'whatsapp';

export interface WorkSource {
  kind: WorkSourceKind;
  /** Tabla, proceso o sistema dentro de la fuente: 'guias', 'despachos', … */
  system?: string | null;
  /** Identidad del ítem EN su fuente: re-ingerirlo no lo duplica. */
  ref: string;
}

/** open: por hacer. done: hecho. cancelled: ya no aplica (no cuenta en contra). */
export type WorkStatus = 'open' | 'done' | 'cancelled';

export interface WorkItem {
  id: string;
  /** Persona responsable (users.id). Nulo = sin asignar. */
  assigneeId: string | null;
  /** Tipo de trabajo, para comparar peras con peras: 'despacho', 'cobro', 'caso', 'solicitud', … */
  workType: string;
  title: string;
  status: WorkStatus;
  openedAt: string;
  dueAt?: string | null;
  doneAt?: string | null;
  /** Resultado medible opcional: guías despachadas, plata cobrada… */
  quantity?: number | null;
  /** Unidad de `quantity`: 'guías', 'COP', 'pedidos'. */
  unit?: string | null;
  /** Equipo o área, si la empresa lo usa. */
  team?: string | null;
  source: WorkSource;
  /**
   * Último movimiento visible (cambio de estado, comentario, nueva revisión).
   * Sin él, el ítem se cuenta quieto desde `openedAt` (métricas: «sin moverse»).
   */
  lastActivityAt?: string | null;
}

export interface WorkPerson {
  id: string;
  name: string;
  email?: string | null;
  team?: string | null;
  role?: string | null;
  /** Días sin trabajar en el período (vacaciones, incapacidad): no cuentan en contra. */
  awayDays?: string[];
}

// ---------------------------------------------------------------------------
// MÉTRICAS
// ---------------------------------------------------------------------------

export interface WorkPeriod {
  /** Inclusive. */
  from: string;
  /** Inclusive. */
  to: string;
}

/** Las cifras de una persona en un período y un tipo de trabajo (o todos). */
export interface PersonWorkStats {
  personId: string;
  workType: string | 'all';
  period: WorkPeriod;
  /** Abiertos al cierre del período. */
  openNow: number;
  /** De los abiertos, cuántos ya vencieron. */
  overdueNow: number;
  /** Cerrados en el período. */
  done: number;
  /** De los cerrados con vencimiento, fracción cerrada a tiempo (0–1); nulo si no hay base. */
  onTimeRate: number | null;
  /** Mediana de horas entre abrir y cerrar; nulo si no hay base. */
  medianCycleHours: number | null;
  /** Suma de `quantity` de lo cerrado, por unidad. */
  output: Record<string, number>;
  /** Días trabajables del período (descontando `awayDays`). */
  workingDays: number;
  /** Cuántos ítems respaldan las cifras. */
  sample: number;
  /** De los cerrados, cuántos tenían vencimiento: la base de `onTimeRate`. */
  withDue?: number;
}

export interface TeamBaseline {
  workType: string | 'all';
  period: WorkPeriod;
  /** Medianas del equipo, por persona y por día trabajable cuando aplica. */
  medianOpen: number;
  medianDonePerDay: number;
  medianOnTimeRate: number | null;
  medianCycleHours: number | null;
  people: number;
}

export type WorkSignalKind =
  | 'overloaded'
  | 'overdue_pile'
  | 'slowing'
  | 'improving'
  | 'standout'
  | 'unassigned_pile'
  | 'stale_item';

/** Algo que vale la pena mirar, dicho con su evidencia y una acción sugerida. */
export interface WorkSignal {
  kind: WorkSignalKind;
  personId?: string | null;
  workType?: string | null;
  severity: 'info' | 'warn' | 'critical';
  /** En palabras: «Laura tiene 14 pendientes, 6 vencidos; la mediana del equipo es 5». */
  message: string;
  /** Las cifras que respaldan el mensaje (para auditar y para el chequeo de números). */
  evidence: Record<string, number | string>;
  /** Lo que se podría hacer: «Reasignar 4 a Andrés (tiene 3 abiertos)». */
  suggestion?: string | null;
  /** Ítems concretos involucrados. */
  itemIds?: string[];
}

/** La foto completa: por persona, por tipo, con la línea base y las señales. */
export interface TeamWorkReport {
  period: WorkPeriod;
  previous: WorkPeriod;
  people: Array<{
    person: WorkPerson;
    current: PersonWorkStats;
    previous: PersonWorkStats | null;
    byType: PersonWorkStats[];
  }>;
  baselines: TeamBaseline[];
  signals: WorkSignal[];
  /** Supuestos y límites, en palabras (p. ej. «sin vencimiento no se mide a tiempo»). */
  notes: string[];
  /** «Hoy» con el que se tomó la foto, si el período no había terminado. */
  asOf?: string | null;
}
