import 'server-only';
import { randomUUID } from 'node:crypto';
import type { FunctionJob, FunctionJobResult, FunctionRunner } from '@cortex/agent-tools';
import { FN_LOG_MAX, capLog, getFunctionRunner, setFunctionRunner } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NetworkPolicy, Sandbox } from '@vercel/sandbox';

/**
 * EL EJECUTOR DE FUNCIONES DE SERVIDOR (fase 2), EN VERCEL SANDBOX.
 *
 * Un sandbox "tibio" por app y compilación (`Sandbox.getOrCreate` por nombre):
 * la primera llamada lo crea y escribe ahí el runner y las funciones ya
 * empaquetadas (node + paquetes npm adentro, no hay `npm install` al correr);
 * las siguientes lo reutilizan y sólo pagan el arranque de `node`. Cada llamada:
 *
 *   1. escribe `jobs/<id>.json` (entrada, secretos, token) y corre
 *      `node runner.cjs jobs/<id>.json` con tope de 60 s;
 *   2. el runner BORRA el archivo del trabajo apenas lo lee (los secretos no se
 *      quedan en disco), arma `ctx` y llama la función;
 *   3. el resultado vuelve por `jobs/<id>.out.json` (no por stdout, que puede
 *      traer ruido del código del usuario): `{ok, result|error, log}`, con el
 *      resultado topado a 1 MB.
 *
 * El sandbox muere solo: nace con 3 minutos y cada llamada lo alarga 2 (a lo
 * sumo una vez por minuto), así que sin uso se apaga a los pocos minutos. No es
 * persistente: nada sobrevive a su muerte.
 *
 * SALIDA A INTERNET. Una función existe para hablar con APIs de terceros
 * (Siigo, un transportista…), así que el dominio no se puede cerrar de antemano:
 * se permite todo MENOS las redes privadas, de enlace local y el metadata del
 * proveedor (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10). El sandbox NO
 * recibe ninguna llave de Cortex: lo único suyo es el token de 5 minutos con el
 * rol de quien la disparó (ver functions.ts). Riesgo que queda: una función
 * puede mandar a internet lo que su rol lee; por eso los roles de reglas y
 * webhooks son explícitos y de mínimo privilegio. Más adelante: lista de
 * dominios por app (`networkPolicy.allow` con nombres).
 */

const ROOT = '/vercel/sandbox';
const IDLE_TIMEOUT_MS = 3 * 60_000;
const KEEPALIVE_MS = 2 * 60_000;
const KEEPALIVE_EVERY_MS = 60_000;
const PRIVATE_SUBNETS = [
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',
  '100.64.0.0/10',
];

const NETWORK_POLICY: NetworkPolicy = {
  allow: { '*': [] },
  subnets: { deny: PRIVATE_SUBNETS },
};

/** El nombre del sandbox tibio: por app y compilación (una compilación nueva = código nuevo = sandbox nuevo). */
export function sandboxNameFor(appId: string, buildId: string): string {
  return `cortex-fn-${appId.replace(/-/g, '')}-${buildId.replace(/-/g, '').slice(0, 8)}`;
}

/** Dónde llama la función a Cortex. Tiene que ser una URL pública que el sandbox alcance. */
export function sdkCallbackUrl(): string {
  const base = (process.env.APP_BASE_URL ?? process.env.BETTER_AUTH_URL ?? '').replace(/\/+$/, '');
  if (!base)
    throw new Error(
      'APP_BASE_URL no está configurada: las funciones no pueden llamar de vuelta a Cortex.',
    );
  return `${base}/api/apps/code/fn-sdk`;
}

/**
 * El script que corre DENTRO del sandbox (CommonJS, sin dependencias). Lee el
 * trabajo, borra su archivo, captura console.*, arma ctx y escribe el resultado.
 */
