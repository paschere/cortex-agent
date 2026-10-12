import { z } from 'zod';
import { type ViewSpec, viewSpecSchema } from '../views/spec';
import { type AppBrand, type AppHome, parseBrand, parseHome } from './appearance';
import { type ClientPortal, parsePortal } from './client-portal';
import { type AppPermissions, parsePermissions } from './permissions';
import type { AppAccess, AppRoleRow, AppScreenRow, AppTheme, CustomAppRow } from './store';
import { type Tablero, parseTableros } from './tablero';

/**
 * VERSIONES DE UNA APP: LA FOTO Y SUS REGLAS, EN PURO (migración 0225).
 *
 * El trabajo en el editor es el BORRADOR: pantallas, roles, inicio,
 * apariencia, tableros y portal «vivos» en sus tablas. «Publicar» saca una
 * foto (`buildSnapshot`) y la guarda como la versión N. Quien usa la app
 * —miembros con rol y usuarios externos— ve la ÚLTIMA foto (`overlayAccess`
 * pinta encima del acceso la versión publicada): una pantalla a medio armar no
 * le llega a un operario hasta que alguien publique. Quien administra ve
 * siempre el borrador, que es también «Ver como…».
 *
 * Los DATOS no se versionan (filas, usuarios, miembros, ubicación…): viven
 * una sola vez y los ven todas las versiones. Una foto guarda el spec de cada
 * pantalla por valor, así que volver a una versión restaura lo que cada
 * pantalla DECÍA entonces, aunque la pantalla se haya editado o quitado.
 *
 * Todo en este archivo es puro: nada toca la base ni el navegador. Se prueba
 * en versions.test.ts con fotos escritas a mano.
 */

export const SNAPSHOT_VERSION = 1;

const screenSnap = z.object({
  slug: z.string().min(1).max(48),
  title: z.string().min(1).max(60),
  icon: z.string().max(60).default('LayoutPanelTop'),
  roles: z.array(z.string()).default([]),
  viewId: z.string().min(1),
  viewName: z.string().max(120).default(''),
  /** El spec de la vista, por valor. Se vuelve a validar al leer: un spec roto no tumba la foto. */
  spec: z.unknown(),
});

const roleSnap = z.object({
  key: z.string().min(1).max(32),
  name: z.string().min(1).max(60),
  description: z.string().max(300).default(''),
  permissions: z.unknown(),
});

export const snapshotSchema = z.object({
  v: z.literal(SNAPSHOT_VERSION),
  app: z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(500).default(''),
    icon: z.string().max(400).default('📱'),
    theme: z.unknown().optional(),
    homeScreen: z.string().nullable().default(null),
  }),
  screens: z.array(screenSnap).max(40).default([]),
  roles: z.array(roleSnap).max(40).default([]),
  home: z.unknown().optional(),
  brand: z.unknown().optional(),
  dashboards: z.unknown().optional(),
  portal: z.unknown().optional(),
});
export type RawSnapshot = z.infer<typeof snapshotSchema>;

/** Una foto ya con cada pieza validada por su contrato (lo roto se descarta pieza por pieza). */
export interface Snapshot {
  v: 1;
  app: {
    name: string;
    description: string;
    icon: string;
    theme: AppTheme;
    homeScreen: string | null;
  };
  screens: Array<{
    slug: string;
    title: string;
    icon: string;
    roles: string[];
    viewId: string;
    viewName: string;
    spec: ViewSpec;
  }>;
  roles: Array<{ key: string; name: string; description: string; permissions: AppPermissions }>;
  home: AppHome | null;
  brand: AppBrand;
  dashboards: Tablero[];
  portal: ClientPortal;
}

