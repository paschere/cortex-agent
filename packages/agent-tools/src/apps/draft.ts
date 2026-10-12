import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../directory/store';
import { registerTool } from '../index';
import { type FlowActor, flowOf } from '../trackers/flow';
import { defineTracker, getTrackerBySlug, removeTracker } from '../trackers/store';
import { type ComputedView, type ViewSource, computeView, todayIn } from '../views/compute';
import { type CatalogTracker, type ViewSpec, trackersOf } from '../views/spec';
import { type AppDraft, appDraftSchema, reviewAppDraft } from './design';
import {
  type AppUser,
  type ResolvedRole,
  SCOPE_BLOCKED_MESSAGE,
  adminRole,
  applyRowScope,
  canSeeScreen,
  rowAccessFor,
} from './permissions';
import { PREVIEW_USER_ID, type SampleRow, sampleRows } from './sample-data';
import {
  type AppScreenRow,
  type CustomAppRow,
  addScreen,
  appSummary,
  createApp,
  deleteApp,
  roleWrites,
  saveRoles,
  updateApp,
} from './store';

/**
 * UNA APP COMPLETA EN UN SOLO PASO, Y SU VISTA PREVIA ANTES DE EXISTIR.
 *
 * Tres piezas, las tres sobre el mismo borrador (`AppDraft`, el que devuelve
 * `apps.design`):
 *
 *   1. `planCreations`: la lista, en orden, de lo que se va a crear (tablas
 *      nuevas, app, roles, pantallas). Es la que ve la persona en la tarjeta
 *      de confirmación, y la que recorre `applyAppDraft`.
 *   2. `runWithRollback`: ejecuta pasos en orden; cada uno devuelve cómo
 *      deshacerse. Si uno falla, deshace los ya hechos en orden inverso (la
 *      última pantalla primero, la tabla de primera al final) y lanza el error
 *      original. Nunca toca algo que no creó: una tabla que ya existía no entra
 *      al plan.
 *   3. `buildAppPreview`: la app corriendo con el borrador y filas de ejemplo
 *      sacadas de los campos de cada tabla, SIN escribir nada, para cada rol.
 */

// ---------------------------------------------------------------------------
// 1. El plan
// ---------------------------------------------------------------------------

export type PlanStep =
  | { kind: 'table'; slug: string; name: string }
  | { kind: 'app'; name: string }
  | { kind: 'roles'; names: string[] }
  | { kind: 'screen'; slug: string; title: string }
  | { kind: 'home'; slug: string };

/** Lo que se va a crear, en el orden en que se crea. `existing`: tablas que ya están y no se tocan. */
export function planCreations(draft: AppDraft, existing: ReadonlySet<string>): PlanStep[] {
  const steps: PlanStep[] = [];
  for (const t of draft.tables)
    if (!existing.has(t.slug)) steps.push({ kind: 'table', slug: t.slug, name: t.name });
  steps.push({ kind: 'app', name: draft.name });
  steps.push({ kind: 'roles', names: draft.roles.map((r) => r.name) });
  for (const [i, s] of draft.screens.entries())
    steps.push({ kind: 'screen', slug: s.slug ?? `pantalla_${i + 1}`, title: s.title });
  if (draft.homeScreen) steps.push({ kind: 'home', slug: draft.homeScreen });
  return steps;
}

export function describePlan(steps: readonly PlanStep[]): string[] {
  return steps.map((s) => {
    switch (s.kind) {
      case 'table':
        return `Tabla «${s.name}»`;
      case 'app':
        return `Aplicación «${s.name}» (borrador, sin publicar)`;
      case 'roles':
        return `Roles: ${s.names.join(', ')}`;
      case 'screen':
        return `Pantalla «${s.title}»`;
      case 'home':
        return `Pantalla de inicio: ${s.slug}`;
    }
  });
}

// ---------------------------------------------------------------------------
// 2. Ejecutar con deshacer
// ---------------------------------------------------------------------------

export interface Undoable {
  label: string;
  /** Hace el paso y devuelve cómo deshacerlo (o nada si no hay nada que deshacer). */
  run: () => Promise<(() => Promise<void>) | undefined>;
}

export interface RollbackReport {
  done: string[];
  undone: string[];
  /** Pasos que no se pudieron deshacer (para decirlo con honestidad). */
  stuck: string[];
}

