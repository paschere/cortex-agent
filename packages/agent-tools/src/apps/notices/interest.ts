import { type FormApproval, type ViewSpec, approvalFor } from '../../views/spec';
import {
  APPROVAL_ACTION_IDS,
  type AppPermissions,
  USER_ATTRIBUTE_RE,
  USER_ID_ATTRIBUTE,
  canSeeScreen,
} from '../permissions';
import { type NoticeConfig, type AppNoticeKind, type RoleNoticeConfig } from './shape';

/**
 * DE QUIÉN DEPENDE CADA TABLA, en puro (0231).
 *
 * Una app ya dice, sin que nadie lo escriba, qué rol necesita qué dato: sus
 * permisos nombran las tablas, sus pantallas dicen cuáles lee cada rol, el
 * formulario con aprobación dice quién aprueba y los botones de fila dicen a
 * quién se asigna. Aquí se lee todo eso y se devuelve, para UNA tabla, qué
 * roles dependen de ella y por qué. El planificador (plan.ts) lo cruza con el
 * suceso; el editor lo muestra en lenguaje simple.
 */

export interface NoticeScreenModel {
  slug: string;
  title: string;
  roles: string[];
  spec: ViewSpec;
}

export interface NoticeRoleModel {
  key: string;
  name: string;
  permissions: AppPermissions;
}

export interface NoticeAppModel {
  id: string;
  slug: string;
  name: string;
  screens: NoticeScreenModel[];
  roles: NoticeRoleModel[];
  config: NoticeConfig;
}

/** Cómo ve el rol las filas de la tabla. */
export type Sees = 'all' | 'attr' | 'self' | 'own';

export interface RoleTableInterest {
  roleKey: string;
  tracker: string;
  /** Pantallas del rol que MUESTRAN la tabla (no cuentan los formularios que sólo escriben). */
  screens: Array<{ slug: string; title: string }>;
  /** La pantalla donde se aprueba (el formulario con aprobación o un tablero con Aprobar). */
  approvalScreen: string | null;
  approves: boolean;
  buttons: boolean;
  creates: boolean;
  sees: Sees;
}

/** Los bloques que LEEN una tabla (un formulario sólo la escribe). */
export function readsTracker(spec: ViewSpec, slug: string): boolean {
  if (spec.alerts.some((a) => a.source === slug)) return true;
  return spec.blocks.some((b) => {
    if (b.type === 'form' || b.type === 'voice') return false;
    if ('tracker' in b && b.tracker === slug) return true;
    return b.type === 'detail' && b.related.some((r) => r.tracker === slug);
  });
}

/** Los campos donde una fila guarda A QUIÉN SE ASIGNÓ, por lo que la app declara. */
export function assigneeFields(
  screens: readonly NoticeScreenModel[],
  roles: readonly NoticeRoleModel[],
  slug: string,
  fields: ReadonlyArray<{ key: string; type: string }> = [],
): string[] {
  const out = new Set<string>();
  for (const s of screens) {
    for (const b of s.spec.blocks) {
      if (b.type === 'map' && b.assign && b.tracker === slug) out.add(b.assign.assigneeField);
      if ('actions' in b && 'tracker' in b && b.tracker === slug)
        for (const a of b.actions)
          if (a.kind === 'assign' && a.field) out.add(a.field);
    }
  }
  // «Mis tareas»: un rol que ve sólo las filas donde el campo es `$user.id`.
  for (const r of roles) {
    const read = r.permissions.tables[slug]?.read;
    if (read && typeof read === 'object') {
      const attr = USER_ATTRIBUTE_RE.exec(read.equals)?.[1];
      if (attr === USER_ID_ATTRIBUTE) out.add(read.field);
    }
  }
  // Un campo de texto que se llama como lo que es («asignado», «responsable»).
  for (const f of fields)
    if (f.type === 'text' && ASSIGNEE_NAME_RE.test(f.key)) out.add(f.key);
  return [...out].filter((k) => k !== 'label');
}

const ASSIGNEE_NAME_RE = /^(asignad[oa]|asignado_a|responsable|encargad[oa]|assignee|assigned_to)(_id)?$/;

/** El formulario con aprobación de la tabla, en cualquier pantalla de la app. */
export function approvalOfTracker(
  screens: readonly NoticeScreenModel[],
  slug: string,
): { approval: FormApproval; screen: string } | null {
  for (const s of screens) {
    const found = approvalFor(s.spec, slug);
    if (found) return { approval: found.approval, screen: s.slug };
  }
  return null;
}

function sees(read: AppPermissions['tables'][string]['read']): Sees {
  if (read === 'all') return 'all';
  if (read === 'own') return 'own';
  const attr = USER_ATTRIBUTE_RE.exec(read.equals)?.[1];
  return attr === USER_ID_ATTRIBUTE ? 'self' : 'attr';
}

