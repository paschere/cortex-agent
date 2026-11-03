import {
  type AppDbDriver,
  type AppDbMigrationRequest,
  type AppDbRunRequest,
  type AppDbTarget,
  type DbResult,
  appDbPassword,
  assertSingleStatement,
  capRows,
  peekAppDbDriver,
  quoteAppIdent,
  setAppDbDriver,
  statementKind,
} from '@cortex/agent-tools';
import { ValidationError, logger } from '@cortex/core';
import { Pool, type PoolClient, type PoolConfig } from 'pg';

/**
 * EL MOTOR DE LA BASE PROPIA DE CADA APP (fase 3, 0246), SOBRE `pg`.
 *
 * Lo único que conoce las credenciales de Postgres. El código de las apps (una
 * pantalla, una función) nunca las ve: pide `db.query` por el SDK y es esta
 * pieza, en el servidor de Cortex, la que abre la conexión.
 *
 * LA CONEXIÓN SE ABRE COMO EL ROL DE LA APP (`app_<12 hex>`, LOGIN, contraseña
 * derivada con HMAC que no se guarda), NO como Cortex con `SET ROLE`. Razón: si
 * la sesión empieza siendo el superusuario, el SQL de la app puede escribir
 * `RESET ROLE` o `SET ROLE postgres` y salir de su esquema; y con un rol
 * intermedio miembro de todos los roles de apps, saltar a la app de al lado. Un
 * rol que inicia sesión como sí mismo, sin pertenecer a nada, no tiene a dónde
 * subir. El rol de Cortex (`SUPABASE_DB_URL`) sólo se usa para crear/borrar
 * roles y esquemas y para medir el tamaño.
 *
 * Cada llamada es una transacción corta con `search_path`, `statement_timeout`
 * e `idle_in_transaction_session_timeout` fijados con SET LOCAL, y el tope de
 * tiempo del lado del cliente es la defensa de verdad: si la sentencia lo pasa
 * (el SQL puede hacerse `SET statement_timeout = 0`), se mata el backend.
 */

const APP_POOL_MAX_CONNECTIONS = 2;
const APP_POOLS_KEPT = 24;
const CONNECTION_LIMIT_PER_ROLE = 6;
const CLIENT_GRACE_MS = 2_000;

/** El tope del cliente venció: la conexión se descarta sin intentar ROLLBACK (el backend ya se mató). */
class TimedOut extends ValidationError {
  constructor(timeoutMs: number) {
    super(`La sentencia tardó más de ${Math.round(timeoutMs / 1000)} s y se canceló.`);
  }
}

interface PoolLike {
  connect(): Promise<PoolClient>;
  query: Pool['query'];
  end(): Promise<void>;
}

/** Quita `sslmode` de la URL (pg lo toma como verify-full) y arma el SSL a mano, como lib/auth.ts. */
export function buildAppDbPoolConfig(
  rawUrl: string,
  login?: { user: string; password: string },
): PoolConfig {
  const isRemote = /sslmode=/.test(rawUrl);
  const clean = rawUrl
    .replace(/[?&]sslmode=[^&]*/g, (m) => (m.startsWith('?') ? '?' : ''))
    .replace(/\?&/, '?')
    .replace(/\?$/, '');
  const config: PoolConfig = {
    connectionString: clean,
    ...(isRemote ? { ssl: { rejectUnauthorized: false } } : {}),
    connectionTimeoutMillis: 10_000,
  };
  if (login) {
    // El mismo servidor y base, otro usuario: se reescribe el usuario y la contraseña de la URL.
    const url = new URL(clean);
    url.username = encodeURIComponent(login.user);
    url.password = encodeURIComponent(login.password);
    config.connectionString = url.toString();
  }
  return config;
}

interface PgErrorLike {
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
}

/** El error de Postgres en español y con lo que sirve para corregir el SQL. Los que no son de SQL siguen siendo errores del servidor. */
export function describeSqlError(err: unknown, timeoutMs: number): Error {
  if (err instanceof ValidationError) return err;
  const e = err as PgErrorLike;
  if (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) {
    if (e.code === '57014' || e.code === '25P03')
      return new ValidationError(
        `La sentencia tardó más de ${Math.round(timeoutMs / 1000)} s y se canceló.`,
      );
    if (e.code === '42501')
      return new ValidationError(
        `Permiso denegado: el SQL de la app sólo puede tocar su propio esquema. ${e.message ?? ''}`.trim(),
      );
    if (e.code === '53100' || e.code === '53200' || e.code === '53300')
      return new ValidationError(
        'La base no tiene recursos para esta sentencia ahora. Intenta de nuevo.',
      );
    if (
      e.code.startsWith('08') ||
      e.code.startsWith('53') ||
      e.code.startsWith('57') ||
      e.code === '28P01' ||
      e.code === '28000'
    )
      return err as Error;
    const extra = [e.detail, e.hint].filter(Boolean).join(' ');
    return new ValidationError(
      `Error de SQL (${e.code}): ${(e.message ?? '').slice(0, 400)}${extra ? ` ${extra.slice(0, 300)}` : ''}`,
    );
  }
  return err as Error;
}

