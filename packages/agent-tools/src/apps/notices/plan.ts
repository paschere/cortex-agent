import {
  type AppUser,
  type ResolvedRole,
  isOwnRow,
  rowAccessFor,
  rowVisible,
} from '../permissions';
import {
  type NoticeAppModel,
  type RoleTableInterest,
  approvalOfTracker,
  assigneeFields,
  interestsFor,
  resolveRoleNotices,
} from './interest';
import {
  DEFAULT_PREFS,
  type AppNoticeKind,
  type NoticePersonKind,
  type NoticePrefs,
  type PersonKey,
  levelAllows,
  personKey,
} from './shape';

/**
 * QUIÉN RECIBE QUÉ CUANDO UNA FILA SE CREA O CAMBIA, en puro (0231).
 *
 * Recibe la app (pantallas, roles, lo configurado), la tabla, el suceso, quién
 * creó la fila y las personas de la app; devuelve los avisos a guardar. Sin
 * base, sin reloj y sin red: se prueba con casos escritos a mano, y por eso la
 * regla que importa —no avisar a quien no puede ver la fila— vive en UN lugar.
 *
 * Reglas:
 *  1. Nunca a quien hizo el cambio.
 *  2. Sólo a quien PUEDE VER esa fila con el scope de su rol (`read: own`,
 *     por atributo, «mis tareas»): el aviso no es una fuga.
 *  3. Una persona recibe UN aviso por suceso, el más importante:
 *     asignado > por aprobar > cambió algo suyo > nuevo.
 *  4. Se respeta lo que cada persona eligió (todo / sólo lo mío / nada).
 *  5. Idempotencia: la clave de cada aviso lleva app, tipo, fila, versión del
 *     suceso y persona; el mismo suceso emitido dos veces deja uno.
 */

export interface NoticePerson {
  kind: NoticePersonKind;
  id: string;
  name: string;
  email: string | null;
  roleKey: string;
  attributes: Record<string, string>;
}

export interface NoticeTracker {
  id: string;
  slug: string;
  name: string;
  fields: Array<{ key: string; label: string; type: string; options?: string[] }>;
}

export interface NoticeEvent {
  kind: 'row_created' | 'row_updated';
  rowId: string;
  before: Record<string, string | number> | null;
  after: Record<string, string | number>;
  label: string;
  /** Identifica ESTA versión del suceso (la hora de la escritura). */
  version: string;
  actor: { kind: 'member' | 'app_user' | 'system' | 'automation'; id?: string | null };
  actorName?: string;
}

export interface RowNoticeInput {
  created_by: string | null;
  created_by_app_user: string | null;
}

export interface PlannedNotice {
  person: NoticePerson;
  kind: AppNoticeKind;
  title: string;
  body: string;
  /** Pantalla que abre el aviso (slug); null = la de inicio. */
  screen: string | null;
  rowId: string;
  trackerId: string;
  trackerName: string;
  actorName: string;
  dedupeKey: string;
}

export interface PlanInput {
  app: NoticeAppModel;
  tracker: NoticeTracker;
  event: NoticeEvent;
  row: RowNoticeInput;
  people: readonly NoticePerson[];
  prefs: ReadonlyMap<PersonKey, NoticePrefs>;
}