export class StepFailed extends Error {
  constructor(
    readonly step: string,
    readonly report: RollbackReport,
    readonly original: unknown,
  ) {
    super(original instanceof Error ? original.message : String(original));
  }
}

export async function runWithRollback(steps: readonly Undoable[]): Promise<string[]> {
  const undo: Array<{ label: string; fn: () => Promise<void> }> = [];
  const done: string[] = [];
  for (const step of steps) {
    try {
      const back = await step.run();
      done.push(step.label);
      if (back) undo.push({ label: step.label, fn: back });
    } catch (cause) {
      const undone: string[] = [];
      const stuck: string[] = [];
      for (const u of undo.reverse()) {
        try {
          await u.fn();
          undone.push(u.label);
        } catch {
          stuck.push(u.label);
        }
      }
      throw new StepFailed(step.label, { done, undone, stuck }, cause);
    }
  }
  return done;
}

/** Aplica el borrador completo. Si algo falla, deshace lo creado y lanza `ValidationError`. */
export async function applyAppDraft(
  db: SupabaseClient,
  draft: AppDraft,
  userId: string,
): Promise<{
  app: CustomAppRow;
  screens: AppScreenRow[];
  createdTables: string[];
  plan: PlanStep[];
}> {
  const existing = new Set<string>();
  for (const t of draft.tables) if (await getTrackerBySlug(db, t.slug)) existing.add(t.slug);
  const plan = planCreations(draft, existing);
  const createdTables: string[] = [];
  let app: CustomAppRow | null = null;
  const screens: AppScreenRow[] = [];

  const steps: Undoable[] = [];
  for (const t of draft.tables) {
    if (existing.has(t.slug)) continue;
    steps.push({
      label: `Tabla «${t.name}»`,
      run: async () => {
        await defineTracker(db, {
          slug: t.slug,
          name: t.name,
          description: t.description,
          fields: t.fields,
          userId,
        });
        createdTables.push(t.slug);
        return async () => {
          await removeTracker(db, t.slug);
        };
      },
    });
  }
  steps.push({
    label: `Aplicación «${draft.name}»`,
    run: async () => {
      app = await createApp(db, {
        name: draft.name,
        description: draft.description,
        icon: draft.icon,
        userId,
      });
      const made = app;
      // Borrar la app se lleva sus pantallas (vistas), roles y automatizaciones.
      return async () => {
        await deleteApp(db, made.id);
      };
    },
  });
  steps.push({
    label: 'Roles',
    run: async () => {
      if (!app) throw new Error('Sin app.');
      await saveRoles(db, app.id, draft.roles);
      return undefined;
    },
  });
  for (const [i, s] of draft.screens.entries()) {
    steps.push({
      label: `Pantalla «${s.title}»`,
      run: async () => {
        if (!app) throw new Error('Sin app.');
        screens.push(
          await addScreen(db, app, {
            title: s.title,
            slug: s.slug ?? `pantalla_${i + 1}`,
            icon: s.icon,
            roles: s.roles,
            spec: s.spec,
            userId,
            prompt: 'Borrador aprobado en el chat',
          }),
        );
        return undefined;
      },
    });
  }
  steps.push({
    label: 'Pantalla de inicio',
    run: async () => {
      if (!app) throw new Error('Sin app.');
      const home = screens.find((s) => s.slug === draft.homeScreen) ?? screens[0];
      app = await updateApp(db, app.id, { homeScreen: home?.slug ?? null, userId });
      return undefined;
    },
  });

  try {
    await runWithRollback(steps);
  } catch (err) {
    if (err instanceof StepFailed) {
      const undone = err.report.undone.length
        ? ` Se deshizo lo que ya estaba hecho (${err.report.undone.join(', ')}).`
        : ' No quedó nada creado.';
      const stuck = err.report.stuck.length
        ? ` No se pudo deshacer: ${err.report.stuck.join(', ')}; revísalo a mano.`
        : '';
      throw new ValidationError(`Falló «${err.step}»: ${err.message}.${undone}${stuck}`);
    }
    throw err;
  }
  if (!app) throw new Error('La app no se creó.');
  return { app, screens, createdTables, plan };
}

