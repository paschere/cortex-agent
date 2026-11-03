import { createHash, createHmac } from 'node:crypto';
import { ForbiddenError, ValidationError } from '@cortex/core';
import type { CodeFiles } from './files';

/**
 * LA BASE DE DATOS PROPIA DE UNA APP: LAS PIEZAS PURAS (fase 3, migración 0246).
 *
 * Aquí no hay red ni base: nombres del esquema y del rol, migraciones (orden,
 * suma de comprobación, qué falta aplicar), la guarda de SQL de sólo lectura,
 * las cuentas de la cuota y el tope del resultado. Quien habla con Postgres es
 * un `AppDbDriver` que la app web registra (apps/web/lib/apps/app-db-driver.ts):
 * este paquete no importa `pg`, igual que no importa esbuild ni el Sandbox.
 *
 * MODELO DE SEGURIDAD (por qué es así, no de otro modo):
 *
 *   · El código NUNCA recibe credenciales: ni la pantalla ni la función. Pide
 *     `db.query` por el SDK y es el SERVIDOR de Cortex quien abre la conexión.
 *   · Cada app tiene un esquema `app_<12 hex del id>` y un rol del mismo nombre
 *     que lo posee. La conexión se abre COMO ESE ROL (con una contraseña que sólo
 *     Cortex sabe: se deriva con HMAC, no se guarda), no como el rol de Cortex con
 *     `SET ROLE`: una conexión que empieza siendo el superusuario puede hacer
 *     `RESET ROLE` / `SET ROLE postgres` desde el propio SQL de la app y salir de
 *     su esquema. Un rol que inicia sesión como sí mismo no tiene a dónde subir
 *     ni a qué otra app saltar.
 *   · Lo que cualquier app ve de la base compartida es lo que Postgres da a
 *     PUBLIC (catálogo de nombres, no filas); las tablas de Cortex no tienen
 *     permisos para PUBLIC. Ver la sección «Fase 3» del plan.
 *
 * LA BASE DE LA APP ES DE LA APP, NO DEL ROL DEL USUARIO. A diferencia de las
 * tablas (`trackers`), donde el servidor aplica el rol de quien pregunta, aquí no
 * hay filtro por persona: una función que lee una tabla propia lee TODO lo que
 * hay en ella. Quien programa la función es quien decide qué ve cada rol
 * (`ctx.user.role`, `ctx.user.attributes`).
 */

/** Postgres corta cada sentencia a los 10 s. */
export const DB_STATEMENT_TIMEOUT_MS = 10_000;
/** Una transacción abierta sin hacer nada se cierra a los 15 s. */
export const DB_IDLE_IN_TX_TIMEOUT_MS = 15_000;
/** Una migración puede tardar más que una consulta. */
export const DB_MIGRATION_TIMEOUT_MS = 60_000;
export const DB_MAX_ROWS = 1000;
export const DB_MAX_RESULT_BYTES = 2 * 1024 * 1024;
export const DB_MAX_SQL_CHARS = 50_000;
export const DB_MAX_PARAMS = 100;
export const DB_MAX_PARAM_CHARS = 256 * 1024;
/** Tope del esquema (tablas + índices + toast). */
export const DB_SCHEMA_QUOTA_BYTES = 500 * 1024 * 1024;
/** Llamadas a `db.query` por minuto, por app y persona. */
export const DB_CALLS_PER_MINUTE = 300;
/** El tamaño del esquema se recuerda este tiempo entre escrituras. */
export const DB_SIZE_TTL_MS = 30_000;
export const MAX_MIGRATIONS = 100;

// ---------------------------------------------------------------------------
// Nombres
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const APP_DB_NAME_RE = /^app_[0-9a-f]{12}$/;

/** El esquema y el rol de la app: `app_<primeros 12 hex del id>`. Lanza si el id no es un uuid. */
export function appDbNames(appId: string): { schema: string; role: string } {
  if (!UUID_RE.test(appId)) throw new ValidationError('El id de la app no es válido.');
  const name = `app_${appId.replace(/-/g, '').slice(0, 12).toLowerCase()}`;
  return { schema: name, role: name };
}

