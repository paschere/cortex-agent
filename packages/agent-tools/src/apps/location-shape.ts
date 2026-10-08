import { z } from 'zod';

/**
 * UBICACIÓN DEL EQUIPO: LAS REGLAS PURAS (migración 0216).
 *
 * Sin base y sin Node: las usan el servidor (apps/location.ts), el editor y las
 * pruebas. Aquí viven las cosas que NO se pueden mover sin que cambie lo que le
 * prometimos a la persona: el texto que acepta, los topes de frecuencia y de
 * retención y qué es una coordenada válida.
 *
 * Ley 1581 de 2012 (habeas data): finalidad informada, consentimiento previo y
 * revocable, mínimo necesario, quién lo ve y cuánto se guarda. Por eso:
 *   - apagado por defecto en cada app;
 *   - la persona acepta UNA vez un texto con versión; si el texto cambia, vuelve
 *     a aceptar;
 *   - sólo se comparte con la app abierta y «en turno»;
 *   - se guarda la última posición y un historial corto que se borra solo.
 */

/** Cambia cuando cambia el sentido del texto: obliga a aceptar de nuevo. */
export const LOCATION_TEXT_VERSION = '2026-10-v1';

export const DEFAULT_RETENTION_DAYS = 30;
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 365;

/** Una posición por persona cada tanto como mucho; lo que llegue antes se descarta sin error. */
export const MIN_PING_INTERVAL_SECONDS = 15;
/** Del historial se guarda una muestra por minuto como mucho. */
export const HISTORY_INTERVAL_SECONDS = 60;
/** Pasado esto se pinta «sin señal»; pasado HIDE no se pinta. */
export const STALE_AFTER_SECONDS = 5 * 60;
export const HIDE_AFTER_SECONDS = 2 * 60 * 60;
/** Un turno que se quedó abierto se cierra solo pasadas estas horas. */
export const SHIFT_MAX_HOURS = 16;
/** Una precisión peor que ésta (metros) no sirve para un mapa: se descarta. */
export const MAX_ACCURACY_METERS = 5000;

export const locationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  retentionDays: z
    .number()
    .int()
    .min(MIN_RETENTION_DAYS)
    .max(MAX_RETENTION_DAYS)
    .default(DEFAULT_RETENTION_DAYS),
});
export type AppLocationSettings = z.infer<typeof locationSettingsSchema>;

/** Lo que dice la base; lo que no cumple el contrato queda apagado. */
export function parseLocationSettings(raw: unknown): AppLocationSettings {
  const parsed = locationSettingsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { enabled: false, retentionDays: DEFAULT_RETENTION_DAYS };
}

/** Un cambio parcial (chat y editor): sólo lo que viene. */
export const locationSettingsPatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    retentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(MAX_RETENTION_DAYS).optional(),
  })
  .strict();

export type PersonKind = 'member' | 'app_user';