// ---------------------------------------------------------------------------
// 3. La vista previa
// ---------------------------------------------------------------------------

export interface PreviewMeta {
  app: { name: string; icon: string; description: string };
  roles: Array<{ key: string; name: string }>;
  home: string | null;
}

export interface PreviewScreen {
  slug: string;
  title: string;
  icon: string;
}

export interface AppPreview {
  meta: PreviewMeta;
  /** Las pantallas que este rol ve, en orden. */
  screens: PreviewScreen[];
  views: Record<string, ComputedView>;
  /** Cuántas filas de ejemplo por tabla (para decirlo en la interfaz). */
  samples: Array<{ slug: string; name: string; rows: number }>;
  /** Lo que la vista previa no puede mostrar y por qué. */
  notes: string[];
}

function resolvedRole(draft: AppDraft, key: string | null): ResolvedRole {
  if (!key || key === 'administrador') return adminRole();
  const r = draft.roles.find((x) => x.key === key) ?? draft.roles[0];
  if (!r) return adminRole();
  return { key: r.key, name: r.name, permissions: r.permissions, admin: false };
}

/**
 * La app del borrador para UN rol: cada pantalla que ese rol ve, calculada con
 * filas de ejemplo y los permisos del rol (una tabla que no ve sale con el
 * aviso de siempre; una que ve «solo lo suyo» muestra una de cada tres filas).
 * No escribe nada y no lee filas reales: `catalog` son las tablas que ya
 * existen en la empresa (sólo su esquema).
 */
export function buildAppPreview(
  draft: AppDraft,
  catalog: readonly CatalogTracker[],
  options: {
    roleKey?: string | null;
    now?: Date;
    /** Abre el detalle de una fila de ejemplo en una pantalla. */
    record?: { screen: string; blockId: string; rowId: string } | null;
  } = {},
): AppPreview {
  const now = options.now ?? new Date();
  const today = todayIn(now);
  const role = resolvedRole(draft, options.roleKey ?? null);
  const notes: string[] = [];

  // Esquema de cada tabla: las del borrador que aún no existen y las reales.
  const schema = new Map<string, CatalogTracker>();
  for (const c of catalog) schema.set(c.slug, c);
  for (const t of draft.tables)
    if (!schema.has(t.slug)) schema.set(t.slug, { slug: t.slug, name: t.name, fields: t.fields });

  const slugs = [...new Set(draft.screens.flatMap((s) => trackersOf(s.spec)))].filter((s) =>
    schema.has(s),
  );
  // Primero las tablas a las que otras apuntan, para que las relaciones tengan a quién señalar.
  const ordered = [...slugs].sort((a, b) => {
    const deps = (slug: string) =>
      (schema.get(slug)?.fields ?? []).flatMap((f) =>
        f.type === 'relation' && f.tracker ? [f.tracker] : [],
      );
    return Number(deps(a).includes(b)) - Number(deps(b).includes(a));
  });
  const samplesBy = new Map<string, SampleRow[]>();
  for (const slug of ordered) {
    const t = schema.get(slug);
    if (!t) continue;
    samplesBy.set(slug, sampleRows(t, { today, relations: samplesBy, count: 8 }));
  }

  // Los atributos de quien mira salen de los propios datos de ejemplo («cliente» = el de la 1.ª fila).
  const attributes: Record<string, string> = {};
  for (const perm of Object.entries(role.permissions.tables))
    if (typeof perm[1].read === 'object') {
      const attr = /^\$user\.(.+)$/.exec(perm[1].read.equals)?.[1];
      const v = samplesBy.get(perm[0])?.[0]?.values[perm[1].read.field];
      if (attr && attr !== 'id' && v !== undefined) attributes[attr] = String(v);
    }
  const user: AppUser = { id: PREVIEW_USER_ID, name: 'Persona de ejemplo', attributes };

  const sourcesFor = (spec: ViewSpec): Map<string, ViewSource> => {
    const map = new Map<string, ViewSource>();
    for (const slug of trackersOf(spec)) {
      const tracker = schema.get(slug);
      if (!tracker) continue;
      const access = rowAccessFor(role, user, slug);
      if (access.kind === 'none') {
        map.set(slug, { tracker, rows: [], truncated: false, blocked: SCOPE_BLOCKED_MESSAGE });
        continue;
      }
      const rows = applyRowScope(samplesBy.get(slug) ?? [], access);
      map.set(slug, { tracker, rows, truncated: false });
    }
    return map;
  };

  const flowActor = (): FlowActor => ({ roles: [role.key], admin: role.admin, unscoped: false });
  const visible = draft.screens.filter((s) => canSeeScreen(role, s.roles));
  const views: Record<string, ComputedView> = {};
  for (const s of visible) {
    const slug = s.slug ?? '';
    const record =
      options.record && options.record.screen === slug
        ? { rowId: options.record.rowId, blockId: options.record.blockId, history: null }
        : null;
    views[slug] = computeView(s.spec, sourcesFor(s.spec), now, {
      writable: roleWrites(role, s.spec),
      audience: 'team',
      viewer: { id: PREVIEW_USER_ID, kind: 'member' },
      flowActor: flowActor(),
      record,
    });
  }
  if (draft.screens.some((s) => trackersOf(s.spec).some((t) => t.includes('.'))))
    notes.push(
      'Las pantallas con datos de la plataforma (ventas, caja, etc.) aparecen vacías aquí: se llenan con los datos reales al crear la app.',
    );
  notes.push('Las filas son de ejemplo y no se guardan. Los botones y formularios no escriben.');

  return {
    meta: {
      app: {
        name: draft.name,
        icon: draft.icon ?? '📱',
        description: draft.description,
      },
      roles: [
        ...draft.roles.map((r) => ({ key: r.key, name: r.name })),
        { key: 'administrador', name: 'Administrador' },
      ],
      home: draft.homeScreen ?? null,
    },
    screens: visible.map((s) => ({
      slug: s.slug ?? '',
      title: s.title,
      icon: s.icon ?? 'LayoutGrid',
    })),
    views,
    samples: slugs.map((slug) => ({
      slug,
      name: schema.get(slug)?.name ?? slug,
      rows: samplesBy.get(slug)?.length ?? 0,
    })),
    notes,
  };
}

