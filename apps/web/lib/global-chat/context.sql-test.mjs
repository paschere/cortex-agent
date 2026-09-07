import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from '../../node_modules/typescript/lib/typescript.js';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`create type user_role as enum ('member','team_admin','org_admin');
 create table ba_user(id text primary key,email text,name text);
 create table ba_member("userId" text,"organizationId" text,role text);
 create table users(id uuid primary key default gen_random_uuid(),organization_id text,email text,name text,role user_role not null);
 create unique index dir_identity on users(organization_id,lower(email));
 insert into ba_user values('alice','Alice@example.com','Alice');
 insert into ba_member values('alice','a','owner'),('alice','b','member');`);
globalThis.__globalContextDeps = {
  pool: { query: (q, p) => db.query(q, p) },
  listMemberships: async (id) =>
    (await db.query('select "organizationId" as id,role from ba_member where "userId"=$1', [id]))
      .rows,
  getOrgScopedClient: (id) => ({ id }),
  loadAgent: async () => ({ id: 'agent', allowedTools: ['*'] }),
  buildToolContext: (opts) => opts,
};
let source = await readFile(new URL('./context.ts', import.meta.url), 'utf8');
source = source.replace(/import[\s\S]*?;\n/g, '');
source = `const {pool,listMemberships,getOrgScopedClient,loadAgent,buildToolContext}=globalThis.__globalContextDeps;\n${source}`;
const context = await import(
  `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`
);
const a = await context.globalWorkspaceContext('alice', 'a');
assert.equal(a.ctx.organizationId, 'a');
assert.equal(
  (await db.query('select role from users where organization_id=$1', ['a'])).rows[0].role,
  'org_admin',
);
await db.query('update ba_member set role=$1 where "organizationId"=$2', ['member', 'a']);
await context.globalWorkspaceContext('alice', 'a');
assert.equal(
  (await db.query('select role from users where organization_id=$1', ['a'])).rows[0].role,
  'member',
);
await db.query("update users set role='team_admin' where organization_id='a'");
await context.globalWorkspaceContext('alice', 'a');
assert.equal(
  (await db.query('select role from users where organization_id=$1', ['a'])).rows[0].role,
  'team_admin',
);
const b = await context.globalWorkspaceContext('alice', 'b');
assert.notEqual(a.ctx.userId, b.ctx.userId);
await db.query('delete from ba_member where "organizationId"=$1', ['a']);
await assert.rejects(() => context.globalWorkspaceContext('alice', 'a'));
assert.equal((await db.query('select count(*)::int as count from users')).rows[0].count, 2);
console.log('7 global context SQL checks passed');
await db.close();
