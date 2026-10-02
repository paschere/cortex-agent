import { z } from 'zod';
import { isBusinessDay } from '../management/follow-up';
import {
  AUTOPILOT_AREAS,
  AUTOPILOT_LEVELS,
  type AutopilotArea,
  type AutopilotLevel,
} from './types';

/**
 * LA CONFIGURACIÓN DEL PILOTO POR EMPRESA (tabla `autopilot_settings`, 0176).
 *
 * Nace APAGADO. Un piloto que se enciende solo es exactamente lo contrario de
 * lo que promete: la primera vez que Cortex hace algo sin preguntar tiene que
 * ser porque alguien con autoridad sobre la empresa dijo «hazte cargo».
 *
 * Todo lo de aquí es puro: leer una fila (con lo que sea que traiga) y
 * devolver una configuración completa y válida, y decidir si hoy toca correr.
 */

export interface AutopilotSettings {
  enabled: boolean;
  /** Hora local de Bogotá (0–23) a la que corre. Por defecto, 7. */
  runHour: number;
  /** Días ISO (1 = lunes … 7 = domingo). Por defecto, lunes a viernes. */
  runDays: number[];
  /** Los festivos de Colombia no se corre. Por defecto, sí se saltan. */
  skipHolidays: boolean;
  /** Días puntuales sin piloto (AAAA-MM-DD): cierres, vacaciones colectivas. */
  quietDays: string[];
  areaLevels: Record<AutopilotArea, AutopilotLevel>;
  /** Tope de mensajes que salen de la empresa por día. */
  maxExternalMessages: number;
  /** Tope de plata mencionada en lo que se hace solo en un día (suma). */
  maxAmountReferenced: number;
  currency: string;
  /** Tope de acciones que se ejecutan por corrida: el techo de costo. */
  maxActionsPerRun: number;
  /** En nombre de quién actúa. Quien lo encendió, salvo que se cambie. */
  actorUserId: string | null;
  /** Además de la campana, un correo con el resumen. */
  notifyEmail: boolean;
  enabledAt: string | null;
  updatedAt: string | null;
}

export const DEFAULT_AREA_LEVELS: Record<AutopilotArea, AutopilotLevel> = {
  // Lo que sale de la empresa empieza en proponer: el correo queda listo y el
  // dueño lo aprueba con un clic.
  cobro: 'proponer',
  // La plata nunca se mueve sola; ni siquiera se propone por defecto.
  pagos: 'avisar',
  // Lo interno, rutinario y reversible empieza en hacer.
  conciliacion: 'hacer',
  equipo: 'proponer',
  procesos: 'hacer',
  vencimientos: 'hacer',
  gerencia: 'hacer',
  finanzas: 'hacer',
};

export const DEFAULT_SETTINGS: AutopilotSettings = {
  enabled: false,
  runHour: 7,
  runDays: [1, 2, 3, 4, 5],
  skipHolidays: true,
  quietDays: [],
  areaLevels: DEFAULT_AREA_LEVELS,
  maxExternalMessages: 5,
  maxAmountReferenced: 20_000_000,
  currency: 'COP',
  maxActionsPerRun: 25,
  actorUserId: null,
  notifyEmail: true,
  enabledAt: null,
  updatedAt: null,
};

/** Los límites que acepta la configuración. Fuera de rango se recorta. */
export const LIMITS = {
  maxExternalMessages: { min: 0, max: 50 },
  maxActionsPerRun: { min: 1, max: 100 },
  maxAmountReferenced: { min: 0, max: 100_000_000_000 },
  quietDays: 60,
} as const;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/** La fila de la base, tal cual llega. Todo opcional: una fila vieja o parcial. */
export interface AutopilotSettingsRow {
  enabled?: boolean | null;
  run_hour?: number | null;
  run_days?: number[] | null;
  skip_holidays?: boolean | null;
  quiet_days?: string[] | null;
  area_levels?: Record<string, unknown> | null;
  max_external_messages?: number | null;
  max_amount_referenced?: number | string | null;
  currency?: string | null;
  max_actions_per_run?: number | null;
  actor_user_id?: string | null;
  notify_email?: boolean | null;
  enabled_at?: string | null;
  updated_at?: string | null;
}

