import type { SupabaseClient } from '@supabase/supabase-js';
import { todayIn } from '../views/compute';
import { type AppAccess, type CustomAppRow, actorKindOf, listScreens } from './store';

/**
 * USO DE UNA APP (migración 0225): quién la usa, qué hace y dónde se queda.
 *
 * Todo se calcula de lo que YA existe más tres eventos mínimos que la app
 * escribe (`custom_app_events`): abrir una pantalla, empezar un formulario y
 * enviarlo. Sin contenido de filas, sin ubicación, sin lo que escribió nadie:
 * sólo «quién (id) hizo qué en qué pantalla y cuándo».
 *
 *   - usuarios activos en 7 y 30 días, y por rol: quien abrió una pantalla,
 *     envió un formulario, editó una fila o tuvo sesión externa en la ventana;
 *   - registros creados por día (envíos de formularios de la app);
 *   - pantallas más usadas (aperturas y personas distintas);
 *   - tiempo mediano para completar un formulario, SÓLO si hay pares
 *     «empezó/envió» con el mismo `ref`; si no se mide, no se inventa;
 *   - abandonos: formularios empezados que nunca se enviaron (mismo `ref`),
 *     SÓLO si la app registra el «empezó»;
 *   - por rol: activos, envíos y aperturas.
 *
 * `computeUsage` es una función pura (se prueba con eventos en la mano);
 * `loadUsage` es la única que lee la base.
 */

export const USAGE_DAYS = 30;
const MAX_EVENTS = 20000;
/** Un formulario empezado cuenta como abandonado sólo si pasaron al menos 30 min sin enviarse (sigue «en curso» antes). */
export const ABANDON_AFTER_MS = 30 * 60_000;

export type UsageEventKind = 'screen_open' | 'form_start' | 'form_submit';

export interface UsageEvent {
  kind: UsageEventKind;
  screen: string | null;
  blockId: string | null;
  actorId: string | null;
  roleKey: string | null;
  ref: string | null;
  at: string;
}

export interface UsageInput {
  now: Date;
  events: UsageEvent[];
  /** Envíos de formularios de las pantallas de la app (custom_view_submissions). */
  submissions: Array<{ actorId: string | null; at: string; viewId: string }>;
  /** Ediciones de filas y botones usados (custom_view_events). */
  edits: Array<{ actorId: string | null; at: string }>;
  /** Último uso de usuarios externos (sesiones y custom_app_users.last_seen_at). */
  externalSeen: Array<{ actorId: string; at: string }>;
  /** actor → rol de la app. Quien no esté aquí cuenta como «Administrador». */
  roleOf: Map<string, string>;
  roleNames: Map<string, string>;
  screens: Array<{ slug: string; title: string; viewId: string }>;
}

export interface UsageRoleRow {
  roleKey: string;
  name: string;
  active7: number;
  active30: number;
  submissions: number;
  opens: number;
}

export interface UsageStats {
  windowDays: number;
  generatedAt: string;
  active: { d7: number; d30: number };
  byRole: UsageRoleRow[];
  /** Registros creados por día, los últimos `windowDays` (con los días sin nada en cero). */
  created: { daily: Array<{ date: string; value: number }>; total: number };
  topScreens: Array<{ slug: string; title: string; opens: number; people: number }>;
  /** Mediana de «empezó → envió» en segundos; null si no hay pares medidos. */
  medianSeconds: number | null;
  /** Cuántos pares sostienen la mediana. */
  measured: number;
  /** null = la app no registra «empezó» (no se puede hablar de abandonos). */
  dropoffs: {
    started: number;
    sent: number;
    abandoned: number;
    inProgress: number;
    rate: number;
    byForm: Array<{ screen: string; title: string; started: number; abandoned: number }>;
  } | null;
  /** Hay algo medido en la ventana (para el estado vacío). */
  hasData: boolean;
}

