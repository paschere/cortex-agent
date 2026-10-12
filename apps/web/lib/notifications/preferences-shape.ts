import { NOTIFICATION_KINDS, type NotificationKind } from '@/lib/notifications-shape';

/**
 * PREFERENCIAS DE AVISOS, SIN SERVIDOR (la pantalla y las pruebas las importan).
 *
 * LO QUE SE ELIGE. Por categoría de aviso («Tu día», aprobaciones, tareas,
 * anomalías, cobros, correo, trabajo, vistas) y por canal (campana, celular,
 * correo, WhatsApp), más unas horas de silencio. Una categoría agrupa varias
 * clases de aviso: la persona no distingue «trámite que falló» de «rutina que
 * falló», las dos son «Fallos».
 *
 * LOS DEFECTOS SON EL COMPORTAMIENTO DE HOY. Sin fila guardada, todo lo que ya
 * se mandaba se sigue mandando (campana, celular y correo, según lo que cada
 * productor ya decidía enviar) y WhatsApp está apagado. Esta capa sólo RESTA:
 * nunca hace que un productor mande un canal que no mandaba.
 *
 * HORAS DE SILENCIO. Detienen el celular, el correo y WhatsApp; la campana no
 * suena, así que sigue escribiendo: al volver, el aviso está esperando. Lo que
 * sale durante el silencio no se aplaza ni se reenvía: queda en la campana.
 * Hora de Bogotá (Colombia no cambia de hora).
 */

export const NOTIFICATION_CHANNELS = ['bell', 'push', 'email', 'whatsapp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  bell: 'Campana',
  push: 'Celular',
  email: 'Correo',
  whatsapp: 'WhatsApp',
};

/**
 * ¿Existe hoy un envío de Cortex al WhatsApp de una PERSONA del equipo? No: el
 * puente (services/whatsapp) sólo entrega respuestas dentro de una conversación
 * de cliente abierta y mensajes a grupos permitidos. Mientras sea falso, el
 * canal se ve como «próximamente», se guarda lo elegido y NO se manda nada.
 */
export const WHATSAPP_MEMBER_CHANNEL_AVAILABLE = false;