/**
 * De la fila a la configuración. Lo que no se entiende cae al valor por
 * defecto — y `enabled` sólo es verdadero si la fila dice `true` y nada más.
 */
export function settingsFromRow(row: AutopilotSettingsRow | null | undefined): AutopilotSettings {
  if (!row) return { ...DEFAULT_SETTINGS, areaLevels: { ...DEFAULT_AREA_LEVELS } };
  const levels = { ...DEFAULT_AREA_LEVELS };
  const raw = row.area_levels && typeof row.area_levels === 'object' ? row.area_levels : {};
  for (const area of AUTOPILOT_AREAS) {
    const v = (raw as Record<string, unknown>)[area];
    if (typeof v === 'string' && (AUTOPILOT_LEVELS as readonly string[]).includes(v))
      levels[area] = v as AutopilotLevel;
  }
  // El área de pagos nunca pasa de proponer: «hacer» ahí significaría mover
  // plata, y eso no lo hace el piloto bajo ninguna configuración.
  if (levels.pagos === 'hacer') levels.pagos = 'proponer';

  const runHour = num(row.run_hour);
  const days = (row.run_days ?? []).filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
  const quiet = (row.quiet_days ?? []).filter((d) => typeof d === 'string' && ISO_DAY.test(d));
  const ext = num(row.max_external_messages);
  const amount = num(row.max_amount_referenced);
  const actions = num(row.max_actions_per_run);
  const currency = (row.currency ?? '').trim().toUpperCase();

  return {
    enabled: row.enabled === true,
    runHour: runHour === null ? DEFAULT_SETTINGS.runHour : clamp(Math.round(runHour), 0, 23),
    runDays: days.length > 0 ? [...new Set(days)].sort() : [...DEFAULT_SETTINGS.runDays],
    skipHolidays: row.skip_holidays !== false,
    quietDays: [...new Set(quiet)].sort().slice(-LIMITS.quietDays),
    areaLevels: levels,
    maxExternalMessages:
      ext === null
        ? DEFAULT_SETTINGS.maxExternalMessages
        : clamp(Math.round(ext), LIMITS.maxExternalMessages.min, LIMITS.maxExternalMessages.max),
    maxAmountReferenced:
      amount === null
        ? DEFAULT_SETTINGS.maxAmountReferenced
        : clamp(amount, LIMITS.maxAmountReferenced.min, LIMITS.maxAmountReferenced.max),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : DEFAULT_SETTINGS.currency,
    maxActionsPerRun:
      actions === null
        ? DEFAULT_SETTINGS.maxActionsPerRun
        : clamp(Math.round(actions), LIMITS.maxActionsPerRun.min, LIMITS.maxActionsPerRun.max),
    actorUserId: row.actor_user_id ?? null,
    notifyEmail: row.notify_email !== false,
    enabledAt: row.enabled_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/** El esquema del cambio parcial que aceptan la pantalla y `autopilot.configure`. */
export const settingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  runHour: z.number().int().min(0).max(23).optional(),
  runDays: z.array(z.number().int().min(1).max(7)).min(1).max(7).optional(),
  skipHolidays: z.boolean().optional(),
  quietDays: z
    .array(z.string().regex(ISO_DAY, 'Usa fechas AAAA-MM-DD.'))
    .max(LIMITS.quietDays)
    .optional(),
  areaLevels: z.record(z.enum(AUTOPILOT_AREAS), z.enum(AUTOPILOT_LEVELS)).optional(),
  maxExternalMessages: z
    .number()
    .int()
    .min(LIMITS.maxExternalMessages.min)
    .max(LIMITS.maxExternalMessages.max)
    .optional(),
  maxAmountReferenced: z
    .number()
    .min(LIMITS.maxAmountReferenced.min)
    .max(LIMITS.maxAmountReferenced.max)
    .optional(),
  maxActionsPerRun: z
    .number()
    .int()
    .min(LIMITS.maxActionsPerRun.min)
    .max(LIMITS.maxActionsPerRun.max)
    .optional(),
  notifyEmail: z.boolean().optional(),
});
export type AutopilotSettingsPatch = z.infer<typeof settingsPatchSchema>;