export interface SnapshotInput {
  app: Pick<
    CustomAppRow,
    | 'name'
    | 'description'
    | 'icon'
    | 'theme'
    | 'home_screen'
    | 'home'
    | 'brand'
    | 'dashboards'
    | 'portal'
  >;
  screens: Array<Pick<AppScreenRow, 'slug' | 'title' | 'icon' | 'roles' | 'view_id'>>;
  /** viewId → lo que la vista dice hoy. Una pantalla sin vista (archivada) no entra a la foto. */
  views: Map<string, { name: string; spec: ViewSpec }>;
  roles: Array<Pick<AppRoleRow, 'key' | 'name' | 'description' | 'permissions'>>;
}

/** La foto del borrador de hoy. */
export function buildSnapshot(input: SnapshotInput): Snapshot {
  return {
    v: SNAPSHOT_VERSION,
    app: {
      name: input.app.name,
      description: input.app.description,
      icon: input.app.icon,
      theme: input.app.theme,
      homeScreen: input.app.home_screen,
    },
    screens: input.screens.flatMap((s) => {
      const view = input.views.get(s.view_id);
      return view
        ? [
            {
              slug: s.slug,
              title: s.title,
              icon: s.icon,
              roles: [...s.roles],
              viewId: s.view_id,
              viewName: view.name,
              spec: view.spec,
            },
          ]
        : [];
    }),
    roles: input.roles.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: r.permissions,
    })),
    home: input.app.home,
    brand: input.app.brand,
    dashboards: input.app.dashboards,
    portal: input.app.portal,
  };
}

/** Lo guardado → foto validada, o null si ni la forma general cuadra. */
export function parseSnapshot(raw: unknown): Snapshot | null {
  const parsed = snapshotSchema.safeParse(raw);
  if (!parsed.success) return null;
  const s = parsed.data;
  const theme = z
    .object({
      accent: z.enum(['primary', 'emerald', 'amber', 'sky', 'rose']).optional(),
      style: z.enum(['clean', 'bold', 'dark-panel']).optional(),
    })
    .safeParse(s.app.theme ?? {});
  return {
    v: SNAPSHOT_VERSION,
    app: {
      name: s.app.name,
      description: s.app.description,
      icon: s.app.icon,
      theme: theme.success ? theme.data : {},
      homeScreen: s.app.homeScreen,
    },
    screens: s.screens.flatMap((screen) => {
      const spec = viewSpecSchema.safeParse(screen.spec);
      return spec.success
        ? [{ ...screen, icon: screen.icon || 'LayoutPanelTop', spec: spec.data }]
        : [];
    }),
    roles: s.roles.map((r) => ({
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: parsePermissions(r.permissions),
    })),
    home: parseHome(s.home),
    brand: parseBrand(s.brand),
    dashboards: parseTableros(s.dashboards),
    portal: parsePortal(s.portal),
  };
}

// ---------------------------------------------------------------------------
// Comparar
// ---------------------------------------------------------------------------

/** JSON con las llaves en orden: dos objetos iguales dan el mismo texto. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const same = (a: unknown, b: unknown) => stableStringify(a) === stableStringify(b);

export interface VersionChange {
  kind: 'added' | 'removed' | 'changed';
  area: 'app' | 'screen' | 'role' | 'home' | 'look' | 'dashboards' | 'portal';
  /** Una frase para la lista del historial. */
  text: string;
}

/** Cuántos bloques, y de qué tipos, dice un spec. */
function blocksSummary(spec: ViewSpec): string {
  const types = new Map<string, number>();
  for (const b of spec.blocks) types.set(b.type, (types.get(b.type) ?? 0) + 1);
  return [...types.entries()].map(([t, n]) => `${n} ${t}`).join(', ') || 'vacía';
}

/**
 * Qué cambió de la foto `before` a la `after`. `before` null = la primera
 * versión: todo es nuevo. Cada cambio es una frase corta y específica (no «se
 * modificaron cosas»): qué pantalla, qué rol, qué pieza.
 */