/** Un identificador entre comillas para SQL dinámico. Sólo acepta los nombres que fabrica `appDbNames`. */
export function quoteAppIdent(name: string): string {
  if (!APP_DB_NAME_RE.test(name)) throw new Error(`Nombre de esquema inválido: ${name}`);
  return `"${name}"`;
}

/**
 * La contraseña del rol de una app. Se DERIVA (HMAC de JOBS_SECRET con una
 * etiqueta propia y el nombre del rol): no se guarda en ninguna parte y sólo
 * el servidor de Cortex puede calcularla. Si JOBS_SECRET cambia, el driver
 * vuelve a poner las contraseñas al fallar el primer inicio de sesión.
 */
export function appDbPassword(
  role: string,
  secret: string = process.env.JOBS_SECRET ?? '',
): string {
  if (!APP_DB_NAME_RE.test(role)) throw new Error(`Nombre de rol inválido: ${role}`);
  if (!secret.trim())
    throw new Error('JOBS_SECRET is not configured; cannot derive app db passwords');
  const key = createHmac('sha256', secret.trim()).update('cortex.app-db.v1').digest();
  return createHmac('sha256', key).update(role).digest('base64url');
}

// ---------------------------------------------------------------------------
// Migraciones
// ---------------------------------------------------------------------------

export const MIGRATION_DIR = 'db/migrations/';
export const MIGRATION_FILE_RE = /^db\/migrations\/(\d{4})_([a-z0-9][a-z0-9_]{0,60})\.sql$/;

export interface MigrationFile {
  /** Nombre del archivo sin la carpeta: `0001_crear_tablas.sql`. Es la clave de la migración. */
  name: string;
  number: number;
  path: string;
  sql: string;
  checksum: string;
}

export interface AppliedMigration {
  name: string;
  checksum: string;
  appliedAt?: string;
}

/** Suma de comprobación de una migración (los saltos de línea de Windows no cuentan). */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}

/**
 * Las migraciones del proyecto, en orden. `problems` trae, en español, lo que
 * está mal puesto (un archivo en la carpeta con otro nombre, dos con el mismo
 * número, uno vacío); si hay problemas no se aplica nada.
 */
export function listMigrationFiles(files: CodeFiles): {
  migrations: MigrationFile[];
  problems: string[];
} {
  const problems: string[] = [];
  const migrations: MigrationFile[] = [];
  const seen = new Map<number, string>();
  for (const path of Object.keys(files).sort()) {
    if (!path.startsWith(MIGRATION_DIR)) continue;
    const m = MIGRATION_FILE_RE.exec(path);
    if (!m) {
      problems.push(
        `«${path}» no sirve como migración: el nombre es db/migrations/NNNN_descripcion.sql (4 dígitos, minúsculas, números y «_»).`,
      );
      continue;
    }
    const number = Number(m[1]);
    const name = path.slice(MIGRATION_DIR.length);
    const sql = files[path] ?? '';
    if (!sql.trim()) {
      problems.push(`La migración «${name}» está vacía.`);
      continue;
    }
    const clash = seen.get(number);
    if (clash) {
      problems.push(`Las migraciones «${clash}» y «${name}» llevan el mismo número ${m[1]}.`);
      continue;
    }
    seen.set(number, name);
    migrations.push({ name, number, path, sql, checksum: migrationChecksum(sql) });
  }
  migrations.sort((a, b) => a.number - b.number);
  if (migrations.length > MAX_MIGRATIONS)
    problems.push(`Hay ${migrations.length} migraciones; el tope es ${MAX_MIGRATIONS}.`);
  return { migrations, problems };
}

export interface MigrationPlan {
  /** Por aplicar, en orden. */
  pending: MigrationFile[];
  /** Ya aplicadas y sin cambios. */
  upToDate: string[];
  /** Errores que impiden aplicar (archivo cambiado, fuera de orden, problemas de nombre). */
  errors: string[];
  /** Avisos que no impiden nada (una migración aplicada cuyo archivo ya no está). */
  warnings: string[];
}

/**
 * Qué falta aplicar. Reglas:
 *   · cada archivo se aplica UNA vez, en orden de número;
 *   · si un archivo ya aplicado cambió de contenido, es un error (se arregla con
 *     una migración NUEVA, nunca editando la vieja);
 *   · una migración nueva con número MENOR que la última aplicada es un error
 *     (llegaría fuera de orden respecto de lo que ya corrió).
 */