const show = (v: unknown, max = 60): string => {
  const s = String(v ?? '').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

function sameId(a: unknown, b: string): boolean {
  return String(a ?? '').trim().toLowerCase() === b.toLowerCase();
}

/** ¿Este suceso lo hizo esta persona? (el id de un miembro y el de un externo nunca se confunden) */
export function isActor(person: Pick<NoticePerson, 'kind' | 'id'>, actor: NoticeEvent['actor']): boolean {
  return actor.kind === person.kind && Boolean(actor.id) && actor.id === person.id;
}

/** Los campos de opciones que cambiaron: lo que cuenta como «cambió el estado de lo tuyo». */
export function changedSelects(
  tracker: NoticeTracker,
  before: NoticeEvent['before'],
  after: NoticeEvent['after'],
): Array<{ key: string; label: string; from: string; to: string }> {
  if (!before) return [];
  const out: Array<{ key: string; label: string; from: string; to: string }> = [];
  for (const f of tracker.fields) {
    if (f.type !== 'select') continue;
    const from = String(before[f.key] ?? '').trim();
    const to = String(after[f.key] ?? '').trim();
    if (to && from !== to) out.push({ key: f.key, label: f.label, from, to });
  }
  return out;
}

export function planNotices(input: PlanInput): PlannedNotice[] {
  const { app, tracker, event, row } = input;
  const created = event.kind === 'row_created';
  const interests = interestsFor(app, tracker.slug);
  const byRole = new Map<string, RoleTableInterest>(interests.map((i) => [i.roleKey, i]));
  const roles = new Map(app.roles.map((r) => [r.key, r]));
  const assignFields = assigneeFields(app.screens, app.roles, tracker.slug, tracker.fields);
  const approval = approvalOfTracker(app.screens, tracker.slug);
  const label = show(event.label || tracker.name, 80);
  const actorName = event.actorName ?? '';
  const selects = created ? [] : changedSelects(tracker, event.before, event.after);
  const out: PlannedNotice[] = [];

  for (const person of input.people) {
    if (isActor(person, event.actor)) continue;
    const role = roles.get(person.roleKey);
    if (!role) continue;
    const perm = role.permissions.tables[tracker.slug];
    if (!perm) continue;
    const prefs = input.prefs.get(personKey(person.kind, person.id)) ?? DEFAULT_PREFS;
    if (prefs.level === 'none') continue;

    // Regla 2: sólo si ve esta fila.
    const resolved: ResolvedRole = { ...role, admin: false };
    const user: AppUser = {
      id: person.id,
      name: person.name,
      attributes: person.attributes,
      external: person.kind === 'app_user',
    };
    const visible = rowVisible(rowAccessFor(resolved, user, tracker.slug), {
      values: event.after,
      created_by: row.created_by,
      created_by_app_user: row.created_by_app_user,
    });
    if (!visible) continue;

    const interest = byRole.get(role.key) ?? null;
    const settings = resolveRoleNotices(role, interest, app.config.roles[role.key], tracker.slug);
    const screen = interest?.screens[0]?.slug ?? null;
    const key = (kind: AppNoticeKind) =>
      [app.id, kind, event.rowId, event.version, personKey(person.kind, person.id)].join(':');
    const make = (kind: AppNoticeKind, title: string, body: string, at: string | null) => ({
      person,
      kind,
      title: title.slice(0, 140),
      body: body.slice(0, 300),
      screen: at,
      rowId: event.rowId,
      trackerId: tracker.id,
      trackerName: tracker.name,
      actorName,
      dedupeKey: key(kind),
    });

    // Prioridad: asignado > por aprobar > cambió algo suyo > nuevo.
    let planned: PlannedNotice | null = null;

    if (
      settings.assigned &&
      assignFields.some(
        (f) =>
          sameId(event.after[f], person.id) &&
          (created || String(event.before?.[f] ?? '') !== String(event.after[f] ?? '')),
      )
    )
      planned = make(
        'assigned',
        `Se te asignó: ${label}`,
        `${actorName ? `${actorName} te lo asignó` : 'Te lo asignaron'} en «${app.name}».`,
        screen,
      );

    if (
      !planned &&
      settings.approval &&
      approval &&
      interest?.approves &&
      event.after[approval.approval.field] === approval.approval.pending &&
      (created || event.before?.[approval.approval.field] !== approval.approval.pending)
    )
      planned = make(
        'approval',
        `Pendiente de tu aprobación: ${label}`,
        `${actorName ? `${actorName} lo registró en` : 'Llegó a'} «${tracker.name}».`,
        interest.approvalScreen,
      );

    if (
      !planned &&
      !created &&
      settings.changed &&
      selects.length &&
      isOwnRow({ id: person.id, external: person.kind === 'app_user' }, row)
    ) {
      const first = selects[0] as (typeof selects)[number];
      planned = make(
        'changed',
        `Cambió ${first.label.toLowerCase()} de «${label}»`,
        `${first.label}: ${first.from || 'sin dato'} → ${first.to}${selects.length > 1 ? ` (y ${selects.length - 1} cambio${selects.length > 2 ? 's' : ''} más)` : ''}.`,
        screen,
      );
    }

    if (!planned && created && settings.new && interest)
      planned = make(
        'new',
        `Nuevo en ${interest.screens[0]?.title ?? tracker.name}`,
        `${label}${actorName ? ` · ${actorName}` : ''}`,
        screen,
      );

    if (planned && levelAllows(prefs.level, planned.kind)) out.push(planned);
  }
  return out;
}
