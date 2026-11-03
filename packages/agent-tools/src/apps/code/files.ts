import { ValidationError } from '@cortex/core';

/**
 * LOS ARCHIVOS DE UN PROYECTO DE CÓDIGO, EN PURO (migración 0243).
 *
 * Nada de aquí toca la base: valida lo que llega (de Cortex o de un
 * desarrollador) antes de guardarlo y saca de los archivos las pantallas que
 * hay que compilar. Un proyecto es un mapa `{ruta: contenido}`:
 *
 *   package.json             dependencias npm (cualquiera del registro; fase 2)
 *   screens/<slug>.tsx       una pantalla: `export default function Screen() {…}`
 *   lib/**                   código compartido
 *   server/<nombre>.ts       función de servidor (fase 2): `export default async function (input, ctx)`
 *   db/migrations/NNNN_*.sql migraciones de la base propia (fase 3)
 *
 * Límites del contrato: 200 archivos, 512 KB por archivo, 4 MB en total.
 */

export const MAX_CODE_FILES = 200;
export const MAX_CODE_FILE_BYTES = 512 * 1024;
export const MAX_CODE_TOTAL_BYTES = 4 * 1024 * 1024;

export const CODE_PATH_RE = /^[a-zA-Z0-9_./-]+$/;
export const SCREEN_FILE_RE = /^screens\/([a-z][a-z0-9_]{1,47})\.tsx$/;

export const FUNCTION_FILE_RE = /^server\/([a-z][a-z0-9_]{1,47})\.ts$/;
export const FUNCTION_NAME_RE = /^[a-z][a-z0-9_]{1,47}$/;
/** Tope de paquetes declarados: más que esto no es una app, es un descuido. */
export const MAX_DECLARED_PACKAGES = 60;

export type CodeFiles = Record<string, string>;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/** ¿Esta ruta es válida? Devuelve el motivo en español, o null si sirve. */
export function pathProblem(path: string): string | null {
  if (!path || path.length > 200) return 'La ruta va de 1 a 200 caracteres.';
  if (!CODE_PATH_RE.test(path))
    return `La ruta «${path}» sólo admite letras, números, «_», «.», «-» y «/».`;
  if (path.startsWith('/') || path.endsWith('/'))
    return `La ruta «${path}» no puede empezar ni terminar con «/».`;
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..'))
    return `La ruta «${path}» no puede llevar «..», «.» ni tramos vacíos.`;
  return null;
}

/**
 * Valida un mapa de archivos completo y lo devuelve tal cual. Lanza
 * `ValidationError` con el primer problema, en español.
 */
export function validateCodeFiles(files: unknown): CodeFiles {
  if (!files || typeof files !== 'object' || Array.isArray(files))
    throw new ValidationError('Los archivos del proyecto deben ser un mapa ruta → contenido.');
  const entries = Object.entries(files as Record<string, unknown>);
  if (entries.length > MAX_CODE_FILES)
    throw new ValidationError(`Un proyecto lleva hasta ${MAX_CODE_FILES} archivos.`);
  let total = 0;
  const out: CodeFiles = {};
  for (const [path, content] of entries) {
    const problem = pathProblem(path);
    if (problem) throw new ValidationError(problem);
    if (typeof content !== 'string')
      throw new ValidationError(`El contenido de «${path}» debe ser texto.`);
    const size = byteLength(content);
    if (size > MAX_CODE_FILE_BYTES)
      throw new ValidationError(`«${path}» pesa más de ${MAX_CODE_FILE_BYTES / 1024} KB.`);
    total += size;
    out[path] = content;
  }
  if (total > MAX_CODE_TOTAL_BYTES)
    throw new ValidationError(
      `El proyecto pesa más de ${MAX_CODE_TOTAL_BYTES / 1024 / 1024} MB en total.`,
    );
  return out;
}

/**
 * Aplica una escritura al borrador: `write` pone o reemplaza archivos y
 * `remove` quita rutas. Devuelve el mapa nuevo ya validado (límites incluidos);
 * el borrador original no se muta.
 */
export function applyFileChanges(
  current: CodeFiles,
  changes: { write?: Record<string, string>; remove?: string[] },
): CodeFiles {
  const next: CodeFiles = { ...current };
  for (const path of changes.remove ?? []) delete next[path];
  for (const [path, content] of Object.entries(changes.write ?? {})) {
    const problem = pathProblem(path);
    if (problem) throw new ValidationError(problem);
    next[path] = content;
  }
  return validateCodeFiles(next);
}

