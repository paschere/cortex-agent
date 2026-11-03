import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { listScreens, mustGetApp } from '../store';
import {
  type CodeFiles,
  entriesFromScreens,
  functionEntries,
  packageProblems,
  validateCodeFiles,
} from './files';
import {
  type AppCodeBuildRow,
  type BundleMap,
  type FunctionBundles,
  ensureAppCode,
  recordBuild,
} from './store';

/**
 * COMPILAR UN PROYECTO DE CÓDIGO (fase 1).
 *
 * El paquete no sabe compilar: no puede importar `@vercel/sandbox` ni esbuild.
 * Recibe un `Builder` inyectable (la implementación real vive en
 * apps/web/lib/apps/code-builder.ts y compila en Vercel Sandbox). Aquí se
 * arma la entrada (las pantallas `code` y su archivo), se rechaza lo que la
 * fase 1 no deja (paquetes fuera de la lista) y se guarda el resultado como
 * una compilación numerada (con los bundles de las pantallas y las funciones
 * de servidor), buena o mala: el log de una mala es lo que Cortex
 * lee para corregir.
 */

export interface BuilderInput {
  files: CodeFiles;
  /** slug de pantalla → ruta del archivo de entrada. */
  entries: Record<string, string>;
  /** Funciones de servidor: nombre → ruta (`server/<nombre>.ts`). Se empaquetan para node. */
  functions: Record<string, string>;
  /** Código fuente del SDK `@cortex/app-sdk` (ver `CodeBuildDeps`). */
  sdkSource: string;
}

export interface BuilderOutput {
  ok: boolean;
  bundles: BundleMap;
  /** nombre de función → JS CommonJS listo para correr con `node` (paquetes incluidos). */
  functions?: FunctionBundles;
  log: string;
}

export interface Builder {
  build(input: BuilderInput): Promise<BuilderOutput>;
}

/** Lo que la app web entrega al paquete para poder compilar (como `AutomationDeps`). */
export interface CodeBuildDeps {
  builder: Builder;
  /** El SDK, como texto que el builder escribe en node_modules/@cortex/app-sdk. */
  sdkSource: string;
}

/**
 * Los enganches viven en `globalThis` (como los de automations/emit.ts): Next
 * compila `instrumentation.ts` aparte de las rutas y cada una puede cargar su
 * copia de este módulo; con una variable de módulo, lo registrado al arrancar
 * no sería lo que ven las herramientas del chat.
 */
const DEPS_KEY = Symbol.for('cortex.app-code.build-deps');

export function setCodeBuildDeps(deps: CodeBuildDeps | null): void {
  (globalThis as unknown as Record<symbol, CodeBuildDeps | null>)[DEPS_KEY] = deps;
}

export function getCodeBuildDeps(): CodeBuildDeps {
  const deps = (globalThis as unknown as Record<symbol, CodeBuildDeps | null | undefined>)[
    DEPS_KEY
  ];
  if (!deps) throw new ValidationError('Compilar código no está disponible en este entorno.');
  return deps;
}

const LOG_MAX = 20_000;

/** El log se guarda recortado: el principio (instalación) y el final (los errores). */
function trimLog(log: string): string {
  if (log.length <= LOG_MAX) return log;
  return `${log.slice(0, 4_000)}\n… [recortado] …\n${log.slice(-(LOG_MAX - 4_000))}`;
}

/**
 * Compila el borrador de la app y guarda la compilación. Nunca lanza por un
 * error de código: devuelve la compilación con `status: 'error'` y el log. Sí
 * lanza si la app no existe o no se pudo guardar.
 */
export async function buildAppCode(
  db: SupabaseClient,
  appId: string,
  actor: string,
  builder: Builder,
  sdkSource: string,
): Promise<AppCodeBuildRow> {
  const app = await mustGetApp(db, appId);
  const code = await ensureAppCode(db, app.id, actor);
  const files = validateCodeFiles(code.files);
  const screens = await listScreens(db, app.id);
  const { entries, missing } = entriesFromScreens(screens, files);

  const fail = (log: string) =>
    recordBuild(db, code, { files, bundles: {}, status: 'error', log, userId: actor });

  if (missing.length)
    return fail(
      `Falta el archivo de entrada de: ${missing.join(', ')}. Escríbelo o quita la pantalla.`,
    );
  const fnEntries = functionEntries(files);
  if (!Object.keys(entries).length && !Object.keys(fnEntries).length)
    return fail(
      'La aplicación no tiene pantallas con código ni funciones de servidor. Crea una pantalla con addCodeScreen o una función en server/<nombre>.ts.',
    );
  const problems = packageProblems(files);
  if (problems.length) return fail(problems.join('\n'));

  let out: Awaited<ReturnType<Builder['build']>>;
  try {
    out = await builder.build({ files, entries, functions: fnEntries, sdkSource });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`No se pudo compilar: ${message}`.slice(0, LOG_MAX));
  }
  // Cada pantalla pedida tiene que traer bundle; si no, no está "ok".
  const lacking = Object.keys(entries).filter((slug) => !out.bundles[slug]?.js);
  const lackingFns = Object.keys(fnEntries).filter((name) => !out.functions?.[name]);
  const ok = out.ok && lacking.length === 0 && lackingFns.length === 0;
  const log =
    (lacking.length || lackingFns.length) && out.ok
      ? `${out.log}\nSin bundle para: ${[...lacking, ...lackingFns].join(', ')}.`
      : out.log;
  return recordBuild(db, code, {
    files,
    bundles: ok ? out.bundles : {},
    functions: ok ? (out.functions ?? {}) : {},
    status: ok ? 'ok' : 'error',
    log: trimLog(log),
    userId: actor,
  });
}
