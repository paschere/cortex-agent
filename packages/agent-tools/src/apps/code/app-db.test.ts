import { ForbiddenError, ValidationError } from '@cortex/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import {
  type AppDbDriver,
  type AppDbRunRequest,
  DB_SCHEMA_QUOTA_BYTES,
  appDbNames,
  appDbPassword,
  assertQuotaAllows,
  assertReadOnlySql,
  assertSingleStatement,
  capRows,
  checkDbParams,
  dbFromScreensAllowed,
  listMigrationFiles,
  migrationChecksum,
  planMigrations,
  quotaState,
  setAppDbDriver,
  statementKind,
  stripSql,
} from './app-db';
import { publishAppCodeWithMigrations } from './app-db-publish';
import {
  appDbStatus,
  applyAppDbMigrations,
  dropAppDb,
  forgetDbSize,
  getAppDbRow,
  listAppliedMigrations,
  runAppDbQuery,
} from './app-db-store';
import { type FnTokenClaims, mintFnToken, verifyFnToken } from './functions';
import { runSdkOp } from './sdk';

const APP = '11111111-1111-4111-8111-111111111111';
const ORG = 'org-postal';

describe('nombres y contraseña', () => {
  it('el esquema es app_ + 12 hex del id, y el rol se llama igual', () => {
    expect(appDbNames(APP)).toEqual({ schema: 'app_111111111111', role: 'app_111111111111' });
    expect(() => appDbNames('no-es-uuid')).toThrow();
    expect(() => appDbNames("1'; drop")).toThrow();
  });
  it('la contraseña se deriva: estable, distinta por rol y por secreto, y segura para SQL', () => {
    const a = appDbPassword('app_111111111111', 's1');
    expect(a).toBe(appDbPassword('app_111111111111', 's1'));
    expect(a).not.toBe(appDbPassword('app_222222222222', 's1'));
    expect(a).not.toBe(appDbPassword('app_111111111111', 's2'));
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => appDbPassword('postgres', 's1')).toThrow();
    expect(() => appDbPassword('app_111111111111', '  ')).toThrow();
  });
});

describe('migraciones: orden y checksum', () => {
  const f = (n: string, sql = 'select 1') => [`db/migrations/${n}.sql`, sql] as const;
  it('las lista en orden de número y calcula el checksum sin contar \\r\\n', () => {
    const { migrations, problems } = listMigrationFiles(
      Object.fromEntries([
        f('0002_b'),
        f('0001_a', 'create table t(a int);\r\n'),
        ['screens/x.tsx', ''],
      ]),
    );
    expect(problems).toEqual([]);
    expect(migrations.map((m) => m.name)).toEqual(['0001_a.sql', '0002_b.sql']);
    expect(migrations[0]?.checksum).toBe(migrationChecksum('create table t(a int);\n'));
  });
  it('avisa de nombres malos, números repetidos y archivos vacíos', () => {
    const { migrations, problems } = listMigrationFiles(
      Object.fromEntries([f('0001_a'), f('0001_otra'), f('Mala'), f('0003_vacia', '  ')]),
    );
    expect(migrations).toHaveLength(1);
    expect(problems).toHaveLength(3);
  });
  it('planea: una vez, en orden; cambiada = error; nueva fuera de orden = error', () => {
    const files = Object.fromEntries([f('0001_a', 'A'), f('0002_b', 'B'), f('0004_d', 'D')]);
    const ok = planMigrations(files, [{ name: '0001_a.sql', checksum: migrationChecksum('A') }]);
    expect(ok.pending.map((m) => m.name)).toEqual(['0002_b.sql', '0004_d.sql']);
    expect(ok.upToDate).toEqual(['0001_a.sql']);
    expect(ok.errors).toEqual([]);

    const changed = planMigrations(files, [{ name: '0001_a.sql', checksum: 'otra' }]);
    expect(changed.errors[0]).toMatch(/cambió/);

    const late = planMigrations(Object.fromEntries([f('0002_b', 'B'), f('0003_c', 'C')]), [
      { name: '0004_d.sql', checksum: 'x' },
    ]);
    expect(late.errors.join(' ')).toMatch(/menor/);
    expect(late.warnings.join(' ')).toMatch(/0004_d/);
  });
});