export function diffSnapshots(before: Snapshot | null, after: Snapshot): VersionChange[] {
  const out: VersionChange[] = [];
  if (!before) {
    out.push({
      kind: 'added',
      area: 'app',
      text: `Primera versión: ${after.screens.length} pantallas y ${after.roles.length} roles.`,
    });
    return out;
  }
  for (const key of ['name', 'description', 'icon'] as const)
    if (before.app[key] !== after.app[key])
      out.push({
        kind: 'changed',
        area: 'app',
        text:
          key === 'name'
            ? `Nombre: «${before.app.name}» → «${after.app.name}»`
            : key === 'description'
              ? 'Descripción cambiada'
              : 'Icono cambiado',
      });
  if (before.app.homeScreen !== after.app.homeScreen)
    out.push({
      kind: 'changed',
      area: 'app',
      text: `Pantalla de entrada: ${before.app.homeScreen ?? 'la primera'} → ${after.app.homeScreen ?? 'la primera'}`,
    });
  if (!same(before.app.theme, after.app.theme))
    out.push({ kind: 'changed', area: 'look', text: 'Estilo de la app cambiado' });

  const bScreens = new Map(before.screens.map((s) => [s.slug, s]));
  const aScreens = new Map(after.screens.map((s) => [s.slug, s]));
  for (const s of after.screens)
    if (!bScreens.has(s.slug))
      out.push({
        kind: 'added',
        area: 'screen',
        text: `Pantalla nueva «${s.title}» (${blocksSummary(s.spec)})`,
      });
  for (const s of before.screens)
    if (!aScreens.has(s.slug))
      out.push({ kind: 'removed', area: 'screen', text: `Pantalla quitada «${s.title}»` });
  for (const s of after.screens) {
    const prev = bScreens.get(s.slug);
    if (!prev) continue;
    const bits: string[] = [];
    if (prev.title !== s.title) bits.push(`título «${prev.title}» → «${s.title}»`);
    if (prev.icon !== s.icon) bits.push('icono');
    if (!same([...prev.roles].sort(), [...s.roles].sort()))
      bits.push(`quién la ve (${s.roles.length ? s.roles.join(', ') : 'todos'})`);
    if (!same(prev.spec, s.spec)) {
      const delta = s.spec.blocks.length - prev.spec.blocks.length;
      bits.push(
        delta === 0
          ? 'contenido'
          : `${Math.abs(delta)} ${Math.abs(delta) === 1 ? 'bloque' : 'bloques'} ${delta > 0 ? 'más' : 'menos'}`,
      );
    }
    if (bits.length)
      out.push({ kind: 'changed', area: 'screen', text: `«${s.title}»: ${bits.join(', ')}` });
  }
  const order = (x: Snapshot) => x.screens.map((s) => s.slug).join('|');
  if (
    order(before) !== order(after) &&
    before.screens.length === after.screens.length &&
    [...bScreens.keys()].every((k) => aScreens.has(k))
  )
    out.push({ kind: 'changed', area: 'screen', text: 'Orden de las pantallas' });

  const bRoles = new Map(before.roles.map((r) => [r.key, r]));
  const aRoles = new Map(after.roles.map((r) => [r.key, r]));
  for (const r of after.roles)
    if (!bRoles.has(r.key))
      out.push({ kind: 'added', area: 'role', text: `Rol nuevo «${r.name}»` });
  for (const r of before.roles)
    if (!aRoles.has(r.key))
      out.push({ kind: 'removed', area: 'role', text: `Rol quitado «${r.name}»` });
  for (const r of after.roles) {
    const prev = bRoles.get(r.key);
    if (!prev) continue;
    if (!same(prev.permissions, r.permissions))
      out.push({ kind: 'changed', area: 'role', text: `Permisos del rol «${r.name}»` });
    else if (prev.name !== r.name)
      out.push({ kind: 'changed', area: 'role', text: `Rol «${prev.name}» → «${r.name}»` });
  }
  if (!same(before.home, after.home))
    out.push({ kind: 'changed', area: 'home', text: 'Pantalla de inicio (tarjetas)' });
  if (!same(before.brand, after.brand))
    out.push({
      kind: 'changed',
      area: 'look',
      text: 'Apariencia (colores, nombre corto, bienvenida)',
    });
  const bDash = new Map(before.dashboards.map((d) => [d.id, d]));
  const aDash = new Map(after.dashboards.map((d) => [d.id, d]));
  for (const d of after.dashboards)
    if (!bDash.has(d.id))
      out.push({
        kind: 'added',
        area: 'dashboards',
        text: `Tablero nuevo «${d.title}» (${d.widgets.length} widgets)`,
      });
  for (const d of before.dashboards)
    if (!aDash.has(d.id))
      out.push({ kind: 'removed', area: 'dashboards', text: `Tablero quitado «${d.title}»` });
  for (const d of after.dashboards) {
    const prev = bDash.get(d.id);
    if (prev && !same(prev, d))
      out.push({ kind: 'changed', area: 'dashboards', text: `Tablero «${d.title}» cambiado` });
  }
  if (!same(before.portal, after.portal))
    out.push({
      kind: 'changed',
      area: 'portal',
      text: after.portal.enabled
        ? before.portal.enabled
          ? 'Portal de clientes ajustado'
          : 'Portal de clientes encendido'
        : 'Portal de clientes apagado',
    });
  return out;
}