function dayOf(iso: string): string {
  return todayIn(new Date(iso));
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

const ADMIN_KEY = 'administrador';

export function computeUsage(input: UsageInput): UsageStats {
  const now = input.now.getTime();
  const since30 = now - USAGE_DAYS * 86_400_000;
  const since7 = now - 7 * 86_400_000;
  const within = (iso: string, since: number) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= since && t <= now + 60_000;
  };
  const roleKeyOf = (actor: string | null, eventRole?: string | null) =>
    actor ? (input.roleOf.get(actor) ?? eventRole ?? ADMIN_KEY) : null;

  // Actividad por persona: la última marca de cualquier tipo.
  const lastSeen = new Map<string, number>();
  const bump = (actor: string | null, iso: string) => {
    if (!actor) return;
    const t = Date.parse(iso);
    if (!Number.isFinite(t) || t < since30 || t > now + 60_000) return;
    if (t > (lastSeen.get(actor) ?? 0)) lastSeen.set(actor, t);
  };
  for (const e of input.events) bump(e.actorId, e.at);
  for (const s of input.submissions) bump(s.actorId, s.at);
  for (const e of input.edits) bump(e.actorId, e.at);
  for (const e of input.externalSeen) bump(e.actorId, e.at);

  const active7 = new Set([...lastSeen].filter(([, t]) => t >= since7).map(([a]) => a));
  const active30 = new Set(lastSeen.keys());

  // Por rol.
  const roles = new Map<string, UsageRoleRow>();
  const roleRow = (key: string): UsageRoleRow => {
    const hit = roles.get(key);
    if (hit) return hit;
    const row: UsageRoleRow = {
      roleKey: key,
      name: key === ADMIN_KEY ? 'Administrador' : (input.roleNames.get(key) ?? key),
      active7: 0,
      active30: 0,
      submissions: 0,
      opens: 0,
    };
    roles.set(key, row);
    return row;
  };
  for (const actor of active30) roleRow(roleKeyOf(actor) as string).active30 += 1;
  for (const actor of active7) roleRow(roleKeyOf(actor) as string).active7 += 1;
  for (const s of input.submissions) {
    if (!within(s.at, since30)) continue;
    const key = roleKeyOf(s.actorId);
    if (key) roleRow(key).submissions += 1;
  }

  // Registros por día.
  const today = todayIn(input.now);
  const days = Array.from({ length: USAGE_DAYS }, (_, i) => addDays(today, i - (USAGE_DAYS - 1)));
  const perDay = new Map(days.map((d) => [d, 0]));
  let total = 0;
  for (const s of input.submissions) {
    if (!within(s.at, since30)) continue;
    const d = dayOf(s.at);
    if (perDay.has(d)) {
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
      total += 1;
    }
  }

  // Pantallas.
  const titleOf = new Map(input.screens.map((s) => [s.slug, s.title]));
  const opens = new Map<string, { opens: number; people: Set<string> }>();
  for (const e of input.events) {
    if (e.kind !== 'screen_open' || !e.screen || !within(e.at, since30)) continue;
    const row = opens.get(e.screen) ?? { opens: 0, people: new Set<string>() };
    row.opens += 1;
    if (e.actorId) row.people.add(e.actorId);
    opens.set(e.screen, row);
    const key = roleKeyOf(e.actorId, e.roleKey);
    if (key) roleRow(key).opens += 1;
  }
  const topScreens = [...opens.entries()]
    .map(([slug, v]) => ({
      slug,
      title: titleOf.get(slug) ?? slug,
      opens: v.opens,
      people: v.people.size,
    }))
    .sort((a, b) => b.opens - a.opens || a.title.localeCompare(b.title, 'es'))
    .slice(0, 8);

  // Formularios: pares empezó/envió por `ref`.
  const starts = new Map<string, UsageEvent>();
  const sends = new Map<string, UsageEvent>();
  for (const e of input.events) {
    if (!e.ref || !within(e.at, since30)) continue;
    if (e.kind === 'form_start' && !starts.has(e.ref)) starts.set(e.ref, e);
    if (e.kind === 'form_submit' && !sends.has(e.ref)) sends.set(e.ref, e);
  }
  const durations: number[] = [];
  for (const [ref, s] of starts) {
    const sent = sends.get(ref);
    if (!sent) continue;
    const secs = (Date.parse(sent.at) - Date.parse(s.at)) / 1000;
    // Un par con el envío ANTES del inicio, o de más de 2 horas (se dejó abierto), no mide nada.
    if (secs >= 0 && secs <= 7200) durations.push(secs);
  }
  const medianSeconds = medianOf(durations);
  let dropoffs: UsageStats['dropoffs'] = null;
  if (starts.size > 0) {
    let sent = 0;
    let abandoned = 0;
    let inProgress = 0;
    const byForm = new Map<string, { started: number; abandoned: number }>();
    for (const [ref, s] of starts) {
      const row = byForm.get(s.screen ?? '—') ?? { started: 0, abandoned: 0 };
      row.started += 1;
      if (sends.has(ref)) sent += 1;
      else if (now - Date.parse(s.at) >= ABANDON_AFTER_MS) {
        abandoned += 1;
        row.abandoned += 1;
      } else inProgress += 1;
      byForm.set(s.screen ?? '—', row);
    }
    const closed = sent + abandoned;
    dropoffs = {
      started: starts.size,
      sent,
      abandoned,
      inProgress,
      rate: closed > 0 ? abandoned / closed : 0,
      byForm: [...byForm.entries()]
        .map(([screen, v]) => ({ screen, title: titleOf.get(screen) ?? screen, ...v }))
        .filter((f) => f.abandoned > 0)
        .sort((a, b) => b.abandoned - a.abandoned)
        .slice(0, 5),
    };
  }

  return {
    windowDays: USAGE_DAYS,
    generatedAt: input.now.toISOString(),
    active: { d7: active7.size, d30: active30.size },
    byRole: [...roles.values()].sort(
      (a, b) => b.active30 - a.active30 || a.name.localeCompare(b.name, 'es'),
    ),
    created: { daily: days.map((date) => ({ date, value: perDay.get(date) ?? 0 })), total },
    topScreens,
    medianSeconds,
    measured: durations.length,
    dropoffs,
    hasData: active30.size > 0 || total > 0 || opens.size > 0,
  };
}