export const RUNNER_SCRIPT = String.raw`'use strict';
const fs = require('node:fs');
const jobFile = process.argv[2];
const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
try { fs.unlinkSync(jobFile); } catch (e) {}

const LOG_CAP = ${FN_LOG_MAX} * 2;
const logs = [];
let logBytes = 0;
function fmt(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch (e) { return String(a); }
}
function push(level, args) {
  if (logBytes > LOG_CAP) return;
  const line = (level === 'log' ? '' : '[' + level + '] ') + args.map(fmt).join(' ');
  logBytes += line.length + 1;
  logs.push(line);
  if (logBytes > LOG_CAP) logs.push('… [log cortado]');
}
for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...a) => push(level, a);

let finished = false;
function finish(payload) {
  if (finished) return;
  finished = true;
  let text;
  try { text = JSON.stringify(Object.assign({}, payload, { log: logs.join('\n') })); }
  catch (e) { text = JSON.stringify({ ok: false, error: 'El resultado de la función no se puede escribir como JSON.', log: logs.join('\n') }); }
  fs.writeFileSync(job.outFile, text);
  process.exit(0);
}

async function sdk(op, args) {
  const res = await fetch(job.sdkUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + job.token },
    body: JSON.stringify({ op, args }),
    signal: AbortSignal.timeout(45000),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.ok === false) throw new Error((body && body.error) || ('Cortex respondió ' + res.status));
  return body.data;
}
const cortex = {
  user: { me: () => sdk('user.me') },
  tables: {
    list: () => sdk('tables.list'),
    query: (table, opts) => sdk('tables.query', Object.assign({ table }, opts || {})),
    get: (table, id) => sdk('tables.get', { table, id }),
    insert: (table, values) => sdk('tables.insert', { table, values }),
    update: (table, id, values) => sdk('tables.update', { table, id, values }),
    action: (table, id, action, opts) => sdk('tables.action', { table, id, action, reason: opts && opts.reason }),
    listActions: (table) => sdk('tables.listActions', { table }),
  },
  locations: { live: () => sdk('locations.live') },
  geofences: { list: () => sdk('geofences.list') },
  people: { list: (opts) => sdk('people.list', opts || {}) },
  ai: { ask: (prompt, data) => sdk('ai.ask', { prompt, data }) },
  // Base propia de la app (0246): UNA sentencia SQL por llamada, con parámetros $1…
  db: { query: (sql, params) => sdk('db.query', { sql, params: params || [] }) },
};
const ctx = {
  user: job.user,
  cortex,
  db: cortex.db,
  secrets: job.secrets || {},
  log: (...a) => push('log', a),
};

process.on('uncaughtException', (e) => { push('error', [e]); finish({ ok: false, error: String((e && e.message) || e) }); });
process.on('unhandledRejection', (e) => { push('error', [e]); finish({ ok: false, error: String((e && e.message) || e) }); });
setTimeout(() => finish({ ok: false, timedOut: true, error: 'La función tardó más de ' + Math.round(job.timeoutMs / 1000) + ' s.' }), Math.max(1000, job.timeoutMs - 2000));

(async () => {
  try {
    const mod = require('./fn/' + job.name + '.cjs');
    const fn = typeof mod === 'function' ? mod : mod && mod.default;
    if (typeof fn !== 'function') throw new Error('server/' + job.name + '.ts debe exportar por defecto una función: export default async function (input, ctx) { … }');
    const result = await fn(job.input, ctx);
    const text = JSON.stringify(result === undefined ? null : result);
    if (text === undefined || Buffer.byteLength(text) > job.maxOutputBytes)
      throw new Error('El resultado de la función pasa de ' + Math.round(job.maxOutputBytes / 1024) + ' KB.');
    finish({ ok: true, result: JSON.parse(text) });
  } catch (e) {
    push('error', [e]);
    finish({ ok: false, error: String((e && e.message) || e) });
  }
})();
`;

/** Sandboxes tibios de ESTA instancia de la función (un sandbox vivo se reutiliza entre llamadas). */
const warm = new Map<string, Promise<Sandbox>>();
const lastExtend = new Map<string, number>();

async function ensureLoaded(sandbox: Sandbox, job: FunctionJob): Promise<void> {
  const marker = `${ROOT}/.cortex-fn/ready`;
  const have = await sandbox.readFileToBuffer({ path: marker }).catch(() => null);
  if (have && have.toString('utf8') === job.buildId) return;
  await sandbox.writeFiles([
    { path: `${ROOT}/runner.cjs`, content: RUNNER_SCRIPT },
    ...Object.entries(job.functions).map(([name, js]) => ({
      path: `${ROOT}/fn/${name}.cjs`,
      content: js,
    })),
    { path: marker, content: job.buildId },
  ]);
}