export function planMigrations(files: CodeFiles, applied: AppliedMigration[]): MigrationPlan {
  const { migrations, problems } = listMigrationFiles(files);
  const errors = [...problems];
  const warnings: string[] = [];
  const done = new Map(applied.map((a) => [a.name, a.checksum]));
  const upToDate: string[] = [];
  const pending: MigrationFile[] = [];
  const lastApplied = Math.max(
    -1,
    ...applied.map((a) => Number(/^(\d{4})_/.exec(a.name)?.[1] ?? -1)),
  );
  for (const m of migrations) {
    const sum = done.get(m.name);
    if (sum === undefined) {
      if (m.number < lastApplied)
        errors.push(
          `La migración «${m.name}» es nueva pero su número es menor que el de la última aplicada (${String(lastApplied).padStart(4, '0')}). Renómbrala con un número mayor.`,
        );
      else pending.push(m);
    } else if (sum !== m.checksum) {
      errors.push(
        `La migración «${m.name}» ya se aplicó y su contenido cambió. No se edita una migración aplicada: deja el archivo como estaba y agrega una migración nueva con el cambio.`,
      );
    } else upToDate.push(m.name);
  }
  const present = new Set(migrations.map((m) => m.name));
  for (const a of applied)
    if (!present.has(a.name))
      warnings.push(
        `La migración «${a.name}» ya está aplicada pero su archivo no está en el proyecto.`,
      );
  return { pending, upToDate, errors, warnings };
}

// ---------------------------------------------------------------------------
// SQL: guarda de sólo lectura y clasificación
// ---------------------------------------------------------------------------

/**
 * El SQL sin comentarios y con los textos y los identificadores entre comillas
 * reemplazados por «''» y «""» (para no ver palabras clave ni «;» dentro de un
 * texto). Entiende `--`, comentarios de bloque anidados, 'texto' con '' , E'texto\n' con
 * barra, "identificador" y $etiqueta$ … $etiqueta$. `open` = quedó algo sin cerrar.
 */
export function stripSql(sql: string): { code: string; open: boolean } {
  let out = '';
  let i = 0;
  let open = false;
  const n = sql.length;
  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++;
      out += ' ';
    } else if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth > 0) open = true;
      out += ' ';
    } else if (c === "'") {
      const prev = i > 0 ? (sql[i - 1] as string) : '';
      const escapes = (prev === 'E' || prev === 'e') && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? ' ');
      i++;
      let closed = false;
      while (i < n) {
        if (escapes && sql[i] === '\\') i += 2;
        else if (sql[i] === "'" && sql[i + 1] === "'") i += 2;
        else if (sql[i] === "'") {
          i++;
          closed = true;
          break;
        } else i++;
      }
      if (!closed) open = true;
      out += "''";
    } else if (c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2;
        else if (sql[i] === '"') {
          i++;
          closed = true;
          break;
        } else i++;
      }
      if (!closed) open = true;
      out += '""';
    } else if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      const prev = i > 0 ? (sql[i - 1] as string) : '';
      if (tag && !/[A-Za-z0-9_]/.test(prev)) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        if (end === -1) {
          open = true;
          i = n;
        } else i = end + tag[0].length;
        out += "''";
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return { code: out, open };
}

