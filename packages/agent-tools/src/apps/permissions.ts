import { z } from 'zod';
import type { ViewRow } from '../views/compute';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID, type ViewSpec, trackersOf } from '../views/spec';

/**
 * LOS PERMISOS DE UNA APLICACIÓN, EN PURO (migración 0208).
 *
 * Nada de aquí toca la base: recibe el rol guardado y quien mira, y contesta
 * qué pantallas ve, qué filas de cada tabla, qué campos escribe y qué botones
 * usa. Todo lo que decide el servidor sobre una app pasa por estas funciones
 * (apps/store.ts las llama antes de leer y antes de escribir), y por eso se
 * prueban solas en permissions.test.ts: una regla que vive en una función
 * pura se puede probar con los veinte casos que importan sin levantar nada.
 *
 * NEGAR POR DEFECTO. Una tabla que el rol no nombra en `tables` no se lee
 * (`access: 'none'`): sus bloques salen como aviso. Es al revés de las vistas
 * —donde quien está en el espacio ve todo— porque una app es la primera
 * pantalla que un operario o un cliente abre sin ser «del equipo».
 *
 * EL ADMINISTRADOR. Quien es owner o admin de la empresa entra a cualquier
 * app con el rol virtual `administrador`: todas las pantallas, todas las
 * filas, todos los botones, exportar. No se guarda en `custom_app_roles`: no
 * se puede quitar ni recortar desde el editor, que es el punto.
 */

export const ADMIN_ROLE_KEY = 'administrador';
export const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,31}$/;
export const USER_ATTRIBUTE_RE = /^\$user\.([a-z][a-z0-9_]{0,39})$/;

export const rowReadSchema = z.union([
  z.literal('all'),
  z.literal('own'),
  z.object({
    field: z.string().trim().min(1).max(40),
    equals: z.string().regex(USER_ATTRIBUTE_RE, 'Debe ser $user.<atributo>'),
  }),
]);
export type RowRead = z.infer<typeof rowReadSchema>;

export const tablePermissionSchema = z.object({
  read: rowReadSchema.default('all'),
  create: z.boolean().default(false),
  edit: z.enum(['none', 'own', 'all']).default('none'),
  /** Campos que puede escribir (crear y editar). Sin lista = los del bloque. */
  fields: z.array(z.string().trim().min(1).max(40)).max(60).optional(),
  /** Ids de botones del spec; `__approve` y `__reject` para la aprobación. */
  actions: z.array(z.string().trim().min(1).max(40)).max(40).default([]),
});
export type TablePermission = z.infer<typeof tablePermissionSchema>;

export const appPermissionsSchema = z.object({
  tables: z.record(z.string().trim().min(1).max(60), tablePermissionSchema).default({}),
  export: z.boolean().default(false),
});
export type AppPermissions = z.infer<typeof appPermissionsSchema>;

export const roleKeySchema = z.string().trim().regex(ROLE_KEY_RE);

/** Quien mira la app, ya resuelto por el servidor (nunca por lo que mande el navegador). */
export interface AppUser {
  id: string;
  name: string;
  /** Los atributos de su fila en `custom_app_members` o `custom_app_users` ({cliente: "Andina"}). */
  attributes: Record<string, string>;
  /**
   * True para un usuario externo de la app (0209, sin cuenta de Cortex): su
   * «own» es `created_by_app_user`, no `created_by`. Un miembro: omitido/false.
   */
  external?: boolean;
}

/** El rol resuelto: la clave, el nombre y los permisos ya validados. */
export interface ResolvedRole {
  key: string;
  name: string;
  permissions: AppPermissions;
  /** True para el owner/admin de la empresa: no sale de `custom_app_roles`. */
  admin: boolean;
}

export function adminRole(): ResolvedRole {
  return {
    key: ADMIN_ROLE_KEY,
    name: 'Administrador',
    permissions: { tables: {}, export: true },
    admin: true,
  };
}

/** Los permisos tal como vinieron de la base: lo que no pasa el contrato se niega. */
export function parsePermissions(raw: unknown): AppPermissions {
  const parsed = appPermissionsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { tables: {}, export: false };
}

// ---------------------------------------------------------------------------
// Pantallas
// ---------------------------------------------------------------------------

/**
 * ¿Este rol ve esta pantalla? `roles` es la lista de la pantalla (vacía = la
 * ven todos los roles de la app). El administrador las ve todas.
 */
export function canSeeScreen(role: ResolvedRole, screenRoles: readonly string[]): boolean {
  if (role.admin) return true;
  return screenRoles.length === 0 || screenRoles.includes(role.key);
}

// ---------------------------------------------------------------------------
// Filas
// ---------------------------------------------------------------------------

/**
 * Lo que una fuente deja ver a quien mira, ya resuelto con sus atributos:
 *   - `all`: todas las filas;
 *   - `own`: las que creó (`created_by = userId`);
 *   - `equals`: las que tienen `field = value` (el atributo del usuario; si no
 *     lo tiene, `value` es null y no ve ninguna);
 *   - `none`: la fuente no se lee.
 */
export type RowAccess =
  | { kind: 'all' }
  | { kind: 'own'; userId: string; external?: boolean }
  | { kind: 'equals'; field: string; value: string | null }
  | { kind: 'none' };

export interface RowScope {
  tracker: string;
  access: RowAccess;
}