interface Options {
  /** La URL de Postgres de Cortex (`SUPABASE_DB_URL`). */
  baseUrl: string;
  /** Para pruebas: otra fábrica de pools. */
  poolFactory?: (config: PoolConfig) => PoolLike;
  secret?: string;
}

export function createPgAppDbDriver(opts: Options): AppDbDriver {
  const make = opts.poolFactory ?? ((c: PoolConfig) => new Pool(c) as unknown as PoolLike);
  let admin: PoolLike | null = null;
  // Un pool sin escucha de 'error' tumba el proceso cuando Postgres cierra una conexión ociosa.
  const quiet = (pool: PoolLike, what: string): PoolLike => {
    (pool as unknown as Pool).on?.('error', (err) =>
      logger.warn({ err: String(err?.message ?? err), pool: what }, 'app-db: idle client error'),
    );
    return pool;
  };
  const adminPool = () => {
    admin ??= quiet(
      make({ ...buildAppDbPoolConfig(opts.baseUrl), max: 2, idleTimeoutMillis: 30_000 }),
      'admin',
    );
    return admin;
  };
  // Un pool corto por rol de app, con los más usados recientemente (LRU).
  const pools = new Map<string, PoolLike>();

  function appPool(role: string): PoolLike {
    const hit = pools.get(role);
    if (hit) {
      pools.delete(role);
      pools.set(role, hit);
      return hit;
    }
    const pool = quiet(
      make({
        ...buildAppDbPoolConfig(opts.baseUrl, {
          user: role,
          password: appDbPassword(role, opts.secret),
        }),
        max: APP_POOL_MAX_CONNECTIONS,
        idleTimeoutMillis: 10_000,
      }),
      role,
    );
    pools.set(role, pool);
    while (pools.size > APP_POOLS_KEPT) {
      const oldest = pools.keys().next().value as string;
      const old = pools.get(oldest);
      pools.delete(oldest);
      void old?.end().catch(() => undefined);
    }
    return pool;
  }

  async function dropPool(role: string) {
    const pool = pools.get(role);
    pools.delete(role);
    await pool?.end().catch(() => undefined);
  }

  async function setRolePassword(role: string) {
    const pw = appDbPassword(role, opts.secret);
    if (!/^[A-Za-z0-9_-]+$/.test(pw)) throw new Error('contraseña derivada inesperada');
    await adminPool().query(`ALTER ROLE ${quoteAppIdent(role)} PASSWORD '${pw}'`);
  }

  /** Un cliente del rol de la app. Si la contraseña ya no coincide (cambió JOBS_SECRET o la app la cambió), se vuelve a poner y se reintenta una vez. */
  async function connectAs(target: AppDbTarget): Promise<PoolClient> {
    try {
      return await appPool(target.role).connect();
    } catch (err) {
      if ((err as PgErrorLike).code !== '28P01') throw err;
      logger.warn({ role: target.role }, 'app-db: role password out of sync, resetting');
      await dropPool(target.role);
      await setRolePassword(target.role);
      return appPool(target.role).connect();
    }
  }

  /**
   * Un cliente del rol con la transacción ya abierta (`begin` = BEGIN + SET LOCAL…).
   * Una conexión que el servidor cerró mientras estaba ociosa falla aquí, ANTES de
   * tocar el SQL de la app: se descarta y se reintenta una vez con otra.
   */
  async function openTx(target: AppDbTarget, begin: string): Promise<PoolClient> {
    for (let attempt = 0; ; attempt++) {
      const client = await connectAs(target);
      try {
        await client.query(begin);
        return client;
      } catch (err) {
        client.release(true);
        const code = (err as PgErrorLike).code;
        const connectionLevel = !code || code === '57P01' || code.startsWith('08');
        if (!connectionLevel || attempt >= 1) throw err;
      }
    }
  }

  async function killBackend(client: PoolClient) {
    const pid = (client as unknown as { processID?: number }).processID;
    if (!pid) return;
    await adminPool()
      .query('select pg_terminate_backend($1)', [pid])
      .catch(() => undefined);
  }

  /** Corre `work` con el tope del cliente; si lo pasa, mata el backend y falla con `TimedOut`. */
  async function withClientTimeout<T>(
    client: PoolClient,
    timeoutMs: number,
    work: () => Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void killBackend(client);
        reject(new TimedOut(timeoutMs));
      }, timeoutMs + CLIENT_GRACE_MS);
    });
    try {
      return await Promise.race([work(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Devuelve el cliente al pool limpio de lo que el SQL de la app haya dejado en la sesión. */
  function release(client: PoolClient, broken: boolean) {
    if (broken) return client.release(true);
    client
      .query('DISCARD ALL')
      .then(() => client.release())
      .catch(() => client.release(true));
  }

  const driver: AppDbDriver = {
    async preflight() {
      const { rows } = await adminPool().query(
        `select r.rolsuper, r.rolcreaterole, has_database_privilege(current_database(), 'CREATE') as can_create,
                current_database() as db, current_user as usr,
                exists (
                  select 1 from pg_namespace n,
                         aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                   where n.nspname = 'public' and a.grantee = 0 and a.privilege_type = 'USAGE'
                ) as public_open
           from pg_roles r where r.rolname = current_user`,
      );
      const r = rows[0] as
        | {
            rolsuper?: boolean;
            rolcreaterole?: boolean;
            can_create?: boolean;
            db?: string;
            usr?: string;
            public_open?: boolean;
          }
        | undefined;
      if (!(r?.rolsuper || (r?.rolcreaterole && r?.can_create)))
        return `La conexión de Cortex a Postgres no puede crear roles y esquemas. El dueño debe ejecutar UNA vez, como superusuario: ALTER ROLE "${r?.usr ?? '<usuario de SUPABASE_DB_URL>'}" CREATEROLE; GRANT CREATE ON DATABASE "${r?.db ?? '<base>'}" TO "${r?.usr ?? '<usuario>'}"; (ver docs/plans/apps-con-codigo.md, Fase 3).`;
      // El esquema public es de todos por omisión: sus funciones SECURITY DEFINER se podrían llamar desde el SQL de una app.
      if (r?.public_open)
        return 'Falta el endurecimiento de Postgres para las bases de las apps. El dueño debe ejecutar UNA vez, como superusuario: REVOKE USAGE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role; (ver docs/plans/apps-con-codigo.md, Fase 3).';
      return null;
    },

    async ensure(target) {
      const role = quoteAppIdent(target.role);
      const schema = quoteAppIdent(target.schema);
      const pw = appDbPassword(target.role, opts.secret);
      if (!/^[A-Za-z0-9_-]+$/.test(pw)) throw new Error('contraseña derivada inesperada');
      const pool = adminPool();
      const have = await pool.query('select 1 from pg_roles where rolname = $1', [target.role]);
      if (!have.rowCount) {
        try {
          await pool.query(
            `CREATE ROLE ${role} LOGIN PASSWORD '${pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${CONNECTION_LIMIT_PER_ROLE}`,
          );
        } catch (err) {
          if ((err as PgErrorLike).code !== '42710') throw err; // otro proceso la creó a la vez
        }
      } else {
        await setRolePassword(target.role);
      }
      // Cortex debe poder crear el esquema a nombre del rol y borrarlo después.
      await pool.query(`GRANT ${role} TO CURRENT_USER`);
      await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${role}`);
      await pool.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await pool.query(`ALTER ROLE ${role} SET search_path = ${schema}`);
      await pool.query(`ALTER ROLE ${role} SET statement_timeout = '10s'`);
      await pool.query(`ALTER ROLE ${role} SET lock_timeout = '5s'`);
      await pool.query(`ALTER ROLE ${role} SET idle_in_transaction_session_timeout = '15s'`);
    },

    async exists(target) {
      const r = await adminPool().query('select 1 from pg_namespace where nspname = $1', [
        target.schema,
      ]);
      return Boolean(r.rowCount);
    },

    async sizeBytes(target) {
      // pg_total_relation_size ya suma índices y toast de cada tabla (r) y vista materializada (m).
      const r = await adminPool().query(
        `select coalesce(sum(pg_total_relation_size(c.oid)), 0)::bigint as bytes
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relkind in ('r', 'm')`,
        [target.schema],
      );
      return Number((r.rows[0] as { bytes: string | number } | undefined)?.bytes ?? 0);
    },

    async run(target, req: AppDbRunRequest): Promise<DbResult> {
      const schema = quoteAppIdent(target.schema);
      const begin = `BEGIN${req.readOnly ? ' READ ONLY' : ''}; SET LOCAL search_path = ${schema}; SET LOCAL statement_timeout = ${req.timeoutMs}; SET LOCAL idle_in_transaction_session_timeout = ${req.timeoutMs + 5_000}`;
      const client = await openTx(target, begin).catch((err) => {
        throw describeSqlError(err, req.timeoutMs);
      });
      let broken = false;
      try {
        const value = await withClientTimeout(client, req.timeoutMs, async () => {
          const code = assertSingleStatement(req.sql);
          const kind = statementKind(code);
          const word = (/^\s*\(*\s*([A-Za-z]+)/.exec(code)?.[1] ?? '').toLowerCase();
          // Una consulta se lee con un cursor: nunca se carga en memoria más de lo que cabe en el tope.
          if (kind === 'read' && ['select', 'with', 'values', 'table'].includes(word)) {
            await client.query({
              text: `DECLARE app_cur NO SCROLL CURSOR FOR ${req.sql}`,
              values: req.params,
            });
            const page = await client.query(`FETCH ${req.maxRows + 1} FROM app_cur`);
            await client.query('CLOSE app_cur');
            return page;
          }
          return client.query({ text: req.sql, values: req.params });
        });
        await client.query(req.readOnly ? 'ROLLBACK' : 'COMMIT');
        const capped = capRows(
          value.rows as Array<Record<string, unknown>>,
          req.maxRows,
          req.maxBytes,
        );
        return {
          command: value.command === 'FETCH' ? 'SELECT' : value.command,
          rowCount:
            value.command === 'FETCH' ? capped.rows.length : (value.rowCount ?? capped.rows.length),
          fields: (value.fields ?? []).map((f) => f.name),
          rows: capped.rows,
          truncated: capped.truncated || value.rows.length > req.maxRows,
        };
      } catch (err) {
        broken = true;
        if (!(err instanceof TimedOut))
          await client.query('ROLLBACK').then(
            () => {
              broken = false;
            },
            () => undefined,
          );
        throw describeSqlError(err, req.timeoutMs);
      } finally {
        release(client, broken);
      }
    },

    async migrate(target, req: AppDbMigrationRequest) {
      const schema = quoteAppIdent(target.schema);
      const client = await openTx(
        target,
        `BEGIN; SET LOCAL search_path = ${schema}; SET LOCAL statement_timeout = ${req.timeoutMs}; SET LOCAL lock_timeout = 10000`,
      ).catch((err) => {
        throw describeSqlError(err, req.timeoutMs);
      });
      let broken = false;
      try {
        const done = await withClientTimeout(client, req.timeoutMs, async () => {
          // Dos aplicaciones a la vez de la misma app: la segunda espera y luego ve la marca.
          await client.query('select pg_advisory_xact_lock(hashtext($1))', [target.schema]);
          await client.query(
            'create table if not exists __cortex_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())',
          );
          const seen = await client.query('select 1 from __cortex_migrations where name = $1', [
            req.name,
          ]);
          if (seen.rowCount) return false;
          await client.query(req.sql);
          await client.query('insert into __cortex_migrations (name, checksum) values ($1, $2)', [
            req.name,
            req.checksum,
          ]);
          return true;
        });
        await client.query('COMMIT');
        return done;
      } catch (err) {
        broken = true;
        if (!(err instanceof TimedOut))
          await client.query('ROLLBACK').then(
            () => {
              broken = false;
            },
            () => undefined,
          );
        throw describeSqlError(err, req.timeoutMs);
      } finally {
        release(client, broken);
      }
    },

    async drop(target) {
      const role = quoteAppIdent(target.role);
      const schema = quoteAppIdent(target.schema);
      const pool = adminPool();
      await dropPool(target.role);
      // Fuera las sesiones abiertas del rol; sin ellas DROP ROLE falla.
      await pool.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where usename = $1',
        [target.role],
      );
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      const have = await pool.query('select 1 from pg_roles where rolname = $1', [target.role]);
      if (have.rowCount) {
        await pool.query(`DROP OWNED BY ${role}`);
        await pool.query(`DROP ROLE ${role}`);
      }
    },
  };
  return driver;
}

let singleton: AppDbDriver | null = null;

/** El motor real, con la URL de Postgres de Cortex; null si el entorno no la trae. */
export function appDbDriverFromEnv(): AppDbDriver | null {
  const url = (process.env.SUPABASE_DB_URL ?? '').trim();
  if (!url) return null;
  singleton ??= createPgAppDbDriver({ baseUrl: url });
  return singleton;
}

/** Registra el motor si el arranque (instrumentation) no lo hizo: servidor local, pruebas. */
export function ensureAppDbDriver(): void {
  if (!peekAppDbDriver()) setAppDbDriver(appDbDriverFromEnv());
}
