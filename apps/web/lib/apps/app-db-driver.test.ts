import { appDbNames } from '@cortex/agent-tools';
import { ValidationError } from '@cortex/core';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAppDbPoolConfig, createPgAppDbDriver, describeSqlError } from './app-db-driver';

describe('conexión del motor', () => {
  it('quita sslmode y arma el ssl a mano', () => {
    const c = buildAppDbPoolConfig('postgresql://u:p@h:5432/db?sslmode=require');
    expect(c.connectionString).toBe('postgresql://u:p@h:5432/db');
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
  });
  it('sin sslmode no pone ssl', () => {
    expect(buildAppDbPoolConfig('postgresql://u:p@h:5432/db').ssl).toBeUndefined();
  });
  it('cambia el usuario y la contraseña por los del rol de la app', () => {
    const c = buildAppDbPoolConfig('postgresql://u:p@h:5432/db?sslmode=require', {
      user: 'app_aaaaaaaaaaaa',
      password: 'x-y_z',
    });
    expect(c.connectionString).toBe('postgresql://app_aaaaaaaaaaaa:x-y_z@h:5432/db');
  });
});

describe('errores de SQL', () => {
  it('traduce el tiempo vencido, el permiso y los errores de sintaxis', () => {
    expect(describeSqlError({ code: '57014', message: 'x' }, 10_000).message).toMatch(/10 s/);
    expect(
      describeSqlError({ code: '42501', message: 'permission denied for table t' }, 1),
    ).toBeInstanceOf(ValidationError);
    const syn = describeSqlError({ code: '42601', message: 'syntax error at or near "selec"' }, 1);
    expect(syn).toBeInstanceOf(ValidationError);
    expect(syn.message).toContain('42601');
  });
  it('los errores de conexión no se disfrazan de errores de SQL', () => {
    const e = { code: '08006', message: 'conn' };
    expect(describeSqlError(e, 1)).toBe(e);
    const plain = new Error('boom');
    expect(describeSqlError(plain, 1)).toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// Integración contra un Postgres real: APP_DB_TEST_URL=postgresql://postgres:…@localhost:55432/postgres
// ---------------------------------------------------------------------------
const URL = process.env.APP_DB_TEST_URL;

describe.skipIf(!URL)('base propia contra Postgres real', () => {
  const SECRET = 'secreto-de-prueba';
  const A = appDbNames('aaaaaaaa-1111-4111-8111-111111111111');
  const B = appDbNames('bbbbbbbb-2222-4222-8222-222222222222');
  const driver = createPgAppDbDriver({ baseUrl: URL as string, secret: SECRET });
  let admin: Client;
  const run = (t: typeof A, sql: string, params: unknown[] = [], over = {}) =>
    driver.run(t, {
      sql,
      params,
      readOnly: false,
      timeoutMs: 10_000,
      maxRows: 1000,
      maxBytes: 2 * 1024 * 1024,
      ...over,
    });
  const mig = (t: typeof A, name: string, sql: string) =>
    driver.migrate(t, { name, checksum: 'c', sql, timeoutMs: 20_000 });

  beforeAll(async () => {
    admin = new Client({ connectionString: URL });
    await admin.connect();
    await admin.query('drop table if exists public.cortex_secret_t');
    await admin.query(
      "create table public.cortex_secret_t (v text); insert into public.cortex_secret_t values ('top')",
    );
    await admin.query(
      "create or replace function public.cortex_leak() returns text language sql security definer as $$ select 'fuga' $$",
    );
    // Sin endurecer, Cortex se niega a crear bases propias.
    await admin.query('grant usage on schema public to public');
    expect(await driver.preflight()).toMatch(/REVOKE USAGE ON SCHEMA public FROM PUBLIC/);
    // El endurecimiento que el dueño corre una vez (docs/plans/apps-con-codigo.md, Fase 3).
    await admin.query('revoke usage on schema public from public');
    await admin.query(
      "do $$ begin if exists (select 1 from pg_roles where rolname = 'service_role') then grant usage on schema public to service_role; end if; end $$",
    );
    await driver.drop(A);
    await driver.drop(B);
    await driver.ensure(A);
    await driver.ensure(B);
  });
  afterAll(async () => {
    await driver.drop(A);
    await driver.drop(B);
    await admin.query('drop table if exists public.cortex_secret_t');
    await admin.query('drop function if exists public.cortex_leak()');
    await admin.query('grant usage on schema public to public');
    await admin.end();
  });

  it('preflight pasa con el superusuario y ensure es idempotente', async () => {
    expect(await driver.preflight()).toBeNull();
    await driver.ensure(A);
    expect(await driver.exists(A)).toBe(true);
  });

  it('migra una vez, en una transacción, y deshace una migración que falla a medias', async () => {
    expect(
      await mig(
        A,
        '0001_x.sql',
        'create table items (id serial primary key, nombre text not null)',
      ),
    ).toBe(true);
    expect(await mig(A, '0001_x.sql', 'create table items (id int)')).toBe(false); // ya estaba: no corre
    await expect(
      mig(
        A,
        '0002_mala.sql',
        'create table nueva (a int); insert into items (nombre) values (null)',
      ),
    ).rejects.toThrow(/Error de SQL/);
    await expect(run(A, 'select * from nueva')).rejects.toThrow(/Error de SQL/); // la tabla se deshizo
  });

  it('escribe y lee con parámetros; las consultas usan cursor y se recortan', async () => {
    const w = await run(A, 'insert into items (nombre) values ($1) returning id', ['uno']);
    expect(w.rows).toHaveLength(1); // (la secuencia ya gastó un número en la migración que se deshizo)
    const first = (w.rows[0] as { id: number }).id;
    await run(A, "insert into items (nombre) select 'n' || g from generate_series(1, 50) g");
    const r = await run(A, 'select id, nombre from items order by id', [], { maxRows: 10 });
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
    expect(r.fields).toEqual(['id', 'nombre']);
    const p = await run(A, 'select nombre from items where id = $1', [first]);
    expect(p.rows).toEqual([{ nombre: 'uno' }]);
    expect((await run(A, 'select 1 as a')).command).toBe('SELECT');
  });

  it('sólo lectura: rechaza escribir y deshace', async () => {
    await expect(
      run(A, "insert into items (nombre) values ('x')", [], { readOnly: true }),
    ).rejects.toThrow(/25006|read-only/);
    // y no hay forma de volverla de lectura-escritura desde dentro
    await expect(
      run(A, "select set_config('transaction_read_only','off',true)", [], { readOnly: true }).then(
        () => run(A, "insert into items(nombre) values ('y')", [], { readOnly: true }),
      ),
    ).rejects.toThrow();
    const n = await run(A, 'select count(*)::int as n from items');
    expect(n.rows[0]).toEqual({ n: 51 });
  });

  it('no sale de su esquema: ni a public, ni a otra app, ni cambiando de rol', async () => {
    await expect(run(A, 'select * from public.cortex_secret_t')).rejects.toThrow(
      /42501|Permiso denegado/,
    );
    await expect(run(A, 'create table public.pwn (a int)')).rejects.toThrow(
      /Permiso denegado|42501/,
    );
    await mig(B, '0001_b.sql', "create table secreto (v text); insert into secreto values ('b')");
    await expect(run(A, `select * from ${B.schema}.secreto`)).rejects.toThrow(
      /Permiso denegado|42501/,
    );
    // y las funciones SECURITY DEFINER de public (las de Cortex) tampoco se alcanzan
    await expect(run(A, 'select public.cortex_leak()')).rejects.toThrow(/Permiso denegado|42501/);
    await expect(run(A, 'set role postgres')).rejects.toThrow(/Error de SQL|Permiso/);
    await expect(run(A, `set role ${B.role}`)).rejects.toThrow(/Error de SQL|Permiso/);
    await expect(run(A, 'create schema otro')).rejects.toThrow(/Permiso denegado|42501/);
    await expect(run(A, 'create extension if not exists dblink')).rejects.toThrow(
      /Error de SQL|Permiso/,
    );
    await expect(run(A, "copy items to program 'id'")).rejects.toThrow(/Error de SQL|Permiso/);
  });

  it('una sentencia lenta se corta a su tope, también si el SQL se quita el statement_timeout', async () => {
    await expect(run(A, 'select pg_sleep(30)', [], { timeoutMs: 800 })).rejects.toThrow(
      /tardó más/,
    );
    const started = Date.now();
    await expect(
      run(A, 'do $$ begin set statement_timeout = 0; perform pg_sleep(30); end $$', [], {
        timeoutMs: 800,
      }),
    ).rejects.toThrow(/tardó más/);
    expect(Date.now() - started).toBeLessThan(8_000);
    // y el pool sigue sirviendo
    expect((await run(A, 'select 1 as a')).rows).toEqual([{ a: 1 }]);
  });

  it('lo que el SQL deja en la sesión no pasa a la siguiente llamada', async () => {
    await run(A, "set work_mem = '1MB'");
    await run(A, 'create temp table t (a int)');
    await expect(run(A, 'select * from t')).rejects.toThrow(/Error de SQL/);
  });

  it('si la app cambia la contraseña de su rol, Cortex la restablece sola', async () => {
    await run(A, "alter role current_user password 'otra-cosa'");
    // el pool ya tiene conexiones abiertas; se fuerza una nueva cerrando las del rol
    await admin.query('select pg_terminate_backend(pid) from pg_stat_activity where usename = $1', [
      A.role,
    ]);
    expect((await run(A, 'select 2 as a')).rows).toEqual([{ a: 2 }]);
  });

  it('mide el tamaño del esquema', async () => {
    expect(await driver.sizeBytes(A)).toBeGreaterThan(0);
    expect(await driver.sizeBytes(B)).toBeGreaterThan(0);
  });

  it('drop borra esquema y rol, y es idempotente', async () => {
    await driver.drop(B);
    expect(await driver.exists(B)).toBe(false);
    const r = await admin.query('select 1 from pg_roles where rolname = $1', [B.role]);
    expect(r.rowCount).toBe(0);
    await driver.drop(B);
  });
});