/** «3 cambios: …» en una línea (chat y tarjetas). */
export function summarizeChanges(changes: VersionChange[], max = 3): string {
  if (!changes.length) return 'Sin cambios';
  const head = changes.slice(0, max).map((c) => c.text);
  const rest = changes.length - head.length;
  return `${head.join('; ')}${rest > 0 ? ` y ${rest} más` : ''}`;
}

/** ¿El borrador es distinto de la última versión publicada? */
export function hasUnpublishedChanges(published: Snapshot | null, draft: Snapshot): boolean {
  if (!published) return true;
  return diffSnapshots(published, draft).length > 0;
}

// ---------------------------------------------------------------------------
// Lo que ven los usuarios: la versión publicada encima del acceso
// ---------------------------------------------------------------------------

/**
 * El acceso de quien USA la app, con la versión publicada pintada encima del
 * borrador vivo: el nombre, la apariencia, el inicio, los tableros, el
 * portal, las pantallas (cada una con su spec congelado) y el rol con los
 * permisos de ESA versión. Devuelve null si el rol de la persona ya no existe
 * en la foto (un rol creado después de publicar no entra a nada todavía).
 *
 * El administrador no pasa por aquí: ve el borrador.
 */
export function overlayAccess(access: AppAccess, snap: Snapshot): AppAccess | null {
  let role = access.role;
  if (!role.admin) {
    const snapRole = snap.roles.find((r) => r.key === access.role.key);
    if (!snapRole) return null;
    role = {
      key: snapRole.key,
      name: snapRole.name,
      permissions: snapRole.permissions,
      admin: false,
    };
  }
  const liveBySlug = new Map(access.screens.map((s) => [s.slug, s]));
  const screens: AppScreenRow[] = snap.screens.map((s, i) => {
    const live = liveBySlug.get(s.slug);
    return {
      id: live?.id ?? `v:${s.slug}`,
      app_id: access.app.id,
      view_id: s.viewId,
      slug: s.slug,
      title: s.title,
      icon: s.icon,
      position: i,
      roles: s.roles,
      frozenSpec: s.spec,
      frozenName: s.viewName,
    };
  });
  return {
    ...access,
    role,
    screens,
    app: {
      ...access.app,
      name: snap.app.name,
      description: snap.app.description,
      icon: snap.app.icon,
      theme: snap.app.theme,
      home_screen: snap.app.homeScreen,
      home: snap.home,
      brand: snap.brand,
      dashboards: snap.dashboards,
      portal: snap.portal,
    },
  };
}