/** La ruta de la pantalla `slug`: `screens/<slug>.tsx`. */
export function screenFilePath(slug: string): string {
  return `screens/${slug}.tsx`;
}

/** El slug de una ruta `screens/<slug>.tsx`, o null si no es una pantalla. */
export function screenSlugOf(path: string): string | null {
  return SCREEN_FILE_RE.exec(path)?.[1] ?? null;
}

/**
 * Las pantallas que se compilan: `{slug → ruta}`. Salen de las pantallas
 * `code` de la app (la entrada que declaran) cuyo archivo existe; si una
 * pantalla no declara entrada se usa `screens/<slug>.tsx`.
 */
export function entriesFromScreens(
  screens: ReadonlyArray<{ slug: string; kind: 'view' | 'code'; codeEntry: string | null }>,
  files: CodeFiles,
): { entries: Record<string, string>; missing: string[] } {
  const entries: Record<string, string> = {};
  const missing: string[] = [];
  for (const s of screens) {
    if (s.kind !== 'code') continue;
    const path = s.codeEntry ?? screenFilePath(s.slug);
    if (path in files) entries[s.slug] = path;
    else missing.push(`${s.slug} (${path})`);
  }
  return { entries, missing };
}

/** Archivos `screens/*.tsx` que ninguna pantalla `code` usa (sirven para avisar, no bloquean). */
export function orphanScreenFiles(entries: Record<string, string>, files: CodeFiles): string[] {
  const used = new Set(Object.values(entries));
  return Object.keys(files).filter((p) => screenSlugOf(p) !== null && !used.has(p));
}

/** Los paquetes que declara el `package.json` (dependencies y devDependencies), o null si no se lee. */
export function declaredPackages(files: CodeFiles): string[] | null {
  const raw = files['package.json'];
  if (raw === undefined) return [];
  try {
    const json = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [...Object.keys(json.dependencies ?? {}), ...Object.keys(json.devDependencies ?? {})];
  } catch {
    return null;
  }
}

/**
 * Cualquier paquete del registro de npm sirve (fase 2). Sólo se rechaza lo que
 * no tiene sentido en una compilación aislada: versiones que apuntan al disco
 * del sandbox (`file:`, `link:`, `workspace:`, `portal:`) y pasarse del tope de
 * paquetes. Los scripts de instalación nunca corren (`--ignore-scripts`), así
 * que un paquete con `postinstall` se instala pero no ejecuta nada. Devuelve
 * los motivos en español (vacío = todo bien).
 */
export function packageProblems(files: CodeFiles): string[] {
  const raw = files['package.json'];
  if (raw === undefined) return [];
  let json: { dependencies?: unknown; devDependencies?: unknown };
  try {
    json = JSON.parse(raw);
  } catch {
    return ['El package.json no es un JSON válido.'];
  }
  const out: string[] = [];
  const specs: Array<[string, unknown]> = [];
  for (const group of [json.dependencies, json.devDependencies]) {
    if (group && typeof group === 'object' && !Array.isArray(group))
      specs.push(...Object.entries(group as Record<string, unknown>));
  }
  if (specs.length > MAX_DECLARED_PACKAGES)
    out.push(
      `El package.json declara ${specs.length} paquetes; el tope es ${MAX_DECLARED_PACKAGES}.`,
    );
  for (const [name, version] of specs) {
    if (typeof version !== 'string') {
      out.push(`La versión de «${name}» debe ser texto.`);
      continue;
    }
    if (/^(file|link|workspace|portal):/i.test(version.trim()))
      out.push(
        `«${name}» apunta a «${version}»: las rutas locales no existen en la compilación. Usa una versión del registro de npm.`,
      );
  }
  return out;
}

/** Los archivos de funciones de servidor: `{nombre → ruta}`. */
export function functionEntries(files: CodeFiles): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of Object.keys(files)) {
    const name = FUNCTION_FILE_RE.exec(path)?.[1];
    if (name) out[name] = path;
  }
  return out;
}

/** Los nombres de las funciones de servidor del proyecto, en orden. */
export function functionNames(files: CodeFiles): string[] {
  return Object.keys(functionEntries(files)).sort();
}

/** La ruta de la función `name`: `server/<name>.ts`. */
export function functionPath(name: string): string {
  return `server/${name}.ts`;
}

/** Resumen corto de un proyecto para el chat: rutas con tamaño. */
export function describeFiles(files: CodeFiles): string {
  const paths = Object.keys(files).sort();
  if (!paths.length) return 'Sin archivos.';
  return paths.map((p) => `- ${p} (${byteLength(files[p] ?? '')} B)`).join('\n');
}
