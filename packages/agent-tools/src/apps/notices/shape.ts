import { z } from 'zod';

/**
 * AVISOS AUTOMÁTICOS DE UNA APP (migración 0231): las formas, en puro.
 *
 * Nadie crea reglas: al crear o cambiar una fila, la app calcula quién DEPENDE
 * de esa tabla (la lee en una pantalla, la aprueba o tiene botones sobre ella)
 * y le avisa. Aquí viven los tipos, los textos en lenguaje simple y lo que se
 * guarda por app (qué avisos recibe cada rol) y por persona (todo / lo mío /
 * nada). Sin base ni red: lo importan el planificador, el editor y la herramienta.
 */

export const APP_NOTICE_KINDS = ['new', 'assigned', 'approval', 'changed'] as const;
export type AppNoticeKind = (typeof APP_NOTICE_KINDS)[number];

/** Cómo se llama cada tipo en el editor y en la bandeja. */
export const NOTICE_KIND_LABEL: Record<AppNoticeKind, string> = {
  new: 'Algo nuevo en una tabla que usa',
  assigned: 'Se le asigna un registro',
  approval: 'Algo pendiente de su aprobación',
  changed: 'Cambia el estado de un registro suyo',
};

export const NOTICE_KIND_SHORT: Record<AppNoticeKind, string> = {
  new: 'Nuevos',
  assigned: 'Asignaciones',
  approval: 'Por aprobar',
  changed: 'Cambios en lo suyo',
};

const slug = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,47}$/);

/**
 * Lo que un rol recibe. Cada tipo es `true` / `false`; omitido = el valor por
 * defecto que calcula `resolveRoleNotices` (asignaciones, aprobaciones y cambios
 * de lo suyo siempre; «nuevo» sólo para quien depende de filas de otros).
 * `only` limita los «nuevos» a esas tablas (por slug).
 */
export const roleNoticeSchema = z.object({
  new: z.boolean().optional(),
  assigned: z.boolean().optional(),
  approval: z.boolean().optional(),
  changed: z.boolean().optional(),
  only: z.array(slug).max(30).optional(),
});
export type RoleNoticeConfig = z.infer<typeof roleNoticeSchema>;

export const noticeConfigSchema = z.object({
  roles: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,31}$/), roleNoticeSchema).default({}),
});
export type NoticeConfig = z.infer<typeof noticeConfigSchema>;

export function parseNoticeConfig(raw: unknown): NoticeConfig {
  const parsed = noticeConfigSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { roles: {} };
}

/** Lo que cada persona elige para sí. */
export const PREF_LEVELS = ['all', 'mine', 'none'] as const;
export type PrefLevel = (typeof PREF_LEVELS)[number];

export const PREF_LEVEL_LABEL: Record<PrefLevel, string> = {
  all: 'Todo lo que me toque',
  mine: 'Sólo lo mío y lo que me asignen',
  none: 'Nada',
};

export interface NoticePrefs {
  level: PrefLevel;
  /** Además del push, un correo cuando no hay push (los nuevos y cambios; asignar y aprobar ya lo mandan). */
  email: boolean;
  /** Silenciado hasta esta hora (ISO): los avisos se guardan pero no suenan ni se mandan. */
  mutedUntil: string | null;
}

export const DEFAULT_PREFS: NoticePrefs = { level: 'all', email: false, mutedUntil: null };

export function parsePrefs(raw: unknown): NoticePrefs {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const level = PREF_LEVELS.includes(r.level as PrefLevel) ? (r.level as PrefLevel) : 'all';
  const until = typeof r.mutedUntil === 'string' ? r.mutedUntil : null;
  return {
    level,
    email: r.email === true,
    mutedUntil: until && Number.isFinite(Date.parse(until)) ? until : null,
  };
}

export function isMuted(prefs: Pick<NoticePrefs, 'mutedUntil'>, now = Date.now()): boolean {
  return Boolean(prefs.mutedUntil) && Date.parse(prefs.mutedUntil as string) > now;
}

/** Los tipos que cada nivel deja pasar. */
export function levelAllows(level: PrefLevel, kind: AppNoticeKind): boolean {
  if (level === 'none') return false;
  if (level === 'mine') return kind !== 'new';
  return true;
}

/** La clave de una persona dentro de la app: «m:<id>» (miembro) o «u:<id>» (externo). */
export type PersonKey = string;
export type NoticePersonKind = 'member' | 'app_user';
export function personKey(kind: NoticePersonKind, id: string): PersonKey {
  return `${kind === 'member' ? 'm' : 'u'}:${id}`;
}

// ---------------------------------------------------------------------------
// Anti-ráfaga
// ---------------------------------------------------------------------------