/** La primera palabra del SQL ya limpio, en minúsculas ('' si no hay). */
function firstWord(code: string): string {
  return (/^\s*\(*\s*([A-Za-z]+)/.exec(code)?.[1] ?? '').toLowerCase();
}

/**
 * Una sola sentencia por llamada. Lanza `ValidationError` si hay más de una, si
 * quedó un texto/comentario sin cerrar o si está vacía. Devuelve el SQL limpio.
 */
export function assertSingleStatement(sql: string): string {
  const { code, open } = stripSql(sql);
  if (open) throw new ValidationError('El SQL tiene un texto, comentario o $$ sin cerrar.');
  const parts = code.split(';').map((p) => p.trim());
  const filled = parts.filter(Boolean);
  if (!filled.length) throw new ValidationError('El SQL está vacío.');
  if (filled.length > 1)
    throw new ValidationError(
      'Una llamada ejecuta UNA sentencia SQL. Separa las demás en llamadas distintas.',
    );
  return filled[0] as string;
}

const READ_WORDS = new Set(['select', 'values', 'table', 'show', 'explain']);
const DELETE_WORDS = new Set(['delete', 'truncate', 'drop', 'vacuum']);

export type StatementKind = 'read' | 'delete' | 'write';

/** Qué clase de sentencia es (para la cuota: con el esquema lleno sólo se lee y se borra). */
export function statementKind(code: string): StatementKind {
  const w = firstWord(code);
  if (READ_WORDS.has(w)) return 'read';
  if (w === 'with') return /\b(insert|update|delete|merge)\b/i.test(code) ? 'write' : 'read';
  if (DELETE_WORDS.has(w)) return 'delete';
  return 'write';
}

/**
 * La guarda del modo SÓLO LECTURA (pantallas y consola de administración): una
 * sentencia que EMPIEZA como consulta. No es la defensa —esa es la transacción
 * `READ ONLY` de Postgres— sino la primera barrera, con un mensaje claro.
 * Rechaza también `EXPLAIN ANALYZE` (ejecuta de verdad) y `SELECT … INTO`.
 */
export function assertReadOnlySql(sql: string): void {
  const code = assertSingleStatement(sql);
  const w = firstWord(code);
  if (!READ_WORDS.has(w) && w !== 'with')
    throw new ForbiddenError(
      'Desde aquí sólo se consulta (SELECT). Para escribir en la base usa una función de servidor.',
    );
  if (w === 'explain' && /\banalyze\b/i.test(code))
    throw new ForbiddenError(
      'EXPLAIN ANALYZE ejecuta la sentencia; en sólo lectura usa EXPLAIN a secas.',
    );
  if (/\binto\b/i.test(code) && w === 'select')
    throw new ForbiddenError('SELECT … INTO crea una tabla: no se permite en sólo lectura.');
}

// ---------------------------------------------------------------------------
// Parámetros, resultado y cuota
// ---------------------------------------------------------------------------

/** Los parámetros ($1, $2…) ya revisados: texto, número, booleano, null u objeto/arreglo (jsonb). */
export function checkDbParams(params: unknown): unknown[] {
  if (params === undefined || params === null) return [];
  if (!Array.isArray(params))
    throw new ValidationError('Los parámetros van en un arreglo: [$1, $2, …].');
  if (params.length > DB_MAX_PARAMS)
    throw new ValidationError(`Una consulta lleva hasta ${DB_MAX_PARAMS} parámetros.`);
  return params.map((p, i) => {
    if (p === undefined) return null;
    if (p === null || typeof p === 'boolean') return p;
    if (typeof p === 'number') {
      if (!Number.isFinite(p))
        throw new ValidationError(`El parámetro $${i + 1} no es un número válido.`);
      return p;
    }
    if (typeof p === 'string') {
      if (p.length > DB_MAX_PARAM_CHARS)
        throw new ValidationError(
          `El parámetro $${i + 1} pasa de ${DB_MAX_PARAM_CHARS / 1024} KB.`,
        );
      return p;
    }
    if (typeof p === 'object') {
      // pg convierte objetos y arreglos a JSON; se hace aquí para medirlo.
      const text = JSON.stringify(p);
      if (text.length > DB_MAX_PARAM_CHARS)
        throw new ValidationError(
          `El parámetro $${i + 1} pasa de ${DB_MAX_PARAM_CHARS / 1024} KB.`,
        );
      return text;
    }
    throw new ValidationError(`El parámetro $${i + 1} no se puede enviar a la base.`);
  });
}

export interface DbResult {
  command: string;
  rowCount: number;
  fields: string[];
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}

/** Recorta las filas a `maxRows` y a `maxBytes` de JSON. */
export function capRows<T>(
  rows: T[],
  maxRows: number = DB_MAX_ROWS,
  maxBytes: number = DB_MAX_RESULT_BYTES,
): { rows: T[]; truncated: boolean } {
  const out: T[] = [];
  let bytes = 2;
  for (const row of rows) {
    if (out.length >= maxRows) return { rows: out, truncated: true };
    const size = Buffer.byteLength(JSON.stringify(row) ?? 'null') + 1;
    if (bytes + size > maxBytes) return { rows: out, truncated: true };
    bytes += size;
    out.push(row);
  }
  return { rows: out, truncated: false };
}

export interface QuotaState {
  usedBytes: number;
  capBytes: number;
  over: boolean;
  /** 0..100 (puede pasar de 100). */
  percent: number;
}

export function quotaState(
  usedBytes: number,
  capBytes: number = DB_SCHEMA_QUOTA_BYTES,
): QuotaState {
  const used = Math.max(0, usedBytes);
  return {
    usedBytes: used,
    capBytes,
    over: used >= capBytes,
    percent: Math.round((used / capBytes) * 100),
  };
}

/** Con el esquema lleno sólo se lee y se borra (para poder liberar espacio). Lanza si la sentencia no cabe. */
export function assertQuotaAllows(q: QuotaState, kind: StatementKind): void {
  if (q.over && kind === 'write')
    throw new ForbiddenError(
      `La base de la app llegó a su tope (${Math.round(q.capBytes / 1024 / 1024)} MB). Mientras tanto sólo se puede leer y borrar datos.`,
    );
}

export function formatDbBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// ---------------------------------------------------------------------------
// Pantallas: ¿pueden consultar?
// ---------------------------------------------------------------------------

/**
 * `package.json` → `"cortex": { "dbFromScreens": true }`. Sin eso, `db.query`
 * sólo se acepta desde funciones de servidor. Con eso, las pantallas pueden
 * hacer SELECT (nunca escribir), y OJO: sin filtro por rol — ver el encabezado.
 */
export function dbFromScreensAllowed(files: CodeFiles): boolean {
  const raw = files['package.json'];
  if (raw === undefined) return false;
  try {
    const json = JSON.parse(raw) as { cortex?: { dbFromScreens?: unknown } };
    return json.cortex?.dbFromScreens === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// El enganche con Postgres
// ---------------------------------------------------------------------------

export interface AppDbTarget {
  schema: string;
  role: string;
}

export interface AppDbRunRequest {
  sql: string;
  params: unknown[];
  readOnly: boolean;
  timeoutMs: number;
  maxRows: number;
  maxBytes: number;
}

export interface AppDbMigrationRequest {
  name: string;
  checksum: string;
  sql: string;
  timeoutMs: number;
}

export interface AppDbDriver {
  /** Revisa que la conexión de Cortex pueda crear roles y esquemas; devuelve el problema en español, o null. */
  preflight(): Promise<string | null>;
  /** Crea el rol (con inicio de sesión y su contraseña derivada) y el esquema si no existen. Idempotente. */
  ensure(target: AppDbTarget): Promise<void>;
  /** ¿Existe el esquema? */
  exists(target: AppDbTarget): Promise<boolean>;
  /** Bytes que ocupa el esquema (tablas, índices y toast). */
  sizeBytes(target: AppDbTarget): Promise<number>;
  /** Una sentencia, COMO el rol de la app, con tope de tiempo. Lanza `ValidationError` con el error de SQL en español. */
  run(target: AppDbTarget, req: AppDbRunRequest): Promise<DbResult>;
  /** Una migración en UNA transacción, junto con su marca dentro del esquema. `false` = la marca ya estaba (no se corrió). */
  migrate(target: AppDbTarget, req: AppDbMigrationRequest): Promise<boolean>;
  /** Borra el esquema (cascade) y el rol. Idempotente. */
  drop(target: AppDbTarget): Promise<void>;
}

/** En `globalThis` por lo mismo que los demás enganches: Next carga el módulo más de una vez. */
const DRIVER_KEY = Symbol.for('cortex.app-db.driver');

export function setAppDbDriver(driver: AppDbDriver | null): void {
  (globalThis as unknown as Record<symbol, AppDbDriver | null>)[DRIVER_KEY] = driver;
}

export function peekAppDbDriver(): AppDbDriver | null {
  return (
    (globalThis as unknown as Record<symbol, AppDbDriver | null | undefined>)[DRIVER_KEY] ?? null
  );
}

export function getAppDbDriver(): AppDbDriver {
  const driver = peekAppDbDriver();
  if (!driver)
    throw new ValidationError(
      'La base de datos propia de las apps no está disponible en este entorno.',
    );
  return driver;
}