describe('guarda de SQL', () => {
  it('stripSql ignora comentarios, textos, identificadores y $$', () => {
    const s = stripSql(
      'select \'a;b\', "x;y" -- ; insert\n/* ; /* anidado */ drop */ from $f$ ; $f$ t',
    );
    expect(s.open).toBe(false);
    expect(s.code).not.toMatch(/;|insert|drop/);
    expect(stripSql("select 'sin cerrar").open).toBe(true);
    expect(stripSql('select $$ sin cerrar').open).toBe(true);
    expect(stripSql("select E'it\\'s ; ok'").code).not.toContain(';');
  });
  it('una sola sentencia por llamada', () => {
    expect(assertSingleStatement('select 1;')).toBe('select 1');
    expect(assertSingleStatement("select ';' ")).toContain('select');
    expect(() => assertSingleStatement('select 1; select 2')).toThrow(ValidationError);
    expect(() => assertSingleStatement('  ;  ')).toThrow(/vacío/);
    expect(() => assertSingleStatement("select 'x")).toThrow(/sin cerrar/);
  });
  it('sólo lectura: deja consultar y rechaza todo lo demás', () => {
    for (const ok of [
      'select 1',
      '  SELECT * from t',
      'with a as (select 1) select * from a',
      '(select 1)',
      'values (1)',
      'explain select 1',
      '-- hola\nselect 1',
    ])
      expect(() => assertReadOnlySql(ok)).not.toThrow();
    for (const bad of [
      'insert into t values (1)',
      'update t set a = 1',
      'delete from t',
      'drop table t',
      'create table x (a int)',
      'set role postgres',
      'reset role',
      'copy t to program x',
      'call p()',
      'explain analyze select 1',
      'select * into nueva from t',
      'select 1; drop table t',
      'do $$ begin end $$',
    ])
      expect(() => assertReadOnlySql(bad), bad).toThrow();
    expect(() => assertReadOnlySql('delete from t')).toThrow(ForbiddenError);
  });
  it('clasifica las sentencias para la cuota', () => {
    expect(statementKind('select 1')).toBe('read');
    expect(statementKind('with a as (select 1) select * from a')).toBe('read');
    expect(statementKind('with a as (delete from t returning *) select * from a')).toBe('write');
    expect(statementKind('delete from t')).toBe('delete');
    expect(statementKind('truncate t')).toBe('delete');
    expect(statementKind('insert into t values (1)')).toBe('write');
    expect(statementKind('create table t (a int)')).toBe('write');
  });
});