export function rowAccessFor(role: ResolvedRole, user: AppUser, tracker: string): RowAccess {
  if (role.admin) return { kind: 'all' };
  const perm = role.permissions.tables[tracker];
  if (!perm) return { kind: 'none' };
  if (perm.read === 'all') return { kind: 'all' };
  if (perm.read === 'own')
    return user.external
      ? { kind: 'own', userId: user.id, external: true }
      : { kind: 'own', userId: user.id };
  const attr = USER_ATTRIBUTE_RE.exec(perm.read.equals)?.[1] ?? '';
  const value = user.attributes[attr];
  return {
    kind: 'equals',
    field: perm.read.field,
    value: typeof value === 'string' && value.trim() ? value.trim() : null,
  };
}

/**
 * El scope de TODAS las fuentes que un spec nombra, para `loadViewSources`.
 * Siempre completo: una fuente sin entrada se lee entera, así que la lista
 * lleva una entrada por fuente aunque sea `none`.
 */
export function rowScopeFor(role: ResolvedRole, user: AppUser, spec: ViewSpec): RowScope[] {
  return trackersOf(spec).map((tracker) => ({
    tracker,
    access: rowAccessFor(role, user, tracker),
  }));
}

/** ¿Esta fila pasa el scope? Es la misma regla que filtra la lectura. */
export function rowVisible(
  access: RowAccess,
  row: Pick<ViewRow, 'values' | 'created_by' | 'created_by_app_user'>,
): boolean {
  switch (access.kind) {
    case 'all':
      return true;
    case 'none':
      return false;
    case 'own':
      // Dos mundos que no se mezclan: la fila de un miembro lleva `created_by`,
      // la de un externo `created_by_app_user`. Un uuid de uno nunca vale por el otro.
      return access.external
        ? row.created_by_app_user === access.userId
        : row.created_by === access.userId;
    case 'equals':
      return access.value !== null && String(row.values[access.field] ?? '') === access.value;
  }
}

export function applyRowScope<
  R extends Pick<ViewRow, 'values' | 'created_by' | 'created_by_app_user'>,
>(rows: R[], access: RowAccess): R[] {
  if (access.kind === 'all') return rows;
  if (access.kind === 'none') return [];
  return rows.filter((r) => rowVisible(access, r));
}

/** ¿Esta fila la creó quien mira? (el «own» de las ediciones, miembro o externo). */
export function isOwnRow(
  user: Pick<AppUser, 'id' | 'external'>,
  row: Pick<ViewRow, 'created_by' | 'created_by_app_user'>,
): boolean {
  return user.external ? row.created_by_app_user === user.id : row.created_by === user.id;
}

export const SCOPE_BLOCKED_MESSAGE = 'Tu rol en esta aplicación no ve esta tabla.';

// ---------------------------------------------------------------------------
// Escrituras
// ---------------------------------------------------------------------------

export function canCreateIn(role: ResolvedRole, tracker: string): boolean {
  if (role.admin) return true;
  return role.permissions.tables[tracker]?.create === true;
}

/** `none`, `own` o `all`; el administrador edita todo. */
export function editAccessFor(role: ResolvedRole, tracker: string): 'none' | 'own' | 'all' {
  if (role.admin) return 'all';
  return role.permissions.tables[tracker]?.edit ?? 'none';
}

/**
 * Los campos que el rol puede escribir en esta tabla, o null si no limita
 * (vale la lista del bloque). Es una lista blanca que se cruza con la del
 * bloque: nunca amplía lo que el formulario pide.
 */
export function writableFieldsFor(role: ResolvedRole, tracker: string): ReadonlySet<string> | null {
  if (role.admin) return null;
  const fields = role.permissions.tables[tracker]?.fields;
  return fields ? new Set(fields) : null;
}

/** Las claves que llegan y el rol no deja escribir. Vacío = todo permitido. */
export function fieldsOutside(
  role: ResolvedRole,
  tracker: string,
  keys: readonly string[],
): string[] {
  const allowed = writableFieldsFor(role, tracker);
  if (!allowed) return [];
  return keys.filter((k) => !allowed.has(k));
}

export function canRunAction(role: ResolvedRole, tracker: string, actionId: string): boolean {
  if (role.admin) return true;
  return role.permissions.tables[tracker]?.actions.includes(actionId) ?? false;
}

export function canApprove(role: ResolvedRole, tracker: string): boolean {
  return (
    canRunAction(role, tracker, APPROVE_ACTION_ID) && canRunAction(role, tracker, REJECT_ACTION_ID)
  );
}

export function canExport(role: ResolvedRole): boolean {
  return role.admin || role.permissions.export;
}

// ---------------------------------------------------------------------------
// En lenguaje simple (el editor y «Ver como…»)
// ---------------------------------------------------------------------------

/** «Ve sólo lo suyo», «Ve las filas donde Cliente = su cliente», «Ve todo». */
export function describeRead(read: RowRead, fieldLabel?: string): string {
  if (read === 'all') return 'Ve todas las filas';
  if (read === 'own') return 'Ve sólo lo que registró';
  const attr = USER_ATTRIBUTE_RE.exec(read.equals)?.[1] ?? read.equals;
  return `Ve las filas donde «${fieldLabel ?? read.field}» es su ${attr}`;
}

export function describeEdit(edit: TablePermission['edit']): string {
  if (edit === 'none') return 'No edita';
  if (edit === 'own') return 'Edita sólo lo suyo';
  return 'Edita todo';
}

export const APPROVAL_ACTION_IDS: readonly string[] = [APPROVE_ACTION_ID, REJECT_ACTION_ID];