/** Las filas de ejemplo que una fila con flujo muestra, para pruebas y para la interfaz. */
export function flowStatesOf(draft: AppDraft): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const t of draft.tables) {
    const f = flowOf(t.fields);
    if (f) out[t.slug] = f.flow.states;
  }
  return out;
}

// ---------------------------------------------------------------------------
// La herramienta
// ---------------------------------------------------------------------------

export const appsApplyDraft = registerTool({
  id: 'apps.apply_draft',
  description:
    'Create the WHOLE application of an approved draft in ONE step: the new tables, the app (as a draft, unpublished), its roles and all its screens, in order. If any step fails everything created so far is undone (the app and any table it just created are removed) and the error says which step failed. Pass the draft EXACTLY as apps.design returned it (name, description, icon, roles, screens, homeScreen, tables) — it is validated again here. The person approves ONCE with a card that lists what will be created. Tables that already exist are used as they are, never altered. Use this for any custom app after apps.design; for plain templates apps.create is still fine. Company owners/admins only. Requires confirmation.',
  inputSchema: appDraftSchema,
  outputSchema: z.object({
    app: z.unknown(),
    created: z.array(z.string()),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 4 },
  handler: async (input, ctx) => {
    if (!(await isCompanyManager(ctx.db, ctx.userId)))
      throw new ForbiddenError(
        'Sólo quien administra la empresa o es su dueño puede crear una aplicación.',
      );
    const review = await reviewAppDraft(ctx.db, input, { viewerId: ctx.userId });
    if (!review.ok || !review.draft)
      throw new ValidationError(
        `El borrador no es válido: ${review.problems.slice(0, 6).join(' ')} Corrígelo con apps.design.`,
      );
    const { app, screens, createdTables, plan } = await applyAppDraft(
      ctx.db,
      review.draft,
      ctx.userId,
    );
    const summary = appSummary(app, screens);
    return {
      app: summary,
      created: describePlan(plan),
      markdown: `Aplicación **${app.name}** creada como borrador: ${screens.length} pantallas (${screens.map((s) => s.title).join(', ')})${createdTables.length ? `, con las tablas ${createdTables.map((t) => `«${t}»`).join(', ')}` : ''}. Asigna miembros a los roles y publícala en ${summary.editUrl}.`,
    };
  },
});