describe('parámetros, resultado y cuota', () => {
  it('revisa los parámetros', () => {
    expect(checkDbParams(undefined)).toEqual([]);
    expect(checkDbParams([1, 'a', null, true, undefined, { a: 1 }, [1]])).toEqual([
      1,
      'a',
      null,
      true,
      null,
      '{"a":1}',
      '[1]',
    ]);
    expect(() => checkDbParams('x')).toThrow();
    expect(() => checkDbParams(new Array(101).fill(1))).toThrow(/hasta 100/);
    expect(() => checkDbParams([Number.NaN])).toThrow();
    expect(() => checkDbParams(['x'.repeat(300_000)])).toThrow(/KB/);
  });
  it('recorta por filas y por bytes', () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ i }));
    expect(capRows(rows)).toMatchObject({ truncated: true });
    expect(capRows(rows).rows).toHaveLength(1000);
    expect(capRows([{ a: 1 }, { a: 2 }]).truncated).toBe(false);
    const big = [{ t: 'x'.repeat(600) }, { t: 'x'.repeat(600) }, { t: 'x'.repeat(600) }];
    const cut = capRows(big, 1000, 1500);
    expect(cut.rows).toHaveLength(2);
    expect(cut.truncated).toBe(true);
  });
  it('la cuota: con el esquema lleno sólo se lee y se borra', () => {
    expect(quotaState(DB_SCHEMA_QUOTA_BYTES / 2)).toMatchObject({ over: false, percent: 50 });
    const full = quotaState(DB_SCHEMA_QUOTA_BYTES);
    expect(full.over).toBe(true);
    expect(() => assertQuotaAllows(full, 'write')).toThrow(ForbiddenError);
    expect(() => assertQuotaAllows(full, 'read')).not.toThrow();
    expect(() => assertQuotaAllows(full, 'delete')).not.toThrow();
    expect(() => assertQuotaAllows(quotaState(10), 'write')).not.toThrow();
  });
  it('dbFromScreens sólo con true exacto en el package.json', () => {
    const pkg = (c: unknown) => ({ 'package.json': JSON.stringify({ cortex: c }) });
    expect(dbFromScreensAllowed(pkg({ dbFromScreens: true }))).toBe(true);
    expect(dbFromScreensAllowed(pkg({ dbFromScreens: 'true' }))).toBe(false);
    expect(dbFromScreensAllowed(pkg({}))).toBe(false);
    expect(dbFromScreensAllowed({})).toBe(false);
    expect(dbFromScreensAllowed({ 'package.json': '{no json' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Con una base falsa y un motor falso
// ---------------------------------------------------------------------------

interface Call {
  op: string;
  arg?: unknown;
}

function fakeDriver(over: Partial<AppDbDriver> = {}) {
  const calls: Call[] = [];
  const marks = new Set<string>();
  let size = 1000;
  const driver: AppDbDriver = {
    async preflight() {
      calls.push({ op: 'preflight' });
      return null;
    },
    async ensure(t) {
      calls.push({ op: 'ensure', arg: t });
    },
    async exists() {
      return true;
    },
    async sizeBytes() {
      return size;
    },
    async run(t, req: AppDbRunRequest) {
      calls.push({ op: 'run', arg: { t, req } });
      return { command: 'SELECT', rowCount: 1, fields: ['a'], rows: [{ a: 1 }], truncated: false };
    },
    async migrate(_t, req) {
      calls.push({ op: 'migrate', arg: req.name });
      if (/BOOM/.test(req.sql)) throw new ValidationError('Error de SQL (42601): sintaxis');
      if (marks.has(req.name)) return false;
      marks.add(req.name);
      return true;
    },
    async drop(t) {
      calls.push({ op: 'drop', arg: t });
    },
    ...over,
  };
  return {
    driver,
    calls,
    setSize: (n: number) => {
      size = n;
    },
    marks,
  };
}

function world(files: Record<string, string> = {}, publishedFiles?: Record<string, string>) {
  const fake = createFakeSupabase({
    custom_app_db: [],
    custom_app_db_migrations: [],
    custom_app_code: [
      {
        id: 'code-1',
        organization_id: ORG,
        app_id: APP,
        files,
        file_meta: {},
        sdk_version: '1',
        published_build_id: null,
        updated_by: 'u1',
        updated_at: '2026-10-01T00:00:00Z',
        created_at: '2026-10-01T00:00:00Z',
      },
    ],
    custom_app_code_builds: publishedFiles
      ? [
          {
            id: 'b1',
            organization_id: ORG,
            code_id: 'code-1',
            number: 1,
            files: publishedFiles,
            bundles: {},
            functions: {},
            status: 'ok',
            log: '',
            created_by: 'u1',
            created_at: '2026-10-01T00:00:00Z',
          },
        ]
      : [],
  });
  return createOrgScopedClient(fake.client, ORG);
}

const M1 = { 'db/migrations/0001_init.sql': 'create table t (a int);' };
const M12 = { ...M1, 'db/migrations/0002_mas.sql': 'create table u (a int);' };

describe('aplicar migraciones', () => {
  afterEach(() => setAppDbDriver(null));

  it('crea el esquema la primera vez, aplica en orden, anota y no repite', async () => {
    const { driver, calls } = fakeDriver();
    setAppDbDriver(driver);
    const db = world(M12);
    const out = await applyAppDbMigrations(db, APP, M12, 'u1');
    expect(out.applied).toEqual(['0001_init.sql', '0002_mas.sql']);
    expect(calls.filter((c) => c.op === 'migrate').map((c) => c.arg)).toEqual([
      '0001_init.sql',
      '0002_mas.sql',
    ]);
    expect(calls.filter((c) => c.op === 'ensure')).toHaveLength(1);
    expect((await getAppDbRow(db, APP))?.schema_name).toBe('app_111111111111');
    expect((await listAppliedMigrations(db, APP)).map((m) => m.name)).toEqual([
      '0001_init.sql',
      '0002_mas.sql',
    ]);

    calls.length = 0;
    const again = await applyAppDbMigrations(db, APP, M12, 'u1');
    expect(again.applied).toEqual([]);
    expect(calls).toEqual([]); // sin pendientes no se toca Postgres
  });

  it('un archivo aplicado que cambió es un error y no corre nada', async () => {
    const { driver, calls } = fakeDriver();
    setAppDbDriver(driver);
    const db = world(M1);
    await applyAppDbMigrations(db, APP, M1, 'u1');
    calls.length = 0;
    await expect(
      applyAppDbMigrations(
        db,
        APP,
        {
          'db/migrations/0001_init.sql': 'create table t (a text);',
          'db/migrations/0002_x.sql': 'select 1',
        },
        'u1',
      ),
    ).rejects.toThrow(/cambió/);
    expect(calls).toEqual([]);
  });

  it('si una falla se detiene ahí, queda anotada la anterior y el error nombra la migración', async () => {
    const { driver } = fakeDriver();
    setAppDbDriver(driver);
    const files = {
      ...M1,
      'db/migrations/0002_mala.sql': 'BOOM',
      'db/migrations/0003_c.sql': 'select 1',
    };
    const db = world(files);
    await expect(applyAppDbMigrations(db, APP, files, 'u1')).rejects.toThrow(
      /0002_mala\.sql.*se deshizo.*42601.*0001_init/s,
    );
    expect((await listAppliedMigrations(db, APP)).map((m) => m.name)).toEqual(['0001_init.sql']);
    // al corregirla (mismo nombre, aún no aplicada) sigue
    const fixed = { ...files, 'db/migrations/0002_mala.sql': 'select 2' };
    expect((await applyAppDbMigrations(db, APP, fixed, 'u1')).applied).toEqual([
      '0002_mala.sql',
      '0003_c.sql',
    ]);
  });

  it('si la marca del esquema ya estaba (se cayó antes de anotar), sólo se anota', async () => {
    const { driver, marks } = fakeDriver();
    setAppDbDriver(driver);
    marks.add('0001_init.sql');
    const db = world(M1);
    const out = await applyAppDbMigrations(db, APP, M1, 'u1');
    expect(out.applied).toEqual([]);
    expect((await listAppliedMigrations(db, APP)).map((m) => m.name)).toEqual(['0001_init.sql']);
  });

  it('con el esquema lleno no migra; sin motor lo dice', async () => {
    const { driver, setSize } = fakeDriver();
    setAppDbDriver(driver);
    setSize(DB_SCHEMA_QUOTA_BYTES + 1);
    await expect(applyAppDbMigrations(world(M1), APP, M1, 'u1')).rejects.toThrow(/tope/);
    setAppDbDriver(null);
    await expect(applyAppDbMigrations(world(M1), APP, M1, 'u1')).rejects.toThrow(
      /no está disponible/,
    );
  });

  it('un problema del preflight (sin permiso de crear roles) llega con lo que debe hacer el dueño', async () => {
    const { driver } = fakeDriver({ preflight: async () => 'ejecuta ALTER ROLE x CREATEROLE' });
    setAppDbDriver(driver);
    await expect(applyAppDbMigrations(world(M1), APP, M1, 'u1')).rejects.toThrow(/CREATEROLE/);
  });

  it('el estado cuenta aplicadas, pendientes y errores', async () => {
    const { driver } = fakeDriver();
    setAppDbDriver(driver);
    const db = world(M12);
    await applyAppDbMigrations(db, APP, M1, 'u1');
    const st = await appDbStatus(db, APP, M12);
    expect(st).toMatchObject({
      schema: 'app_111111111111',
      exists: true,
      available: true,
      pending: ['0002_mas.sql'],
      errors: [],
    });
    expect(st.migrations.map((m) => m.name)).toEqual(['0001_init.sql']);
  });
});

describe('publicar aplica las migraciones de esa compilación', () => {
  afterEach(() => setAppDbDriver(null));
  it('aplica y publica; si falla, no publica', async () => {
    const { driver } = fakeDriver();
    setAppDbDriver(driver);
    const db = world({}, M1);
    const out = await publishAppCodeWithMigrations(db, APP, 'b1', 'u1');
    expect(out.migrationsApplied).toEqual(['0001_init.sql']);
    expect(out.code.published_build_id).toBe('b1');

    const bad = world({}, { 'db/migrations/0001_mala.sql': 'BOOM' });
    await expect(publishAppCodeWithMigrations(bad, APP, 'b1', 'u1')).rejects.toThrow(/se deshizo/);
    const code = await bad
      .from('custom_app_code')
      .select('published_build_id')
      .eq('app_id', APP)
      .maybeSingle();
    expect((code.data as { published_build_id: string | null }).published_build_id).toBeNull();
  });
  it('sin archivos de migración no hace falta motor', async () => {
    setAppDbDriver(null);
    const db = world({}, { 'screens/x.tsx': 'x' });
    const out = await publishAppCodeWithMigrations(db, APP, 'b1', 'u1');
    expect(out.migrationsApplied).toEqual([]);
  });
});

describe('consultar', () => {
  beforeEach(() => forgetDbSize());
  afterEach(() => setAppDbDriver(null));

  async function withDb(setSizeTo?: number) {
    const f = fakeDriver();
    setAppDbDriver(f.driver);
    const db = world(M1);
    await applyAppDbMigrations(db, APP, M1, 'u1');
    f.calls.length = 0;
    if (setSizeTo !== undefined) f.setSize(setSizeTo);
    forgetDbSize();
    return { db, ...f };
  }

  it('sin base propia lo dice; con ella pasa SQL, parámetros y modo al motor', async () => {
    setAppDbDriver(fakeDriver().driver);
    await expect(runAppDbQuery(world(), APP, { sql: 'select 1', readOnly: true })).rejects.toThrow(
      /todavía no tiene base/,
    );
    const { db, calls } = await withDb();
    const r = await runAppDbQuery(db, APP, {
      sql: 'select * from t where a = $1',
      params: [7],
      readOnly: true,
    });
    expect(r.rows).toEqual([{ a: 1 }]);
    const call = calls.find((c) => c.op === 'run')?.arg as {
      t: { role: string };
      req: AppDbRunRequest;
    };
    expect(call.t.role).toBe('app_111111111111');
    expect(call.req).toMatchObject({
      params: [7],
      readOnly: true,
      timeoutMs: 10_000,
      maxRows: 1000,
    });
  });

  it('en sólo lectura no deja pasar escrituras ni varias sentencias (sin tocar el motor)', async () => {
    const { db, calls } = await withDb();
    await expect(
      runAppDbQuery(db, APP, { sql: 'delete from t', readOnly: true }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      runAppDbQuery(db, APP, { sql: 'select 1; select 2', readOnly: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls.some((c) => c.op === 'run')).toBe(false);
  });

  it('con el esquema lleno se lee y se borra, pero no se escribe', async () => {
    const { db } = await withDb(DB_SCHEMA_QUOTA_BYTES + 5);
    await expect(
      runAppDbQuery(db, APP, { sql: 'insert into t values (1)', readOnly: false }),
    ).rejects.toThrow(/tope/);
    await expect(
      runAppDbQuery(db, APP, { sql: 'select 1', readOnly: false }),
    ).resolves.toBeTruthy();
    await expect(
      runAppDbQuery(db, APP, { sql: 'delete from t', readOnly: false }),
    ).resolves.toBeTruthy();
  });
});

describe('borrar la app borra su base', () => {
  afterEach(() => setAppDbDriver(null));
  it('sin base no toca Postgres; con base borra esquema y rol', async () => {
    const { driver, calls } = fakeDriver();
    setAppDbDriver(driver);
    const db = world(M1);
    expect(await dropAppDb(db, APP)).toBe(false);
    expect(calls).toEqual([]);
    await applyAppDbMigrations(db, APP, M1, 'u1');
    calls.length = 0;
    expect(await dropAppDb(db, APP)).toBe(true);
    expect(calls).toEqual([
      { op: 'drop', arg: { schema: 'app_111111111111', role: 'app_111111111111' } },
    ]);
  });
  it('con base y sin motor se niega (no deja datos huérfanos); si el motor falla, lanza', async () => {
    const f = fakeDriver();
    setAppDbDriver(f.driver);
    const db = world(M1);
    await applyAppDbMigrations(db, APP, M1, 'u1');
    setAppDbDriver(null);
    await expect(dropAppDb(db, APP)).rejects.toBeInstanceOf(ForbiddenError);
    setAppDbDriver(
      fakeDriver({
        drop: async () => {
          throw new Error('boom');
        },
      }).driver,
    );
    await expect(dropAppDb(db, APP)).rejects.toThrow('boom');
  });
});

describe('db.query por el SDK', () => {
  afterEach(() => setAppDbDriver(null));

  // Un acceso mínimo: runSdkOp sólo usa app.id y user.id en esta operación.
  const access = {
    app: { id: APP },
    user: { id: 'u-ana', name: 'Ana', attributes: {} },
    role: { key: 'operario', name: 'Operario', admin: false, permissions: { tables: {} } },
    screens: [],
  } as never;

  async function ready(files: Record<string, string>) {
    const f = fakeDriver();
    setAppDbDriver(f.driver);
    const db = world(files);
    await applyAppDbMigrations(db, APP, M1, 'u1');
    forgetDbSize();
    f.calls.length = 0;
    return { db, ...f };
  }

  it('desde una pantalla está apagado por omisión', async () => {
    const { db } = await ready(M1);
    await expect(runSdkOp(db, access, 'db.query', { sql: 'select 1' })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
  it('desde una pantalla con dbFromScreens sólo lee, aunque pida escribir', async () => {
    const files = { ...M1, 'package.json': JSON.stringify({ cortex: { dbFromScreens: true } }) };
    const { db, calls } = await ready(files);
    await expect(runSdkOp(db, access, 'db.query', { sql: 'select 1' })).resolves.toMatchObject({
      rows: [{ a: 1 }],
    });
    expect((calls.at(-1)?.arg as { req: AppDbRunRequest }).req.readOnly).toBe(true);
    await expect(
      runSdkOp(db, access, 'db.query', { sql: 'insert into t values (1)' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('desde una función escribe; con «Ver como…» sólo lee', async () => {
    const { db, calls } = await ready(M1);
    await runSdkOp(
      db,
      access,
      'db.query',
      { sql: 'insert into t values ($1)', params: [1] },
      { via: 'function' },
    );
    expect((calls.at(-1)?.arg as { req: AppDbRunRequest }).req.readOnly).toBe(false);
    await expect(
      runSdkOp(
        db,
        access,
        'db.query',
        { sql: 'insert into t values (1)' },
        { via: 'function', readOnly: true },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
  it('valida los argumentos', async () => {
    const { db } = await ready(M1);
    await expect(
      runSdkOp(db, access, 'db.query', { sql: '' }, { via: 'function' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      runSdkOp(db, access, 'db.query', { sql: 'select 1', params: 'x' }, { via: 'function' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('la cadena anti-bucle viaja en el token de la función', () => {
  beforeEach(() => {
    process.env.JOBS_SECRET = 'secreto-de-prueba';
  });
  const base: Omit<FnTokenClaims, 'v' | 'exp'> = {
    org: ORG,
    app: APP,
    actor: { kind: 'member', id: 'u1', name: 'Regla' },
    role: 'operario',
    attributes: {},
    readOnly: false,
    fn: 'cobrar',
  };
  it('cadena y profundidad firmadas viajan y se recuperan', () => {
    const t = mintFnToken({ ...base, chain: ['r1', 'r2'], depth: 2 }, 1_000);
    expect(verifyFnToken(t, 2_000)).toMatchObject({ chain: ['r1', 'r2'], depth: 2 });
  });
  it('sin cadena vuelve vacía; una cadena rara se sanea; alterarla invalida la firma', () => {
    expect(verifyFnToken(mintFnToken(base, 1_000), 2_000)).toMatchObject({ chain: [], depth: 0 });
    const odd = mintFnToken({ ...base, chain: ['a', 5 as never, 'b'], depth: -3 }, 1_000);
    expect(verifyFnToken(odd, 2_000)).toMatchObject({ chain: ['a', 'b'], depth: 0 });
    const t = mintFnToken({ ...base, chain: ['r1'], depth: 1 }, 1_000);
    const [payload, sig] = t.split('.') as [string, string];
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString());
    forged.chain = [];
    forged.depth = 0;
    expect(
      verifyFnToken(`${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`, 2_000),
    ).toBeNull();
  });
});
