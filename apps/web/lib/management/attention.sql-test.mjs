import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
try {
  await db.exec(`create table notifications(organization_id text, user_id text, kind text constraint notifications_kind_check check(kind in ('action_sent')), read_at timestamptz);`);
  await db.exec(readFileSync(new URL('../../../../infra/supabase/migrations/0132_management_attention.sql', import.meta.url), 'utf8'));
  const insert = (org, user, key) => db.query('insert into notifications(organization_id,user_id,kind,dedupe_key) values($1,$2,$3,$4)', [org,user,'management_attention',key]);
  await insert('a','me','event');
  await assert.rejects(() => insert('a','me','event'), /duplicate key/);
  await db.exec('update notifications set read_at=now()');
  await assert.rejects(() => insert('a','me','event'), /duplicate key/);
  await insert('b','me','event');
  await insert('a','other','event');
  await insert('a','me',null);
  await insert('a','me',null);
  assert.equal((await db.query('select count(*)::int as n from notifications')).rows[0].n, 5);
  console.log('PASS: migration accepts new kind; event identity survives read, isolates company/person and preserves legacy notices.');
} finally { await db.close(); }