/** «m:uuid» / «u:uuid»: cómo viaja una persona entre el servidor y el navegador. */
export function personRef(kind: PersonKind, id: string): string {
  return `${kind === 'member' ? 'm' : 'u'}:${id}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePersonRef(raw: unknown): { kind: PersonKind; id: string } | null {
  if (typeof raw !== 'string') return null;
  const m = /^([mu]):(.+)$/.exec(raw);
  if (!m || !UUID_RE.test(m[2] ?? '')) return null;
  return { kind: m[1] === 'm' ? 'member' : 'app_user', id: (m[2] as string).toLowerCase() };
}

export interface RawPosition {
  lat?: unknown;
  lng?: unknown;
  accuracy?: unknown;
  heading?: unknown;
  speed?: unknown;
  battery?: unknown;
}

export interface Position {
  lat: number;
  lng: number;
  accuracyM: number | null;
  heading: number | null;
  speedMps: number | null;
  batteryPct: number | null;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Valida lo que manda un teléfono. Null = no sirve (no es un error del
 * usuario: es un GPS que mintió). La hora NO se toma del teléfono: la pone el
 * servidor, así un reloj mal puesto no falsea «hace cuánto».
 */
export function parsePosition(raw: RawPosition): Position | null {
  const lat = num(raw.lat);
  const lng = num(raw.lng);
  if (lat === null || lng === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  // (0, 0) es el «no tengo posición» de muchos aparatos, no un lugar.
  if (lat === 0 && lng === 0) return null;
  const accuracy = num(raw.accuracy);
  if (accuracy !== null && (accuracy < 0 || accuracy > MAX_ACCURACY_METERS)) return null;
  const heading = num(raw.heading);
  const speed = num(raw.speed);
  const battery = num(raw.battery);
  return {
    lat: Math.round(lat * 1e6) / 1e6,
    lng: Math.round(lng * 1e6) / 1e6,
    accuracyM: accuracy === null ? null : Math.round(accuracy),
    heading: heading !== null && heading >= 0 && heading <= 360 ? Math.round(heading) : null,
    speedMps: speed !== null && speed >= 0 && speed <= 400 ? Math.round(speed * 10) / 10 : null,
    batteryPct: battery !== null && battery >= 0 && battery <= 100 ? Math.round(battery) : null,
  };
}

/** ¿Pasó el intervalo mínimo desde la última muestra? */
export function pingAllowed(lastRecordedAt: string | null, now: Date): boolean {
  if (!lastRecordedAt) return true;
  const last = Date.parse(lastRecordedAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= MIN_PING_INTERVAL_SECONDS * 1000;
}

/** ¿Toca guardar una muestra en el historial? */
export function historyDue(historyAt: string | null, now: Date): boolean {
  if (!historyAt) return true;
  const last = Date.parse(historyAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= HISTORY_INTERVAL_SECONDS * 1000;
}

/** Desde cuándo se conserva el historial de una app con esta retención. */
export function retentionCutoff(retentionDays: number, now: Date): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

export interface ConsentText {
  version: string;
  title: string;
  /** Cada punto es una pregunta que la persona se hace: qué, para qué, quién, cuánto, cómo apagarlo. */
  points: Array<{ title: string; body: string }>;
  footer: string;
}

/**
 * El texto que la persona acepta. Dice la verdad de ESTA app: quién lo ve (los
 * roles con permiso de ver, que el servidor pone), cuánto se guarda (la
 * retención de la app) y cómo apagarlo.
 */
export function consentText(input: {
  appName: string;
  retentionDays: number;
  viewerRoleNames: string[];
}): ConsentText {
  const viewers = input.viewerRoleNames.length
    ? `${input.viewerRoleNames.join(', ')} y quienes administran la empresa`
    : 'quienes administran la empresa';
  return {
    version: LOCATION_TEXT_VERSION,
    title: 'Compartir tu ubicación con el equipo',
    points: [
      {
        title: 'Qué se comparte',
        body: 'Tu posición en el mapa (latitud y longitud), qué tan precisa es y, si tu teléfono lo da, hacia dónde te mueves, a qué velocidad y cuánta batería te queda. Nada más: no se lee tu galería, tus contactos ni tus mensajes.',
      },
      {
        title: 'Cuándo',
        body: `Sólo mientras «${input.appName}» está abierta en tu teléfono y tú tienes el turno iniciado. Verás siempre el aviso «Compartiendo ubicación». Si cierras la app o terminas el turno, se deja de compartir.`,
      },
      {
        title: 'Para qué',
        body: 'Para que el equipo sepa dónde estás durante el turno y pueda asignarte tareas cercanas. No se usa para otra cosa.',
      },
      {
        title: 'Quién lo ve',
        body: `Sólo ${viewers}. Los demás usuarios de la app no ven dónde estás.`,
      },
      {
        title: 'Cuánto se guarda',
        body: `Tu última posición mientras dura el turno; al terminarlo se borra. Además se guarda un rastro corto (una muestra por minuto como máximo) durante ${input.retentionDays} día${input.retentionDays === 1 ? '' : 's'}, y luego se elimina solo.`,
      },
      {
        title: 'Cómo apagarlo',
        body: 'Cuando quieras: «Terminar turno» deja de compartir, y «Dejar de compartir mi ubicación» en el menú de la app retira tu autorización y borra tu posición y tu rastro guardado. Compartir es voluntario.',
      },
    ],
    footer:
      'Tus datos personales se tratan según la Ley 1581 de 2012: puedes conocerlos, actualizarlos, pedir que se supriman o revocar esta autorización cuando quieras. El responsable es tu empresa.',
  };
}

/** «hace 3 min», para el mapa y las tarjetas. */
export function agoSeconds(seconds: number): string {
  if (seconds < 45) return 'ahora';
  if (seconds < 90) return 'hace 1 min';
  const min = Math.round(seconds / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}