// ---------------------------------------------------------------------------
// Lectura y registro
// ---------------------------------------------------------------------------

/** Lo que `loadUsage` lee de la base y entrega a `computeUsage`. */
export async function loadUsage(
  db: SupabaseClient,
  app: Pick<CustomAppRow, 'id'>,
  now: Date = new Date(),
): Promise<UsageStats> {
  const since = new Date(now.getTime() - USAGE_DAYS * 86_400_000).toISOString();
  const screens = (await listScreens(db, app.id)).filter((s) => s.view_id);
  const viewIds = screens.map((s) => s.view_id);
  const [events, submissions, edits, sessions, users, members, roles] = await Promise.all([
    db
      .from('custom_app_events')
      .select('kind, screen, block_id, actor_id, role_key, ref, created_at')
      .eq('app_id', app.id)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(MAX_EVENTS),
    viewIds.length
      ? db
          .from('custom_view_submissions')
          .select('view_id, submitted_by, created_at')
          .in('view_id', viewIds)
          .gte('created_at', since)
          .limit(MAX_EVENTS)
      : Promise.resolve({ data: [], error: null }),
    viewIds.length
      ? db
          .from('custom_view_events')
          .select('actor, created_at')
          .in('view_id', viewIds)
          .gte('created_at', since)
          .limit(MAX_EVENTS)
      : Promise.resolve({ data: [], error: null }),
    db
      .from('custom_app_sessions')
      .select('app_user_id, last_seen_at')
      .eq('app_id', app.id)
      .gte('last_seen_at', since)
      .limit(MAX_EVENTS),
    db.from('custom_app_users').select('id, role_key, last_seen_at').eq('app_id', app.id),
    db.from('custom_app_members').select('user_id, role_key').eq('app_id', app.id),
    db.from('custom_app_roles').select('key, name').eq('app_id', app.id),
  ]);
  // El uso es un extra: una tabla que falta (migración sin aplicar) no tumba el editor.
  const rows = <T>(r: { data: unknown; error: unknown }): T[] =>
    r.error ? [] : ((r.data as T[]) ?? []);
  const roleOf = new Map<string, string>();
  const externalSeen: UsageInput['externalSeen'] = [];
  for (const u of rows<{ id: string; role_key: string; last_seen_at: string | null }>(users)) {
    roleOf.set(u.id, u.role_key);
    if (u.last_seen_at) externalSeen.push({ actorId: u.id, at: u.last_seen_at });
  }
  for (const s of rows<{ app_user_id: string; last_seen_at: string }>(sessions))
    externalSeen.push({ actorId: s.app_user_id, at: s.last_seen_at });
  for (const m of rows<{ user_id: string; role_key: string }>(members))
    roleOf.set(m.user_id, m.role_key);
  return computeUsage({
    now,
    events: rows<{
      kind: UsageEventKind;
      screen: string | null;
      block_id: string | null;
      actor_id: string | null;
      role_key: string | null;
      ref: string | null;
      created_at: string;
    }>(events).map((e) => ({
      kind: e.kind,
      screen: e.screen,
      blockId: e.block_id,
      actorId: e.actor_id,
      roleKey: e.role_key,
      ref: e.ref,
      at: e.created_at,
    })),
    submissions: rows<{ view_id: string; submitted_by: string | null; created_at: string }>(
      submissions,
    ).map((s) => ({ viewId: s.view_id, actorId: s.submitted_by, at: s.created_at })),
    edits: rows<{ actor: string | null; created_at: string }>(edits).map((e) => ({
      actorId: e.actor,
      at: e.created_at,
    })),
    externalSeen,
    roleOf,
    roleNames: new Map(rows<{ key: string; name: string }>(roles).map((r) => [r.key, r.name])),
    screens: screens.map((s) => ({ slug: s.slug, title: s.title, viewId: s.view_id })),
  });
}

/**
 * Anota un evento de uso. Nunca lanza: medir no puede tumbar a un operario que
 * abre una pantalla o envía un formulario. Los envíos se anotan con el mismo
 * `ref` (el clientId del formulario) que el «empezó».
 */
export async function recordAppEvent(
  db: SupabaseClient,
  access: Pick<AppAccess, 'app' | 'role' | 'user'>,
  event: {
    kind: UsageEventKind;
    screen?: string | null;
    blockId?: string | null;
    ref?: string | null;
  },
): Promise<void> {
  try {
    await db.from('custom_app_events').insert({
      ...(access.app.organization_id ? { organization_id: access.app.organization_id } : {}),
      app_id: access.app.id,
      kind: event.kind,
      screen: event.screen?.slice(0, 48) ?? null,
      block_id: event.blockId?.slice(0, 40) ?? null,
      actor_id: access.user.id,
      actor_kind: actorKindOf(access as AppAccess),
      role_key: access.role.key,
      ref: event.ref?.slice(0, 80) ?? null,
    });
  } catch {
    // medir es opcional
  }
}

/** «2 min 30 s» / «45 s» para la tarjeta de tiempo mediano. */
export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} s` : `${m} min`;
}
