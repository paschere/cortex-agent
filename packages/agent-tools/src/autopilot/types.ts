/**
 * EL VOCABULARIO DEL PILOTO AUTOMÁTICO (migración 0176).
 *
 * Cada mañana Cortex arma el plan del día de una empresa: lo que encontró en
 * sus datos (cartera vencida, pagos del banco sin atar, movimientos sin
 * categoría, sincronizaciones caídas, vencimientos, gente sobrecargada,
 * aprobaciones paradas, alertas de caja), decide qué de eso puede HACER solo,
 * qué tiene que PREGUNTAR y qué solo tiene que CONTAR, hace lo primero y le
 * deja al dueño una lista corta con lo segundo.
 *
 * Aquí sólo hay tipos y constantes. Nada de base de datos, nada de reloj.
 */

/** Las áreas del día. Cada una tiene su nivel en la configuración. */
export const AUTOPILOT_AREAS = [
  'cobro',
  'pagos',
  'conciliacion',
  'equipo',
  'procesos',
  'vencimientos',
  'gerencia',
  'finanzas',
] as const;
export type AutopilotArea = (typeof AUTOPILOT_AREAS)[number];

export const AREA_LABEL: Record<AutopilotArea, string> = {
  cobro: 'Cobro de cartera',
  pagos: 'Pagos',
  conciliacion: 'Conciliación del banco',
  equipo: 'Equipo',
  procesos: 'Procesos y sincronizaciones',
  vencimientos: 'Vencimientos',
  gerencia: 'Gerencia y aprobaciones',
  finanzas: 'Caja y libro de plata',
};

/** Qué cubre cada área, en una frase para la pantalla de configuración. */
export const AREA_HINT: Record<AutopilotArea, string> = {
  cobro:
    'Facturas vencidas: preparo el correo de cobro al contacto del cliente. Sólo sale sin tu clic si un mandato lo permite.',
  pagos: 'Lo que hay que pagar pronto. Nunca muevo plata: sólo te lo cuento o te lo propongo.',
  conciliacion:
    'Pagos que entraron al banco y casan sin duda con una sola factura: los ato a su factura.',
  equipo: 'Personas sobrecargadas o con vencidos acumulados: propongo repartir el trabajo.',
  procesos: 'Carpetas, tablas y programas contables que dejaron de sincronizar: los reintento.',
  vencimientos: 'Compromisos que vencen en los próximos dos días: le recuerdo a su responsable.',
  gerencia: 'Aprobaciones que llevan días paradas: te cuento cuántas y desde cuándo.',
  finanzas: 'Movimientos del libro sin categoría y alertas de caja: los ordeno y te aviso.',
};

/**
 * El nivel que la empresa le da a cada área.
 *
 *   avisar    Sólo te cuento lo que vi. No preparo ni hago nada.
 *   proponer  Te dejo cada cosa lista para que la apruebes con un clic.
 *   hacer     Hago lo rutinario que tengo permitido; lo demás te lo propongo.
 */
export const AUTOPILOT_LEVELS = ['avisar', 'proponer', 'hacer'] as const;
export type AutopilotLevel = (typeof AUTOPILOT_LEVELS)[number];

export const LEVEL_LABEL: Record<AutopilotLevel, string> = {
  avisar: 'Sólo avisar',
  proponer: 'Proponer',
  hacer: 'Hacer lo rutinario',
};

export type AutopilotRisk = 'low' | 'medium' | 'high';

/**
 * Qué clase de efecto tiene la acción propuesta. Lo declara el recolector,
 * que sabe qué está proponiendo; la política lo vuelve a comprobar contra el
 * id de la herramienta y contra la clasificación de seguridad, y gana la
 * lectura más estricta.
 *
 *   internal_write   escribe en un sistema de la empresa (categorizar, atar un
 *                    pago a su factura, reintentar una sincronización).
 *   internal_notice  le avisa a alguien del equipo (campana / correo interno).
 *   external_message sale de la empresa (correo a un cliente).
 *   money            mueve plata. NUNCA se hace solo.
 */
export type AutopilotEffect = 'internal_write' | 'internal_notice' | 'external_message' | 'money';

export interface ProposedAction {
  toolId: string;
  input: Record<string, unknown>;
}

/** Cómo deshacer lo hecho, cuando la fuente lo permite. Un enlace interno. */
export interface UndoHint {
  href: string;
  label: string;
}

/**
 * Una cosa que el piloto encontró hoy.
 *
 * `why` es la evidencia, con cifras, escrita por reglas: «Coltrans lleva 47
 * días de mora en la factura FE-1043 ($ 12.400.000)». Nunca la escribe un
 * modelo: es la frase que justifica algo que Cortex quizá haga solo.
 *
 * `dedupeKey` identifica la COSA, no el día: la misma factura vencida mañana
 * lleva la misma clave, y así una propuesta abierta no se repite.
 */
export interface PlanItem {
  area: AutopilotArea;
  title: string;
  why: string;
  proposedAction: ProposedAction | null;
  effect: AutopilotEffect | null;
  risk: AutopilotRisk;
  amount?: number | null;
  currency?: string | null;
  counterparty?: string | null;
  dedupeKey: string;
  /** El enlace a la fuente, para «ver» desde la línea de tiempo. */
  href?: string | null;
  undo?: UndoHint | null;
}

export type AutopilotDecision = 'do' | 'ask' | 'tell';

export const DECISION_LABEL: Record<AutopilotDecision, string> = {
  do: 'Lo hago',
  ask: 'Necesita tu decisión',
  tell: 'Para que sepas',
};

/** Por qué se pudo hacer solo: un mandato, o la regla de lo interno y rutinario. */
export type AutopilotAuthority = 'mandate' | 'routine';

export interface DecidedItem extends PlanItem {
  decision: AutopilotDecision;
  /** La razón de la decisión, en español, para la pantalla. */
  decisionReason: string;
  authority: AutopilotAuthority | null;
  mandateId: string | null;
  mandateLabel: string | null;
}

export interface AutopilotPlan {
  day: string;
  items: DecidedItem[];
  counts: { do: number; ask: number; tell: number };
  /** Fuentes que no se pudieron leer: el plan lo dice, no lo esconde. */
  sourceErrors: Array<{ source: string; message: string }>;
  /** Cosas que ya se decidieron otro día y no se vuelven a plantear. */
  suppressed: number;
}

export const ITEM_STATUSES = [
  'planned',
  'done',
  'failed',
  'skipped',
  'asked',
  'told',
  'dismissed',
] as const;
export type AutopilotItemStatus = (typeof ITEM_STATUSES)[number];

export const ITEM_STATUS_LABEL: Record<AutopilotItemStatus, string> = {
  planned: 'En cola',
  done: 'Hecho',
  failed: 'No se pudo',
  skipped: 'Omitido',
  asked: 'Espera tu decisión',
  told: 'Te lo conté',
  dismissed: 'Descartado',
};

export const RUN_STATUSES = ['running', 'done', 'stopped', 'failed'] as const;
export type AutopilotRunStatus = (typeof RUN_STATUSES)[number];

/** La verificación que dejó la capa de acciones seguras (0168), si hubo. */
export type AutopilotVerification = 'verified' | 'not_verified' | 'unverifiable' | null;