async function warmSandbox(job: FunctionJob): Promise<Sandbox> {
  const name = sandboxNameFor(job.appId, job.buildId);
  const cached = warm.get(name);
  if (cached) {
    try {
      const sandbox = await cached;
      await keepAlive(name, sandbox);
      return sandbox;
    } catch {
      warm.delete(name);
    }
  }
  const pending = (async () => {
    const sandbox = await Sandbox.getOrCreate({
      name,
      runtime: 'node24',
      timeout: IDLE_TIMEOUT_MS,
      resources: { vcpus: 1 },
      persistent: false,
      networkPolicy: NETWORK_POLICY,
      tags: { purpose: 'app-function', app: job.appId.slice(0, 8) },
    });
    await ensureLoaded(sandbox, job);
    await keepAlive(name, sandbox);
    return sandbox;
  })();
  warm.set(name, pending);
  pending.catch(() => warm.delete(name));
  return pending;
}

async function keepAlive(name: string, sandbox: Sandbox): Promise<void> {
  const last = lastExtend.get(name) ?? 0;
  if (Date.now() - last < KEEPALIVE_EVERY_MS) return;
  lastExtend.set(name, Date.now());
  await sandbox.extendTimeout(KEEPALIVE_MS).catch(() => undefined);
}

interface RunnerOut {
  ok: boolean;
  result?: unknown;
  error?: string;
  timedOut?: boolean;
  log?: string;
}

async function runOnce(job: FunctionJob): Promise<FunctionJobResult> {
  const sandbox = await warmSandbox(job);
  const id = randomUUID();
  const jobPath = `${ROOT}/jobs/${id}.json`;
  const outPath = `${ROOT}/jobs/${id}.out.json`;
  await sandbox.writeFiles([
    {
      path: jobPath,
      content: JSON.stringify({
        name: job.name,
        input: job.input,
        secrets: job.secrets,
        user: job.user,
        token: job.token,
        sdkUrl: sdkCallbackUrl(),
        outFile: outPath,
        timeoutMs: job.timeoutMs,
        maxOutputBytes: job.maxOutputBytes,
      }),
    },
  ]);
  const started = Date.now();
  let stderr = '';
  let exitCode = 0;
  let killed = false;
  try {
    const done = await sandbox.runCommand({
      cmd: 'node',
      args: ['--enable-source-maps', 'runner.cjs', jobPath],
      cwd: ROOT,
      timeoutMs: job.timeoutMs,
    });
    exitCode = done.exitCode;
    stderr = (await done.stderr().catch(() => '')).slice(-4000);
  } catch (err) {
    // El tope del comando mató el proceso (SIGKILL): la función se pasó de 60 s.
    if (Date.now() - started >= job.timeoutMs - 1500) killed = true;
    else throw err;
  }
  const raw = await sandbox.readFileToBuffer({ path: outPath }).catch(() => null);
  // Sin esperar: el archivo de salida y el de trabajo (si el runner no llegó a borrarlo) no deben quedarse.
  void sandbox
    .runCommand({ cmd: 'rm', args: ['-f', jobPath, outPath], cwd: ROOT, timeoutMs: 10_000 })
    .catch(() => undefined);
  if (raw) {
    try {
      const out = JSON.parse(raw.toString('utf8')) as RunnerOut;
      return {
        ok: out.ok,
        result: out.result,
        error: out.error,
        timedOut: out.timedOut,
        log: capLog(out.log ?? ''),
      };
    } catch {
      // cae a abajo
    }
  }
  if (killed)
    return {
      ok: false,
      timedOut: true,
      error: `La función tardó más de ${Math.round(job.timeoutMs / 1000)} s.`,
      log: '',
    };
  return {
    ok: false,
    error: `La función terminó sin dar resultado (código ${exitCode}).`,
    log: capLog(stderr),
  };
}

export const sandboxFunctionRunner: FunctionRunner = {
  async run(job: FunctionJob): Promise<FunctionJobResult> {
    try {
      return await runOnce(job);
    } catch (err) {
      // El sandbox tibio pudo haber muerto entre dos llamadas: se descarta el cache y se reintenta una vez.
      logger.warn({ err, app: job.appId }, 'app-code: warm sandbox failed, retrying fresh');
      warm.delete(sandboxNameFor(job.appId, job.buildId));
      return runOnce(job);
    }
  },
};

/** Registra el ejecutor si el arranque (instrumentation) no lo hizo: servidor local, pruebas. */
export function ensureFunctionRunner(): void {
  try {
    getFunctionRunner();
  } catch {
    setFunctionRunner(sandboxFunctionRunner);
  }
}