export const NOTIFICATION_CATEGORIES = [
  'briefing',
  'approvals',
  'tasks',
  'anomalies',
  'receivables',
  'mail',
  'work',
  'views',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export interface CategoryInfo {
  id: NotificationCategory;
  label: string;
  description: string;
}

export const CATEGORY_INFO: CategoryInfo[] = [
  {
    id: 'briefing',
    label: 'Tu día',
    description: 'El resumen de las 7:00 con lo que merece tu atención. Si lo apagas, no se arma.',
  },
  {
    id: 'approvals',
    label: 'Aprobaciones y decisiones',
    description: 'Algo está esperando tu visto bueno, o una tarea o trámite te necesita.',
  },
  {
    id: 'tasks',
    label: 'Tareas y rutinas',
    description: 'Una tarea, rutina, trámite o informe terminó.',
  },
  {
    id: 'anomalies',
    label: 'Anomalías y fallos',
    description: 'Algo falló o necesita atención de gerencia.',
  },
  {
    id: 'receivables',
    label: 'Cobros',
    description: 'Facturas por cobrar que pasaron a vencidas o a más mora.',
  },
  {
    id: 'mail',
    label: 'Correo y menciones',
    description: 'Llegó algo que no puede esperar al resumen de mañana.',
  },
  {
    id: 'work',
    label: 'Trabajo del equipo',
    description: 'Te asignaron trabajo o tienes cosas vencidas en el registro de trabajo.',
  },
  {
    id: 'views',
    label: 'Vistas y tablas',
    description: 'Alguien usó una vista tuya o una tabla que se llena sola recibió filas.',
  },
];

export const CATEGORY_OF_KIND: Record<NotificationKind, NotificationCategory> = {
  briefing: 'briefing',
  approval_waiting: 'approvals',
  flow_needs_person: 'approvals',
  errand_asked: 'approvals',
  task_needs_you: 'approvals',
  flow_finished: 'tasks',
  routine_finished: 'tasks',
  errand_finished: 'tasks',
  action_sent: 'tasks',
  report_ready: 'tasks',
  task_finished: 'tasks',
  flow_failed: 'anomalies',
  routine_failed: 'anomalies',
  action_failed: 'anomalies',
  task_failed: 'anomalies',
  management_attention: 'anomalies',
  receivables_overdue: 'receivables',
  mail_worth_seeing: 'mail',
  work_assigned: 'work',
  work_overdue: 'work',
  view_activity: 'views',
  table_sync: 'views',
};

/** Todas las clases tienen categoría (lo comprueba una prueba contra la lista oficial). */
export function categoryOf(kind: NotificationKind): NotificationCategory {
  return CATEGORY_OF_KIND[kind];
}

export function kindsOfCategory(category: NotificationCategory): NotificationKind[] {
  return NOTIFICATION_KINDS.filter((k) => CATEGORY_OF_KIND[k] === category);
}

export type ChannelFlags = Record<NotificationChannel, boolean>;

/** Lo que pasa sin elegir nada: como siempre, y WhatsApp apagado. */
export const DEFAULT_CHANNELS: ChannelFlags = {
  bell: true,
  push: true,
  email: true,
  whatsapp: false,
};

export interface QuietHours {
  enabled: boolean;
  /** «HH:MM», hora de Bogotá. */
  start: string;
  end: string;
}

export const DEFAULT_QUIET: QuietHours = { enabled: false, start: '22:00', end: '07:00' };

export interface NotificationPreferences {
  /** Sólo las diferencias con el defecto. */
  channels: Partial<Record<NotificationCategory, Partial<ChannelFlags>>>;
  quiet: QuietHours;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  channels: {},
  quiet: DEFAULT_QUIET,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isHHMM(value: unknown): value is string {
  return typeof value === 'string' && HHMM.test(value);
}

/** Lee lo guardado sin fiarse de ello: lo desconocido se ignora, lo malformado cae al defecto. */
export function parsePreferences(
  raw: {
    channels?: unknown;
    quiet_enabled?: unknown;
    quiet_start?: unknown;
    quiet_end?: unknown;
  } | null,
): NotificationPreferences {
  if (!raw) return DEFAULT_PREFERENCES;
  const channels: NotificationPreferences['channels'] = {};
  if (raw.channels && typeof raw.channels === 'object' && !Array.isArray(raw.channels)) {
    for (const category of NOTIFICATION_CATEGORIES) {
      const entry = (raw.channels as Record<string, unknown>)[category];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const flags: Partial<ChannelFlags> = {};
      for (const channel of NOTIFICATION_CHANNELS) {
        const v = (entry as Record<string, unknown>)[channel];
        if (typeof v === 'boolean') flags[channel] = v;
      }
      if (Object.keys(flags).length) channels[category] = flags;
    }
  }
  return {
    channels,
    quiet: {
      enabled: raw.quiet_enabled === true,
      start: isHHMM(raw.quiet_start) ? raw.quiet_start : DEFAULT_QUIET.start,
      end: isHHMM(raw.quiet_end) ? raw.quiet_end : DEFAULT_QUIET.end,
    },
  };
}

/** Minutos desde la medianoche, hora de Bogotá (UTC-5 todo el año). */
export function bogotaMinutes(now: Date): number {
  const utc = now.getUTCHours() * 60 + now.getUTCMinutes();
  return (utc - 300 + 1440) % 1440;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** ¿`now` cae en las horas de silencio? Cruza la medianoche si el fin es menor que el inicio. */
export function inQuietHours(quiet: QuietHours, now: Date): boolean {
  if (!quiet.enabled) return false;
  const start = toMinutes(quiet.start);
  const end = toMinutes(quiet.end);
  if (start === end) return false;
  const t = bogotaMinutes(now);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

/** Lo elegido (o el defecto) para una categoría, sin horas de silencio ni disponibilidad. */
export function chosenChannels(
  prefs: NotificationPreferences,
  category: NotificationCategory,
): ChannelFlags {
  return { ...DEFAULT_CHANNELS, ...(prefs.channels[category] ?? {}) };
}

/**
 * Por qué canales PUEDE salir un aviso de esta clase ahora mismo. Es la única
 * regla que consultan `notify()`, el celular, el correo y «Tu día».
 *   - lo apagado por la persona, apagado;
 *   - en horas de silencio, sólo la campana;
 *   - WhatsApp, sólo si existe el envío a personas y la persona lo pidió.
 */
export function resolveChannels(
  prefs: NotificationPreferences | null | undefined,
  kind: NotificationKind,
  now: Date,
  options: { whatsappAvailable?: boolean } = {},
): ChannelFlags {
  const p = prefs ?? DEFAULT_PREFERENCES;
  const chosen = chosenChannels(p, categoryOf(kind));
  const quiet = inQuietHours(p.quiet, now);
  const whatsappAvailable = options.whatsappAvailable ?? WHATSAPP_MEMBER_CHANNEL_AVAILABLE;
  return {
    bell: chosen.bell,
    push: chosen.push && !quiet,
    email: chosen.email && !quiet,
    whatsapp: chosen.whatsapp && whatsappAvailable && !quiet,
  };
}

/** ¿Algún canal está encendido (por elección, sin contar el silencio)? Sirve para «Tu día» apagado. */
export function anyChannelChosen(
  prefs: NotificationPreferences | null | undefined,
  kind: NotificationKind,
): boolean {
  const c = chosenChannels(prefs ?? DEFAULT_PREFERENCES, categoryOf(kind));
  return c.bell || c.push || c.email || (c.whatsapp && WHATSAPP_MEMBER_CHANNEL_AVAILABLE);
}