/** Los roles que dependen de esta tabla, con la razón. Un rol sin pantalla, botón ni aprobación sobre ella no cuenta. */
export function interestsFor(app: NoticeAppModel, slug: string): RoleTableInterest[] {
  const approval = approvalOfTracker(app.screens, slug);
  const out: RoleTableInterest[] = [];
  for (const role of app.roles) {
    const perm = role.permissions.tables[slug];
    if (!perm) continue;
    const roleView = { key: role.key, name: role.name, permissions: role.permissions, admin: false };
    const visible = app.screens.filter((s) => canSeeScreen(roleView, s.roles));
    const screens = visible
      .filter((s) => readsTracker(s.spec, slug))
      .map((s) => ({ slug: s.slug, title: s.title }));
    const approves =
      Boolean(approval) && APPROVAL_ACTION_IDS.every((id) => perm.actions.includes(id));
    const buttons = perm.actions.some((id) => !APPROVAL_ACTION_IDS.includes(id));
    if (!screens.length && !approves && !buttons) continue;
    const approvalScreen =
      approves && approval && visible.some((s) => s.slug === approval.screen)
        ? approval.screen
        : (screens[0]?.slug ?? null);
    out.push({
      roleKey: role.key,
      tracker: slug,
      screens,
      approvalScreen,
      approves,
      buttons,
      creates: perm.create,
      sees: sees(perm.read),
    });
  }
  return out;
}

const SUPERVISOR_RE = /supervis|gerent|jefe|coordin|direct|admin|l[ií]der|due[nñ]o/i;

/** Un rol que mira y decide (aprueba, edita todo, exporta o se llama como tal): recibe «nuevo» aunque también registre. */
export function isSupervisorRole(role: NoticeRoleModel): boolean {
  if (SUPERVISOR_RE.test(`${role.key} ${role.name}`)) return true;
  if (role.permissions.export) return true;
  return Object.values(role.permissions.tables).some(
    (t) => t.edit === 'all' || APPROVAL_ACTION_IDS.every((id) => t.actions.includes(id)),
  );
}

export type RoleNotices = Record<AppNoticeKind, boolean> & { only: string[] | null };

/**
 * Lo que recibe un rol sobre UNA tabla: lo guardado por app manda; lo omitido
 * toma el valor por defecto. Por defecto, asignaciones, aprobaciones y cambios
 * de lo suyo siempre, y «nuevo» sólo para quien depende de filas de OTROS:
 *  - ve todas las filas (o las de su cliente / sede) y no es quien las registra,
 *  - o es supervisor (aunque también registre).
 * Un operario que sólo ve lo suyo («mis tareas», «lo que registré») no recibe
 * «nuevo»: lo suyo le llega como asignación o como cambio.
 */
export function resolveRoleNotices(
  role: NoticeRoleModel,
  interest: Pick<RoleTableInterest, 'sees' | 'creates' | 'approves'> | null,
  saved: RoleNoticeConfig | undefined,
  tracker: string,
): RoleNotices {
  const sawOthers = interest ? interest.sees === 'all' || interest.sees === 'attr' : false;
  const defaultNew = sawOthers && (!interest?.creates || isSupervisorRole(role));
  const wantsNew = saved?.new ?? defaultNew;
  const inScope = !saved?.only || saved.only.includes(tracker);
  return {
    new: wantsNew && inScope,
    assigned: saved?.assigned ?? true,
    approval: saved?.approval ?? Boolean(interest?.approves),
    changed: saved?.changed ?? true,
    only: saved?.only ?? null,
  };
}

/** Todas las tablas que alguna pantalla de la app lee, escribe o aprueba (slugs). */
export function trackersInApp(app: NoticeAppModel): string[] {
  const out = new Set<string>();
  for (const s of app.screens) {
    for (const b of s.spec.blocks) if ('tracker' in b && typeof b.tracker === 'string') out.add(b.tracker);
    for (const a of s.spec.alerts) out.add(a.source);
  }
  return [...out];
}

/**
 * Para el editor y la herramienta: por rol, qué avisos recibe (ya con los
 * valores por defecto resueltos) y de qué tablas depende.
 */
export interface RoleNoticeSummary {
  roleKey: string;
  roleName: string;
  new: boolean;
  assigned: boolean;
  approval: boolean;
  changed: boolean;
  only: string[] | null;
  /** Tablas (slug) de las que depende y por las que recibiría «nuevo»/«por aprobar». */
  depends: Array<{ tracker: string; screens: string[]; approves: boolean; sees: Sees }>;
  /** Si lo que muestra es la regla por defecto (nadie la tocó). */
  custom: boolean;
}

export function summarizeRoleNotices(app: NoticeAppModel): RoleNoticeSummary[] {
  const slugs = trackersInApp(app);
  const all = slugs.flatMap((slug) => interestsFor(app, slug));
  return app.roles.map((role) => {
    const mine = all.filter((i) => i.roleKey === role.key);
    const saved = app.config.roles[role.key];
    const perTable = mine.map((i) => resolveRoleNotices(role, i, saved, i.tracker));
    // «Nuevo» está encendido para el rol si lo está en alguna de sus tablas.
    const newOn =
      saved?.new !== undefined ? saved.new : perTable.some((n) => n.new) || false;
    return {
      roleKey: role.key,
      roleName: role.name,
      new: newOn,
      assigned: saved?.assigned ?? true,
      approval: saved?.approval ?? mine.some((i) => i.approves),
      changed: saved?.changed ?? true,
      only: saved?.only ?? null,
      depends: mine.map((i) => ({
        tracker: i.tracker,
        screens: i.screens.map((s) => s.title),
        approves: i.approves,
        sees: i.sees,
      })),
      custom: Boolean(saved && Object.keys(saved).length > 0),
    };
  });
}
