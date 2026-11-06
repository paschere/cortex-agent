import 'server-only';
import { APP_SDK_FILES } from '@/lib/apps/app-sdk-source.generated';
import {
  type Builder,
  type BuilderInput,
  type BuilderOutput,
  type CodeBuildDeps,
  packageProblems,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { Sandbox } from '@vercel/sandbox';

/**
 * EL COMPILADOR DE PANTALLAS Y FUNCIONES DE SERVIDOR (fases 1 y 2), EN VERCEL SANDBOX.
 *
 * Una función de Vercel no puede `npm install` ni correr esbuild con paquetes
 * arbitrarios; un Firecracker microVM sí. Por cada compilación se levanta un
 * sandbox NO persistente (nace y muere con la compilación; nada de lo que
 * escribe el código de la app sobrevive), se instalan las
 * dependencias (cualquier paquete del registro de npm, con `--ignore-scripts`:
 * ningún paquete corre código al instalarse), se empaqueta cada pantalla con
 * esbuild a un IIFE para el navegador y cada función de `server/*.ts` a un
 * CommonJS para Node 22 con sus paquetes dentro, y se devuelven como texto. El navegador nunca
 * ve más que el bundle de la pantalla; las funciones nunca salen del servidor.
 *
 * Autenticación: igual que dev-tasks/sandbox.ts, `Sandbox.create` toma las
 * credenciales del entorno (OIDC de Vercel en producción; `VERCEL_TOKEN`,
 * `VERCEL_TEAM_ID` y `VERCEL_PROJECT_ID` en local). Aquí no pasa ninguna llave
 * de Cortex al sandbox: el código del usuario corre ahí con internet (para
 * npm) pero sin ningún secreto.
 *
 * EL SDK (`@cortex/app-sdk`). No se publica en npm: se escribe en
 * `node_modules/@cortex/app-sdk` DESPUÉS del `npm install` (que podaría una
 * carpeta que no está en el `package.json`) como fuente TypeScript, con
 * `"main": "src/index.ts"`, y esbuild la compila junto con la pantalla. Su
 * fuente viaja dentro del bundle de esta función (`app-sdk-source.generated.ts`,
 * generado por scripts/gen-app-sdk-source.mjs) y no se lee del disco: así no
 * depende del rastreo de archivos de Next ni de dónde quede el monorepo en
 * producción. `sdkSource` es el JSON de ese mapa {ruta: contenido}.
 */

const ROOT = '/vercel/sandbox';
const SANDBOX_TIMEOUT_MS = 5 * 60_000;
const INSTALL_TIMEOUT_MS = 150_000;
const BUILD_TIMEOUT_MS = 120_000;
/** Lo que pesan, instalados, los paquetes de una compilación: más que esto es un descuido (o un ataque al disco). */
const MAX_INSTALLED_KB = 700 * 1024;
/** Una función empaquetada con sus paquetes no pasa de esto (va dentro de una fila jsonb). */
const MAX_FUNCTION_BUNDLE_BYTES = 6 * 1024 * 1024;
const LOG_MAX_CHARS = 16_000;
const RESULT_PATH = `${ROOT}/.cortex-build/result.json`;

/** Versiones fijas: una compilación de hoy y la de mañana empaquetan lo mismo. */
const REACT_VERSION = '18.3.1';
const ESBUILD_VERSION = '0.25.9';

/** Lo que `package.json` no puede traer: ni scripts (se instala con --ignore-scripts de todos modos) ni el SDK. */
function projectPackageJson(files: Record<string, string>): string {
  let base: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(files['package.json'] ?? '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
  } catch {
    // Un package.json ilegible se reemplaza; buildAppCode ya avisó si declaraba paquetes que no se leen.
  }
  const deps = { ...((base.dependencies as Record<string, string> | undefined) ?? {}) };
  // El SDK lo pone el compilador; un `npm install` no lo encontraría en el registro.
  deps['@cortex/app-sdk'] = undefined as unknown as string;
  Reflect.deleteProperty(deps, '@cortex/app-sdk');
  deps.react = deps.react ?? REACT_VERSION;
  deps['react-dom'] = deps['react-dom'] ?? REACT_VERSION;
  return JSON.stringify(
    {
      name: 'cortex-app-code',
      private: true,
      version: '0.0.0',
      dependencies: deps,
      devDependencies: { esbuild: ESBUILD_VERSION },
    },
    null,
    2,
  );
}

/** El SDK como archivos de un paquete local. `sdkSource` es el JSON {ruta: contenido}. */
function sdkPackageFiles(sdkSource: string): Array<{ path: string; content: string }> {
  let map: Record<string, string>;
  try {
    map = JSON.parse(sdkSource) as Record<string, string>;
  } catch {
    throw new Error('El código fuente del SDK no se pudo leer (sdkSource no es JSON).');
  }
  const dir = `${ROOT}/node_modules/@cortex/app-sdk`;
  return [
    {
      path: `${dir}/package.json`,
      content: JSON.stringify({
        name: '@cortex/app-sdk',
        version: '1.0.0',
        type: 'module',
        main: 'src/index.ts',
        types: 'src/index.ts',
        sideEffects: false,
      }),
    },
    ...Object.entries(map).map(([path, content]) => ({ path: `${dir}/${path}`, content })),
  ];
}

/**
 * El script que corre DENTRO del sandbox: una pasada de esbuild por pantalla.
 * Escribe un JSON {bundles, errors} en vez de imprimir, para no mezclar el
 * resultado con el ruido de npm. `write: false`: los archivos no tocan el disco.
 */
const BUILD_SCRIPT = `
import { build, formatMessages } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const entries = JSON.parse(readFileSync('.cortex-build/entries.json', 'utf8'));
const fnEntries = JSON.parse(readFileSync('.cortex-build/functions.json', 'utf8'));
const MAX_FN = ${MAX_FUNCTION_BUNDLE_BYTES};
const bundles = {};
const functions = {};
const errors = [];
for (const [slug, entry] of Object.entries(entries)) {
  try {
    // La pantalla exporta Screen; algo tiene que montarla. Este envoltorio la
    // monta en #root del marco y, si revienta al pintar, muestra el mensaje en
    // vez de dejar el iframe en blanco.
    const mount = [
      "import Screen from " + JSON.stringify('./' + entry) + ";",
      "import { Component, createElement, useEffect } from 'react';",
      "import { createRoot } from 'react-dom/client';",
      "class Boundary extends Component {",
      "  constructor(p) { super(p); this.state = { error: null }; }",
      "  static getDerivedStateFromError(error) { return { error }; }",
      "  render() {",
      "    if (!this.state.error) return this.props.children;",
      "    return createElement('pre', { style: { padding: 16, color: '#b91c1c', whiteSpace: 'pre-wrap', font: '13px ui-monospace, monospace' } }, 'Esta pantalla tuvo un error: ' + String(this.state.error && this.state.error.message || this.state.error));",
      "  }",
      "}",
      "function Ready() {",
      "  useEffect(() => { try { window.parent.postMessage({ cortex: 1, ready: true }, '*'); } catch (e) {} }, []);",
      "  return null;",
      "}",
      "createRoot(document.getElementById('root')).render(createElement(Boundary, null, createElement(Screen), createElement(Ready)));",
    ].join('\\n');
    const res = await build({
      stdin: { contents: mount, resolveDir: process.cwd(), loader: 'tsx', sourcefile: '__mount.tsx' },
      bundle: true,
      write: false,
      outdir: 'out',
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      jsx: 'automatic',
      minify: true,
      legalComments: 'none',
      logLevel: 'silent',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: {
        '.css': 'css',
        '.png': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.gif': 'dataurl', '.svg': 'dataurl',
        '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl',
      },
    });
    const js = res.outputFiles.filter((f) => f.path.endsWith('.js')).map((f) => f.text).join('\\n');
    const css = res.outputFiles.filter((f) => f.path.endsWith('.css')).map((f) => f.text).join('\\n');
    bundles[slug] = { js, css };
  } catch (err) {
    const msgs = err && err.errors ? await formatMessages(err.errors, { kind: 'error', color: false }) : [String(err)];
    errors.push('Pantalla «' + slug + '» (' + entry + '):\\n' + msgs.join('\\n'));
  }
}
// Funciones de servidor: CommonJS para Node 22, con sus paquetes dentro.
for (const [name, entry] of Object.entries(fnEntries)) {
  try {
    const res = await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      outdir: 'out-server',
      format: 'cjs',
      platform: 'node',
      target: 'node22',
      mainFields: ['module', 'main'],
      sourcemap: 'inline',
      sourcesContent: false,
      legalComments: 'none',
      logLevel: 'silent',
      banner: { js: "const __cortex_import_meta_url = require('url').pathToFileURL(__filename).href;" },
      define: { 'import.meta.url': '__cortex_import_meta_url', 'process.env.NODE_ENV': '"production"' },
    });
    const js = res.outputFiles.filter((f) => f.path.endsWith('.js')).map((f) => f.text).join('\\n');
    if (Buffer.byteLength(js) > MAX_FN) {
      errors.push('Función «' + name + '» (' + entry + '): pesa ' + Math.round(Buffer.byteLength(js) / 1048576) + ' MB con sus paquetes; el tope es ' + Math.round(MAX_FN / 1048576) + ' MB. Usa paquetes más livianos.');
    } else {
      functions[name] = js;
    }
  } catch (err) {
    const msgs = err && err.errors ? await formatMessages(err.errors, { kind: 'error', color: false }) : [String(err)];
    errors.push('Función «' + name + '» (' + entry + '):\\n' + msgs.join('\\n'));
  }
}
mkdirSync('.cortex-build', { recursive: true });
writeFileSync('.cortex-build/result.json', JSON.stringify({ bundles, functions, errors }));
`;

function trim(text: string, max = LOG_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, 3_000)}\n… [recortado] …\n${text.slice(-(max - 3_000))}`;
}

/** Corre un comando y devuelve su salida combinada; no lanza por un código de salida distinto de 0. */
async function exec(
  sandbox: Sandbox,
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  const done = await sandbox.runCommand({ cmd, args, cwd: ROOT, timeoutMs });
  const [stdout, stderr] = await Promise.all([done.stdout(), done.stderr()]);
  return {
    exitCode: done.exitCode,
    output: [stdout, stderr].filter(Boolean).join('\n').trim(),
  };
}

export const sandboxBuilder: Builder = {
  async build(input: BuilderInput): Promise<BuilderOutput> {
    const log: string[] = [];

    // Segunda barrera (la primera es buildAppCode): el sandbox no instala versiones locales ni un package.json roto.
    const problems = packageProblems(input.files);
    if (problems.length) return { ok: false, bundles: {}, functions: {}, log: problems.join('\n') };

    const started = Date.now();
    const sandbox = await Sandbox.create({
      runtime: 'node24',
      timeout: SANDBOX_TIMEOUT_MS,
      resources: { vcpus: 2 },
      persistent: false,
      tags: { purpose: 'app-code-build' },
    });
    try {
      // 1. El proyecto tal cual, más package.json normalizado y las entradas.
      await sandbox.writeFiles([
        ...Object.entries(input.files)
          .filter(([path]) => path !== 'package.json')
          .map(([path, content]) => ({ path: `${ROOT}/${path}`, content })),
        { path: `${ROOT}/package.json`, content: projectPackageJson(input.files) },
        { path: `${ROOT}/.cortex-build/entries.json`, content: JSON.stringify(input.entries) },
        { path: `${ROOT}/.cortex-build/functions.json`, content: JSON.stringify(input.functions) },
        { path: `${ROOT}/.cortex-build/build.mjs`, content: BUILD_SCRIPT },
      ]);

      // 2. npm install. --ignore-scripts: ningún paquete corre código al instalarse.
      const install = await exec(
        sandbox,
        'npm',
        ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'],
        INSTALL_TIMEOUT_MS,
      );
      log.push(`$ npm install (${Math.round((Date.now() - started) / 1000)} s)`);
      if (install.output) log.push(install.output);
      if (install.exitCode !== 0)
        return {
          ok: false,
          bundles: {},
          functions: {},
          log: trim(`${log.join('\n')}\nnpm install falló.`),
        };

      // 2b. Tope de lo instalado: un paquete que baja gigas no se empaqueta.
      const size = await exec(sandbox, 'du', ['-sk', 'node_modules'], 30_000);
      const kb = Number.parseInt(size.output.split(/\s+/)[0] ?? '0', 10);
      if (Number.isFinite(kb) && kb > MAX_INSTALLED_KB)
        return {
          ok: false,
          bundles: {},
          functions: {},
          log: trim(
            `${log.join('\n')}\nLos paquetes instalados pesan ${Math.round(kb / 1024)} MB; el tope es ${Math.round(MAX_INSTALLED_KB / 1024)} MB. Quita los que no uses.`,
          ),
        };

      // 3. El SDK, después de instalar (npm poda lo que no está en package.json).
      await sandbox.writeFiles(sdkPackageFiles(input.sdkSource));

      // 4. esbuild, una pasada por pantalla.
      const built = await exec(sandbox, 'node', ['.cortex-build/build.mjs'], BUILD_TIMEOUT_MS);
      if (built.output) log.push(built.output);
      if (built.exitCode !== 0)
        return {
          ok: false,
          bundles: {},
          functions: {},
          log: trim(`${log.join('\n')}\nesbuild no pudo correr.`),
        };

      const raw = await sandbox.readFileToBuffer({ path: RESULT_PATH });
      if (!raw)
        return {
          ok: false,
          bundles: {},
          functions: {},
          log: trim(`${log.join('\n')}\nSin resultado de esbuild.`),
        };
      const result = JSON.parse(raw.toString('utf8')) as {
        bundles: Record<string, { js: string; css: string }>;
        functions: Record<string, string>;
        errors: string[];
      };
      if (result.errors.length) log.push(...result.errors);
      const ok = result.errors.length === 0;
      if (ok) {
        const parts = [
          ...Object.entries(result.bundles).map(
            ([slug, b]) => `pantalla ${slug} (${Math.round(b.js.length / 1024)} KB)`,
          ),
          ...Object.entries(result.functions ?? {}).map(
            ([name, js]) => `función ${name} (${Math.round(js.length / 1024)} KB)`,
          ),
        ];
        log.push(`Compilado: ${parts.join(', ')}.`);
      }
      return {
        ok,
        bundles: ok ? result.bundles : {},
        functions: ok ? (result.functions ?? {}) : {},
        log: trim(log.join('\n')),
      };
    } catch (err) {
      logger.warn({ err }, 'app-code: sandbox build failed');
      throw err;
    } finally {
      // Si el stop falla, el timeout del sandbox lo termina igual.
      await sandbox.stop().catch(() => undefined);
    }
  },
};

/** Lo que se registra al arrancar para que las herramientas del chat puedan compilar. */
export function buildCodeDeps(): CodeBuildDeps {
  return { builder: sandboxBuilder, sdkSource: JSON.stringify(APP_SDK_FILES) };
}
