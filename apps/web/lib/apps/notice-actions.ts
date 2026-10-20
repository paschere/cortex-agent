'use server';

import { openApp, requireAppAdmin } from '@/lib/apps/access';
import { pushEnabled } from '@/lib/apps/push';
import {
  MUTE_OPTIONS,
  type NoticeGroup,
  type NoticePrefs,
  PREF_LEVELS,
  getNoticePrefs,
  groupNotices,
  listInbox,
  markInboxRead,
  muteUntil,
  noticeConfigSchema,
  saveNoticeConfig,
  saveNoticePrefs,
  unreadByScreen,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

/**
 * LOS AVISOS DE UNA APP, DESDE EL NAVEGADOR (0231): la bandeja de quien está
 * dentro, marcar leídos, sus preferencias y —para quien administra— qué avisos
 * recibe cada rol. Todo resuelve el acceso de nuevo (`openApp`: sesión +
 * rol GUARDADO): el navegador nunca dice de quién es la bandeja.
 */

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string };

export interface FreshNotice {
  id: string;
  title: string;
  body: string;
  screen: string | null;
  rowId: string | null;
}

export interface NoticesView {
  groups: NoticeGroup[];
  /** Sin leer por pantalla (slug; «» = la de inicio). */
  byScreen: Record<string, number>;
  unread: number;
  /** Lo que llegó desde `since`, sin leer y que debe sonar: el navegador lo muestra como aviso. */
  fresh: FreshNotice[];
  prefs: NoticePrefs;
  /** El servidor tiene llaves VAPID: el push puede estar encendido. */
  pushOn: boolean;
  now: string;
}

function describe(err: unknown, fallback: string): string {
  if (err instanceof ValidationError || err instanceof NotFoundError) return err.message;
  return fallback;
}

export async function loadNoticesAction(
  appRef: string,
  since?: string | null,
): Promise<Result<{ view: NoticesView }>> {
  try {
    const opened = await openApp(z.string().trim().min(1).max(80).parse(appRef));
    if (!opened) throw new NotFoundError('Esa app no existe.');
    const now = new Date().toISOString();
    const person = {
      kind: opened.external ? ('app_user' as const) : ('member' as const),
      id: opened.actor.id,
    };
    const empty: NoticesView = {
      groups: [],
      byScreen: {},
      unread: 0,
      fresh: [],
      prefs: { level: 'all', email: false, mutedUntil: null },
      pushOn: pushEnabled(),
      now,
    };
    // «Ver como…» mira como otro rol: no hay bandeja que mostrar.
    if (opened.readOnly) return { ok: true, view: empty };
    const [list, prefs] = await Promise.all([
      listInbox(opened.db, opened.access.app.id, person),
      getNoticePrefs(opened.db, opened.access.app.id, person),
    ]);
    const sinceMs = since ? Date.parse(since) : Number.NaN;
    const fresh = Number.isFinite(sinceMs)
      ? list
          .filter((n) => !n.readAt && !n.silent && Date.parse(n.createdAt) > sinceMs)
          .slice(0, 3)
          .map((n) => ({
            id: n.id,
            title: n.title,
            body: n.body,
            screen: n.screen,
            rowId: n.rowId,
          }))
      : [];
    const byScreen = unreadByScreen(list);
    return {
      ok: true,
      view: {
        groups: groupNotices(list).slice(0, 40),
        byScreen,
        unread: Object.values(byScreen).reduce((a, b) => a + b, 0),
        fresh,
        prefs,
        pushOn: pushEnabled(),
        now,
      },
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron leer los avisos.') };
  }
}

const readInput = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }),
  z.object({ screen: z.string().max(60).nullable() }),
  z.object({ all: z.literal(true) }),
]);

export async function markNoticesReadAction(
  appRef: string,
  what: z.input<typeof readInput>,
): Promise<Result> {
  try {
    const opened = await openApp(z.string().trim().min(1).max(80).parse(appRef));
    if (!opened) throw new NotFoundError('Esa app no existe.');
    if (opened.readOnly) return { ok: true };
    await markInboxRead(
      opened.db,
      opened.access.app.id,
      { kind: opened.external ? 'app_user' : 'member', id: opened.actor.id },
      readInput.parse(what),
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo marcar como leído.') };
  }
}

const prefsInput = z.object({
  level: z.enum(PREF_LEVELS).optional(),
  email: z.boolean().optional(),
  mute: z.enum(MUTE_OPTIONS).optional(),
});

export async function setNoticePrefsAction(
  appRef: string,
  raw: z.input<typeof prefsInput>,
): Promise<Result<{ prefs: NoticePrefs }>> {
  try {
    const opened = await openApp(z.string().trim().min(1).max(80).parse(appRef));
    if (!opened) throw new NotFoundError('Esa app no existe.');
    if (opened.readOnly)
      throw new ValidationError('En «Ver como…» no se cambian las preferencias.');
    const input = prefsInput.parse(raw);
    const person = {
      kind: opened.external ? ('app_user' as const) : ('member' as const),
      id: opened.actor.id,
    };
    const current = await getNoticePrefs(opened.db, opened.access.app.id, person);
    const next: NoticePrefs = {
      level: input.level ?? current.level,
      email: input.email ?? current.email,
      mutedUntil: input.mute ? muteUntil(input.mute) : current.mutedUntil,
    };
    await saveNoticePrefs(opened.db, opened.access.app.id, person, next);
    return { ok: true, prefs: next };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron guardar tus preferencias.') };
  }
}

/** Editor: qué avisos recibe cada rol (sólo quien administra la empresa). */
export async function saveNoticeConfigAction(appRef: string, raw: unknown): Promise<Result> {
  try {
    const { db, user, access } = await requireAppAdmin(
      z.string().trim().min(1).max(80).parse(appRef),
    );
    const parsed = noticeConfigSchema.safeParse(raw);
    if (!parsed.success) throw new ValidationError('Esa configuración de avisos no es válida.');
    await saveNoticeConfig(db, access.app.id, parsed.data, user.id);
    revalidatePath(`/apps/${access.app.slug}/edit`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudieron guardar los avisos.') };
  }
}