/** Aplica un cambio parcial y devuelve la fila a guardar (sin organización). */
export function applyPatch(
  current: AutopilotSettings,
  patch: AutopilotSettingsPatch,
  actor: { userId: string; now: Date },
): AutopilotSettingsRow & { updated_by: string } {
  const levels = { ...current.areaLevels, ...(patch.areaLevels ?? {}) };
  if (levels.pagos === 'hacer') levels.pagos = 'proponer';
  const turningOn = patch.enabled === true && !current.enabled;
  const enabled = patch.enabled ?? current.enabled;
  return {
    enabled,
    run_hour: patch.runHour ?? current.runHour,
    run_days: patch.runDays ? [...new Set(patch.runDays)].sort() : current.runDays,
    skip_holidays: patch.skipHolidays ?? current.skipHolidays,
    quiet_days: patch.quietDays ? [...new Set(patch.quietDays)].sort() : current.quietDays,
    area_levels: levels,
    max_external_messages: patch.maxExternalMessages ?? current.maxExternalMessages,
    max_amount_referenced: patch.maxAmountReferenced ?? current.maxAmountReferenced,
    currency: current.currency,
    max_actions_per_run: patch.maxActionsPerRun ?? current.maxActionsPerRun,
    notify_email: patch.notifyEmail ?? current.notifyEmail,
    // Quien lo enciende es en nombre de quien actúa. Encenderlo otra vez no
    // cambia al actor; encenderlo desde apagado, sí.
    actor_user_id: turningOn || !current.actorUserId ? actor.userId : current.actorUserId,
    enabled_at: turningOn ? actor.now.toISOString() : current.enabledAt,
    updated_by: actor.userId,
  };
}

/** Día ISO (1 = lunes … 7 = domingo) de una fecha AAAA-MM-DD. */
export function autopilotWeekday(day: string): number {
  const d = new Date(`${day}T12:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export type RunGate =
  | { run: true }
  | { run: false; reason: 'apagado' | 'dia_no_configurado' | 'festivo' | 'dia_quieto' };

/** ¿Corre hoy? Independiente de la hora (la hora la mira el repartidor). */
export function runGate(settings: AutopilotSettings, day: string): RunGate {
  if (!settings.enabled) return { run: false, reason: 'apagado' };
  if (settings.quietDays.includes(day)) return { run: false, reason: 'dia_quieto' };
  if (!settings.runDays.includes(autopilotWeekday(day)))
    return { run: false, reason: 'dia_no_configurado' };
  // Sólo los festivos entre semana: `isBusinessDay` también dice que no a
  // sábados y domingos, y esos los decide `runDays`.
  const weekday = autopilotWeekday(day) <= 5;
  if (settings.skipHolidays && weekday && !isBusinessDay(day))
    return { run: false, reason: 'festivo' };
  return { run: true };
}

export const GATE_REASON_TEXT: Record<Exclude<RunGate, { run: true }>['reason'], string> = {
  apagado: 'El piloto automático está apagado.',
  dia_no_configurado: 'Hoy no es uno de los días en que corre el piloto.',
  festivo: 'Hoy es festivo y el piloto no corre en festivos.',
  dia_quieto: 'Hoy está marcado como día sin piloto.',
};

/** «7:00 a. m.», para la pantalla y los mensajes. */
export function hourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${hour < 12 ? 'a. m.' : 'p. m.'}`;
}

const DAY_SHORT = ['', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

/** «lunes a viernes», «lun, mié y vie», «todos los días». */
export function daysLabel(days: number[]): string {
  const set = [...new Set(days)].sort();
  if (set.length === 7) return 'todos los días';
  if (set.join(',') === '1,2,3,4,5') return 'lunes a viernes';
  if (set.join(',') === '1,2,3,4,5,6') return 'lunes a sábado';
  const names = set.map((d) => DAY_SHORT[d] ?? String(d));
  return names.length <= 1
    ? (names[0] ?? 'ningún día')
    : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
}
