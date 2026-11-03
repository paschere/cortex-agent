import { ForbiddenError, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { isCompanyManager } from '../../directory/store';
import { registerTool } from '../../index';
import { roleKeySchema } from '../permissions';
import { mustGetApp } from '../store';
import { listScreens } from '../store';
import { buildAppCode, getCodeBuildDeps } from './build';
import { type CodeFiles, describeFiles, entriesFromScreens, orphanScreenFiles } from './files';
import {
  addCodeScreen,
  ensureAppCode,
  getAppCode,
  listBuilds,
  publishAppCode,
  saveAppCodeFiles,
} from './store';

/**
 * Programar una pantalla con código desde el chat (fase 1).
 *
 * El modelo itera: escribir → compilar → leer los errores del log → corregir.
 * Nada de lo que escribe llega a los usuarios hasta `apps.code_publish`, que
 * pide confirmación como `apps.publish`. Todas son de owner/admin: el código
 * de una pantalla corre con el rol de cada persona que la abre, pero decidir
 * qué corre es decidir qué ve y escribe gente que no es «del equipo».
 */

async function requireAppAdmin(ctx: { db: SupabaseClient; userId: string }): Promise<void> {
  if (!(await isCompanyManager(ctx.db, ctx.userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa o es su dueño puede cambiar el código de una aplicación.',
    );
}

const appRef = z.string().trim().min(1).max(80).describe('App id or slug.');

const GRAMMAR = `A code screen is a React + TypeScript file screens/<slug>.tsx with \`export default function Screen() {…}\`, compiled to one bundle that runs in a sandboxed iframe (no cookies, no network of its own, no direct database). All data goes through the SDK \`import { cortex, useUser, useQuery, useLocations } from '@cortex/app-sdk'\`: cortex.tables.list/query/get/insert/update, cortex.locations.live, cortex.geofences.list, cortex.ai.ask, cortex.nav.go({screen, prefill}), cortex.ui.toast(text); hooks useUser() -> {user, loading, error}, useQuery(table, {where, search, order, limit}, {refreshMs}) -> {rows, loading, error, refresh}, useLocations({refreshMs}). The SERVER applies the viewer's role to every call (tables the role does not read are refused, rows are scoped), so never hide data in the client as a security measure. Allowed npm packages in this phase: react, react-dom, lucide-react, recharts, leaflet, react-leaflet, date-fns (others are rejected at build time). Limits: 200 files, 512 KB each, 4 MB total; paths [a-zA-Z0-9_./-] without "..". Shared code goes in lib/**. Row values are strings or numbers keyed by field key: call cortex.tables.list first to learn the real keys and options instead of guessing them.`;

const statusOut = z.object({
  id: z.string(),
  number: z.number().int(),
  status: z.enum(['ok', 'error']),
  published: z.boolean(),
  createdAt: z.string(),
});

// ---------------------------------------------------------------------------
// apps.code_read
// ---------------------------------------------------------------------------

export const appsCodeRead = registerTool({
  id: 'apps.code_read',
  description: `Read the code project of an application: the files of the DRAFT (paths with sizes, or the full content of the paths you ask for), the code screens with their entry file, and the latest builds (number, ok/error, whether it is the published one) with the log of the newest. Read it before editing so you respect what a developer already changed in a file. ${GRAMMAR} Read-only; company owners/admins only.`,
  inputSchema: z.object({
    app: appRef,
    paths: z
      .array(z.string().trim().min(1).max(200))
      .max(20)
      .optional()
      .describe('Files to return in full. Omit to get only the file list.'),
  }),
  outputSchema: z.object({
    appId: z.string(),
    sdkVersion: z.string(),
    files: z.array(z.object({ path: z.string(), bytes: z.number().int() })),
    contents: z.record(z.string()),
    screens: z.array(
      z.object({ slug: z.string(), title: z.string(), entry: z.string().nullable() }),
    ),
    builds: z.array(statusOut),
    latestLog: z.string().nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const code = await getAppCode(ctx.db, app.id);
    const files: CodeFiles = code?.files ?? {};
    const contents: Record<string, string> = {};
    for (const path of input.paths ?? []) {
      if (!(path in files))
        throw new NotFoundError(`No existe el archivo «${path}» en el borrador.`);
      contents[path] = files[path] as string;
    }
    const screens = (await listScreens(ctx.db, app.id))
      .filter((s) => s.kind === 'code')
      .map((s) => ({ slug: s.slug, title: s.title, entry: s.codeEntry }));
    const builds = code ? await listBuilds(ctx.db, code.id, 10) : [];
    const buildOut = builds.map((b) => ({
      id: b.id,
      number: b.number,
      status: b.status,
      published: b.id === code?.published_build_id,
      createdAt: b.created_at,
    }));
    const latest = builds[0] ?? null;
    return {
      appId: app.id,
      sdkVersion: code?.sdk_version ?? '1',
      files: Object.entries(files).map(([path, c]) => ({
        path,
        bytes: new TextEncoder().encode(c).length,
      })),
      contents,
      screens,
      builds: buildOut,
      latestLog: latest ? latest.log : null,
      markdown: `**${app.name}** — archivos del borrador:\n${describeFiles(files)}\n\nPantallas con código: ${screens.map((s) => `${s.title} (\`${s.entry ?? '—'}\`)`).join(', ') || 'ninguna'}.${latest ? `\nÚltima compilación: #${latest.number} (${latest.status === 'ok' ? 'bien' : 'con errores'}).` : '\nSin compilaciones todavía.'}`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.code_write
// ---------------------------------------------------------------------------

export const appsCodeWrite = registerTool({
  id: 'apps.code_write',
  description: `Write or delete files of the application's code project DRAFT. Each file in \`write\` replaces the whole file (there are no patches: read it first with apps.code_read if it already exists, and keep what a developer wrote). \`remove\` deletes paths. Nothing reaches users: after writing, run apps.code_build and read its log. Create the screen itself with apps.code_add_screen (this tool only edits files). ${GRAMMAR} Company owners/admins only.`,
  inputSchema: z.object({
    app: appRef,
    write: z
      .array(z.object({ path: z.string().trim().min(1).max(200), content: z.string() }))
      .max(40)
      .default([]),
    remove: z.array(z.string().trim().min(1).max(200)).max(40).default([]),
  }),
  outputSchema: z.object({
    written: z.array(z.string()),
    removed: z.array(z.string()),
    files: z.number().int(),
    warnings: z.array(z.string()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 40 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const write = input.write ?? [];
    const remove = input.remove ?? [];
    if (!write.length && !remove.length)
      throw new ValidationError('No hay nada que escribir ni que borrar.');
    const app = await mustGetApp(ctx.db, input.app);
    const code = await saveAppCodeFiles(
      ctx.db,
      app.id,
      {
        write: Object.fromEntries(write.map((f) => [f.path, f.content])),
        remove: remove,
      },
      ctx.userId,
    );
    const screens = await listScreens(ctx.db, app.id);
    const { entries, missing } = entriesFromScreens(screens, code.files);
    const warnings = [
      ...missing.map((m) => `Falta el archivo de la pantalla ${m}.`),
      ...orphanScreenFiles(entries, code.files).map(
        (p) => `«${p}» no es la entrada de ninguna pantalla con código (apps.code_add_screen).`,
      ),
    ];
    return {
      written: write.map((f) => f.path),
      removed: remove,
      files: Object.keys(code.files).length,
      warnings,
      markdown: `Borrador de **${app.name}**: ${write.length} archivo(s) escrito(s), ${remove.length} borrado(s). Ahora compílalo con apps.code_build.${warnings.length ? `\nAvisos: ${warnings.join(' ')}` : ''}`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.code_build
// ---------------------------------------------------------------------------

export const appsCodeBuild = registerTool({
  id: 'apps.code_build',
  description:
    'Compile the DRAFT code of an application (npm install + esbuild in an isolated sandbox, one bundle per code screen) and save it as a numbered build. Returns ok/error and the log: when it fails, READ the log (it has the file, line and message of each error), fix the files with apps.code_write and build again. Takes up to a couple of minutes. A build does not reach users: apps.code_publish does. Company owners/admins only.',
  inputSchema: z.object({ app: appRef }),
  outputSchema: z.object({
    buildId: z.string(),
    number: z.number().int(),
    status: z.enum(['ok', 'error']),
    log: z.string(),
    screens: z.array(z.string()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const deps = getCodeBuildDeps();
    const build = await buildAppCode(ctx.db, app.id, ctx.userId, deps.builder, deps.sdkSource);
    const screens = Object.keys(build.bundles);
    return {
      buildId: build.id,
      number: build.number,
      status: build.status,
      log: build.log,
      screens,
      markdown:
        build.status === 'ok'
          ? `Compilación #${build.number} de **${app.name}** salió bien (${screens.join(', ')}). Para que la vean los usuarios: apps.code_publish.`
          : `La compilación #${build.number} de **${app.name}** falló. Lee el log, corrige con apps.code_write y compila otra vez.`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.code_add_screen
// ---------------------------------------------------------------------------

export const appsCodeAddScreen = registerTool({
  id: 'apps.code_add_screen',
  description:
    'Add a CODE screen to an application: it appears in the app menu like any other screen (same roles, order and icon) but is drawn by the file screens/<slug>.tsx of the code project. A starter file is created if it does not exist; replace it with apps.code_write. The screen is part of the app DRAFT: users see it after apps.publish (the app) AND apps.code_publish (the code). Up to 12 screens per app. Company owners/admins only.',
  inputSchema: z.object({
    app: appRef,
    title: z.string().trim().min(1).max(60),
    slug: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,47}$/)
      .optional(),
    icon: z.string().trim().max(60).optional().describe('A lucide icon name or an emoji.'),
    roles: z
      .array(roleKeySchema)
      .max(8)
      .default([])
      .describe('Role keys that see it; empty = everyone.'),
  }),
  outputSchema: z.object({
    slug: z.string(),
    title: z.string(),
    entry: z.string(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const screen = await addCodeScreen(ctx.db, app, {
      title: input.title,
      slug: input.slug,
      icon: input.icon,
      roles: input.roles,
      userId: ctx.userId,
    });
    return {
      slug: screen.slug,
      title: screen.title,
      entry: screen.codeEntry ?? '',
      markdown: `Pantalla con código **${screen.title}** creada en **${app.name}** (\`${screen.codeEntry}\`, con un archivo de arranque). Escribe su código con apps.code_write y compílalo.`,
    };
  },
});

// ---------------------------------------------------------------------------
// apps.code_publish
// ---------------------------------------------------------------------------

export const appsCodePublish = registerTool({
  id: 'apps.code_publish',
  description:
    'Publish a successful build of the application code: from then on people who open its code screens run THAT bundle (with their own role: the server still limits what each one reads and writes). Defaults to the newest build; pass `build` (number) to publish or go back to another one that compiled. Only builds with status ok can be published. Requires confirmation; company owners/admins only.',
  inputSchema: z.object({
    app: appRef,
    build: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Build number; omit for the newest ok build.'),
  }),
  outputSchema: z.object({
    number: z.number().int(),
    screens: z.array(z.string()),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const code = await ensureAppCode(ctx.db, app.id, ctx.userId);
    const builds = await listBuilds(ctx.db, code.id);
    const wanted = input.build
      ? builds.find((b) => b.number === input.build)
      : builds.find((b) => b.status === 'ok');
    if (!wanted)
      throw new NotFoundError(
        input.build
          ? `No existe la compilación #${input.build}.`
          : 'No hay una compilación que haya salido bien. Compila con apps.code_build.',
      );
    const { build } = await publishAppCode(ctx.db, app.id, wanted.id, ctx.userId);
    const screens = Object.keys(build.bundles);
    return {
      number: build.number,
      screens,
      markdown: `Compilación #${build.number} publicada en **${app.name}**: ${screens.join(', ')}. Los usuarios la ven en cuanto abran la pantalla (si la app ya está publicada; si no, usa apps.publish).`,
    };
  },
});
