import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from '../../node_modules/typescript/lib/typescript.js';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`create role anon; create role authenticated; create role service_role;
create table ba_user(id text primary key); create table ba_member("userId" text,"organizationId" text);
insert into ba_user values('alice'),('bob'); insert into ba_member values('alice','a'),('alice','b'),('bob','b');`);
await db.exec(
  await readFile(
    new URL('../../../../infra/supabase/migrations/0139_global_conversations.sql', import.meta.url),
    'utf8',
  ),
);
const scopeSource = await readFile(new URL('./scope.ts', import.meta.url), 'utf8');
const scope = await import(
  `data:text/javascript;base64,${Buffer.from(ts.transpileModule(scopeSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`
);
globalThis.__globalStoreDeps = {
  ...scope,
  pool: { query: (q, p) => db.query(q, p) },
  listMemberships: async (id) =>
    (await db.query('select "organizationId" as id from ba_member where "userId"=$1', [id])).rows,
};
let source = await readFile(new URL('./store.ts', import.meta.url), 'utf8');
source = source
  .replace("import 'server-only';", '')
  .replace(/import \{[^}]+\} from ['"](?:@\/lib\/auth|@\/lib\/organization|\.\/scope)['"];?/g, '');
source = `const { pool,listMemberships,assertWorkspaceScope,normalizedWorkspaceIds,sameWorkspaceScope }=globalThis.__globalStoreDeps;\n${source}`;
const store = await import(
  `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64')}`
);
const first = await store.startGlobalTurn('alice', ['b', 'a'], 'Pregunta');
assert.deepEqual(first.conversation.workspace_ids, ['a', 'b']);
await assert.rejects(() => store.readGlobalConversation('bob', first.conversation.id));
await assert.rejects(() => store.startGlobalTurn('alice', ['a'], 'Cambio', first.conversation.id));
await assert.rejects(() =>
  store.startGlobalTurn('alice', ['a', 'b'], 'Concurrente', first.conversation.id),
);
await assert.rejects(() =>
  store.finishGlobalTurn(
    'alice',
    first.conversation.id,
    '00000000-0000-4000-8000-000000000000',
    'lease falso',
  ),
);
assert.equal(
  (await store.readGlobalConversation('alice', first.conversation.id)).messages.length,
  1,
);
await store.finishGlobalTurn('alice', first.conversation.id, first.lease, 'Respuesta');
assert.equal(
  (await store.readGlobalConversation('alice', first.conversation.id)).messages.length,
  2,
);
const second = await store.startGlobalTurn('alice', ['a', 'b'], 'Segunda', first.conversation.id);
await store.finishGlobalTurn('alice', first.conversation.id, second.lease, 'Respuesta 2');
assert.equal((await store.listGlobalConversations('alice')).length, 1);
await db.query('delete from ba_member where "userId"=$1 and "organizationId"=$2', ['alice', 'b']);
assert.equal((await store.listGlobalConversations('alice')).length, 0);
await assert.rejects(() => store.readGlobalConversation('alice', first.conversation.id));
await assert.rejects(() =>
  store.startGlobalTurn('alice', ['a', 'b'], 'Revocada', first.conversation.id),
);
const general = await store.startGlobalTurn('alice', [], 'General');
assert.deepEqual(general.conversation.workspace_ids, []);
assert.equal(general.conversation.messages.length, 1);
await db.exec('set role authenticated');
await assert.rejects(() => db.query('select * from global_conversations'));
await db.exec('reset role');
assert.equal(
  (await db.query('select messages from global_conversations where id=$1', [first.conversation.id]))
    .rows[0].messages.length,
  4,
);
console.log('14 global conversation SQL checks passed');
await db.close();
