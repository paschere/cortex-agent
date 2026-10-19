import { ForbiddenError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../directory/store';
import { registerTool } from '../index';
import { getTrackerBySlug } from '../trackers/store';
import { type CatalogTracker, trackersOf } from '../views/spec';
import { viewCatalog } from '../views/store';
import {
  type InspectInput,
  type InspectReport,
  expectedFieldsMissing,
  inspectApp,
  renderInspection,
} from './inspect-shape';
import {
  type CustomAppRow,
  listRoles,
  listScreens,
  loadPublishedSnapshot,
  mustGetApp,
  screenViews,
} from './store';

/**
 * `apps.inspect`: «QUÉ VE DE VERDAD ESTE ROL», DE SÓLO LECTURA.
 *
 * Carga el spec de cada pantalla, los roles y el esquema real de las tablas, y
 * le pasa todo a `inspectApp` (inspect-shape.ts, puro). No abre navegador y no
 * escribe nada. Cortex lo llama tras cambiar una app, para el rol afectado, y
 * sólo dice «listo» si lo que la persona pidió aparece de verdad.
 */

/** El borrador (lo que ve quien administra y lo que acaba de cambiar `apps.update`) o lo publicado. */
export type InspectVersion = 'draft' | 'published';

export interface LoadedInspect {
  app: CustomAppRow;
  input: Omit<InspectInput, 'roleKey'>;
  /** Número de la versión publicada hoy; null = nunca publicada. */
  publishedNumber: number | null;
  version: InspectVersion;
}

export async function loadInspectInput(
  db: SupabaseClient,
  appRef: string,
  version: InspectVersion,
  viewerId?: string | null,
): Promise<LoadedInspect> {
  const app = await mustGetApp(db, appRef);
  const published = await loadPublishedSnapshot(db, app.id);
  let usePublished = version === 'published';
  if (usePublished && !published) usePublished = false;

  let screens: InspectInput['screens'];
  let roles: InspectInput['roles'];
  let homeScreen: string | null;
  if (usePublished && published) {
    const snap = published.snapshot;
    screens = snap.screens.map((s) => ({
      slug: s.slug,
      title: s.title,
      roles: s.roles,
      spec: s.spec,
    }));
    roles = snap.roles.map((r) => ({ key: r.key, name: r.name, permissions: r.permissions }));
    homeScreen = snap.app.homeScreen;
  } else {
    const liveScreens = (await listScreens(db, app.id)).filter((s) => s.view_id);
    const views = await screenViews(db, liveScreens);
    screens = liveScreens.flatMap((s) => {
      const v = views.get(s.view_id);
      return v ? [{ slug: s.slug, title: s.title, roles: s.roles, spec: v.spec }] : [];
    });
    roles = (await listRoles(db, app.id)).map((r) => ({
      key: r.key,
      name: r.name,
      permissions: r.permissions,
    }));
    homeScreen = app.home_screen;
  }

  const slugs = [...new Set(screens.flatMap((s) => trackersOf(s.spec)))];
  // Una relación apunta a una tabla que el spec quizá no nombra: también se necesita su esquema.
  const catalogAll = await viewCatalog(db, { viewerId: viewerId ?? null, keep: slugs });
  const catalog: Array<CatalogTracker & { rowCount?: number | null }> = catalogAll.filter(
    (c) => c.kind !== 'feed',
  );
  const rowCounts: Record<string, number> = {};
  for (const c of catalog) if (c.rowCount !== null && c.rowCount !== undefined) rowCounts[c.slug] = c.rowCount;
  // El catálogo trae las primeras tablas; una relación puede apuntar más allá.
  const known = new Set(catalog.map((c) => c.slug));
  const missing = new Set<string>();
  for (const c of catalog)
    for (const f of c.fields) if (f.type === 'relation' && f.tracker && !known.has(f.tracker)) missing.add(f.tracker);
  for (const slug of missing) {
    const t = await getTrackerBySlug(db, slug);
    if (!t) continue;
    catalog.push({ slug: t.slug, name: t.name, fields: t.fields });
    const { count } = await db
      .from('tracker_rows')
      .select('id', { count: 'exact', head: true })
      .eq('tracker_id', t.id);
    if (typeof count === 'number') rowCounts[t.slug] = count;
  }

  return {
    app,
    input: { app: { name: app.name, homeScreen }, screens, roles, catalog, rowCounts },
    publishedNumber: published?.number ?? null,
    version: usePublished ? 'published' : 'draft',
  };
}

/** Revisa la app para un rol (clave o «administrador»). */
export async function inspectAppRole(
  db: SupabaseClient,
  appRef: string,
  roleKey: string | null,
  version: InspectVersion = 'draft',
  viewerId?: string | null,
): Promise<{ loaded: LoadedInspect; report: InspectReport | { error: string } }> {
  const loaded = await loadInspectInput(db, appRef, version, viewerId);
  return { loaded, report: inspectApp({ ...loaded.input, roleKey }) };
}

export const appsInspect = registerTool({
  id: 'apps.inspect',
  description:
    'Look at an application the way ONE role really sees it, computed from the saved screens + permissions + real table schema (no browser, nothing written): the screens that role sees and which one opens first, every block with how much of its table the role reads/edits/creates, and for each FORM every field with the control that is actually rendered (text, number, dropdown with N options, relation with N options or NONE, read-only formula, lookup, autofill, date, photo, signature…), plus the problems found: a required field the role cannot write, a relation/dropdown with no options for that role (the screen does not share the related table), a block over a table the role has no permission on, a role that cannot create in the form table, an unreachable start screen, an empty source. MANDATORY after apps.update / apps.apply_draft / apps.publish / views.update on an app screen: call it for the role the change is about (and the role that uses the form) and say «listo» ONLY if what the person asked really shows up there (pass `expect` with the field names or labels they asked for; `missing` lists the ones that do not appear working). If something is missing or a problem relates to the change, fix it with apps.update and inspect again; never report success from the update result alone. version "draft" (default) = what admins and the editor see now; "published" = what the users see today. Omit `role` to review EVERY role in one go (problems only). Read-only; company owners/admins only.',
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80).describe('App id or slug.'),
    role: z
      .string()
      .trim()
      .max(40)
      .optional()
      .describe('Role key (e.g. "operario") or "administrador". Omit = every role.'),
    version: z.enum(['draft', 'published']).default('draft'),
    expect: z
      .array(z.string().trim().min(1).max(60))
      .max(30)
      .optional()
      .describe('Field names or labels the person asked to see; reported back as `missing` if they do not appear working for that role.'),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    version: z.enum(['draft', 'published']),
    publishedNumber: z.number().nullable(),
    reports: z.array(z.unknown()),
    missing: z.array(z.string()),
    problems: z.array(z.string()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    if (!(await isCompanyManager(ctx.db, ctx.userId)))
      throw new ForbiddenError('Sólo quien administra la empresa puede revisar una aplicación.');
    const loaded = await loadInspectInput(ctx.db, input.app, input.version ?? 'draft', ctx.userId);
    const keys = input.role
      ? [input.role]
      : ['administrador', ...loaded.input.roles.map((r) => r.key)];
    const reports: InspectReport[] = [];
    const errors: string[] = [];
    for (const key of keys) {
      const r = inspectApp({ ...loaded.input, roleKey: key });
      if ('error' in r) errors.push(r.error);
      else reports.push(r);
    }
    const problems = [
      ...errors,
      ...reports.flatMap((r) =>
        r.problems.map((p) => (reports.length > 1 ? `[${r.role.name}] ${p}` : p)),
      ),
    ];
    const missing =
      input.expect?.length && reports.length === 1 && reports[0]
        ? expectedFieldsMissing(reports[0], input.expect)
        : [];
    const ok = problems.length === 0 && missing.length === 0;
    const single = reports.length === 1 && reports[0];
    const body = single
      ? renderInspection(single)
      : reports
          .map(
            (r) =>
              `- **${r.role.name}**: abre en ${r.startScreen ?? 'nada'}; ${r.screens.length} pantallas${r.problems.length ? `; ${r.problems.length} problemas` : '; sin problemas'}`,
          )
          .join('\n');
    const status =
      loaded.version === 'published'
        ? `Esto es lo PUBLICADO (versión ${loaded.publishedNumber}), lo que ven los usuarios hoy.`
        : loaded.publishedNumber === null
          ? 'Esto es el borrador; la app nunca se ha publicado.'
          : `Esto es el BORRADOR; los usuarios ven la versión ${loaded.publishedNumber} hasta que se publique.`;
    const verdict = missing.length
      ? `\n\n**NO está listo:** no aparece (o no funciona) para ese rol: ${missing.join(', ')}. Corrígelo y vuelve a revisar.`
      : problems.length
        ? '\n\nHay problemas arriba: si tocan lo que se pidió, corrígelos y vuelve a revisar antes de decir «listo».'
        : input.expect?.length
          ? `\n\nTodo lo pedido aparece: ${input.expect.join(', ')}.`
          : '';
    return {
      ok,
      version: loaded.version,
      publishedNumber: loaded.publishedNumber,
      reports,
      missing,
      problems,
      markdown: `${status}\n${body}${errors.length ? `\n${errors.join('\n')}` : ''}${verdict}`,
    };
  },
});