/** Ventana en la que varios «nuevos» de una misma tabla se cuentan como un resumen. */
export const BURST_WINDOW_MS = 5 * 60_000;
/** Cuántos de un mismo grupo suenan uno por uno antes de pasar al resumen. */
export const BURST_SINGLE = 3;
/** Tope de filas de bandeja por persona y grupo dentro de la ventana (lo demás sólo suma al resumen). */
export const BURST_ROW_CAP = 60;

export type BurstMode = 'single' | 'summary' | 'silent';

/**
 * Cómo suena el aviso número `n` (1, 2, 3…) de un grupo (persona + tabla +
 * tipo) dentro de la ventana. Asignar y aprobar nunca se agrupan: son para
 * ESA persona y ESE registro. Los primeros llegan uno por uno, el siguiente
 * es el resumen («5 nuevos en Atenciones») y los que siguen no suenan otra vez.
 */
export function burstMode(kind: AppNoticeKind, n: number): BurstMode {
  if (kind === 'assigned' || kind === 'approval') return 'single';
  if (n <= BURST_SINGLE) return 'single';
  return n === BURST_SINGLE + 1 ? 'summary' : 'silent';
}

export interface InboxNotice {
  id: string;
  kind: AppNoticeKind;
  title: string;
  body: string;
  screen: string | null;
  rowId: string | null;
  trackerName: string;
  trackerId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface NoticeGroup {
  /** Ids de la bandeja que cubre (para marcarlos leídos juntos). */
  ids: string[];
  kind: AppNoticeKind;
  title: string;
  body: string;
  screen: string | null;
  /** La fila a abrir cuando es un solo aviso. */
  rowId: string | null;
  count: number;
  createdAt: string;
  unread: boolean;
}

/**
 * La bandeja agrupada: varios «nuevos» (o «cambios») de la misma tabla que
 * llegaron juntos, dentro de la ventana, se muestran como UNO («5 nuevos en
 * Atenciones»). Asignaciones y aprobaciones nunca se juntan. Recibe la lista
 * de más nuevo a más viejo y devuelve el mismo orden.
 */
export function groupNotices(list: readonly InboxNotice[]): NoticeGroup[] {
  const out: NoticeGroup[] = [];
  const open = new Map<string, { group: NoticeGroup; oldest: number }>();
  for (const n of list) {
    const t = Date.parse(n.createdAt);
    const single = n.kind === 'assigned' || n.kind === 'approval';
    const key = `${n.kind}:${n.trackerId ?? n.trackerName}:${n.screen ?? ''}:${n.readAt ? 'r' : 'u'}`;
    const hit = single ? undefined : open.get(key);
    if (hit && hit.oldest - t <= BURST_WINDOW_MS) {
      hit.group.ids.push(n.id);
      hit.group.count += 1;
      hit.oldest = t;
      hit.group.rowId = null;
      hit.group.title = groupTitle(n.kind, hit.group.count, n.trackerName);
      hit.group.body = '';
      continue;
    }
    const group: NoticeGroup = {
      ids: [n.id],
      kind: n.kind,
      title: n.title,
      body: n.body,
      screen: n.screen,
      rowId: n.rowId,
      count: 1,
      createdAt: n.createdAt,
      unread: !n.readAt,
    };
    out.push(group);
    if (!single) open.set(key, { group, oldest: t });
  }
  return out;
}

export function groupTitle(kind: AppNoticeKind, count: number, trackerName: string): string {
  const where = trackerName || 'la app';
  if (kind === 'changed') return `${count} cambios en tus registros de ${where}`;
  if (kind === 'new') return `${count} nuevos en ${where}`;
  return `${count} avisos en ${where}`;
}

/** «3 nuevos» por pantalla: cuántos avisos sin leer apuntan a cada una. */
export function unreadByScreen(
  list: ReadonlyArray<Pick<InboxNotice, 'screen' | 'readAt'>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of list) {
    if (n.readAt) continue;
    const key = n.screen ?? '';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Silenciar
// ---------------------------------------------------------------------------

export const MUTE_OPTIONS = ['1h', '8h', 'tomorrow', 'off'] as const;
export type MuteOption = (typeof MUTE_OPTIONS)[number];

export const MUTE_LABEL: Record<MuteOption, string> = {
  '1h': 'Una hora',
  '8h': 'Ocho horas',
  tomorrow: 'Hasta mañana a las 7',
  off: 'Quitar el silencio',
};

/** Hasta cuándo queda silenciado (ISO), o null para quitarlo. «Mañana a las 7» es hora de Colombia (UTC-5, sin horario de verano). */
export function muteUntil(option: MuteOption, now = Date.now()): string | null {
  if (option === 'off') return null;
  if (option === '1h') return new Date(now + 3_600_000).toISOString();
  if (option === '8h') return new Date(now + 8 * 3_600_000).toISOString();
  const bogota = new Date(now - 5 * 3_600_000);
  return new Date(
    Date.UTC(bogota.getUTCFullYear(), bogota.getUTCMonth(), bogota.getUTCDate() + 1, 7 + 5),
  ).toISOString();
}
