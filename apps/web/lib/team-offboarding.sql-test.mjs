import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();

await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table ba_user(id text primary key, email text not null);
  create table ba_organization(id text primary key, name text not null);
  create table ba_member(id text primary key, "organizationId" text not null references ba_organization(id), "userId" text not null references ba_user(id), role text not null);
  create table users(id uuid primary key, organization_id text not null references ba_organization(id), email text not null);
  create table scheduled_jobs(id uuid primary key default gen_random_uuid(), organization_id text not null, user_id uuid not null, status text not null, updated_at timestamptz not null default now());
  create table gmail_sync_state(user_id uuid primary key, organization_id text not null, paused boolean not null default false, updated_at timestamptz not null default now());
  create table integrations(id uuid primary key default gen_random_uuid(), organization_id text not null, user_id uuid not null, access_token_enc text not null);
  create table oauth_authorization_codes(code_hash text primary key, user_id uuid);
  create table oauth_access_tokens(token_hash text primary key, user_id uuid);
  create table oauth_refresh_tokens(token_hash text primary key, user_id uuid);
  create table mcp_tokens(id uuid primary key default gen_random_uuid(), organization_id text not null, user_id uuid not null, revoked_at timestamptz);
  create table user_mcp_servers(id uuid primary key default gen_random_uuid(), organization_id text not null, user_id uuid not null, enabled boolean not null, trusted boolean not null, auth_value_encrypted text, updated_at timestamptz not null default now());
  create table google_chat_links(google_user_name text primary key, organization_id text not null, user_id uuid not null);
  create table browser_credentials(id uuid primary key default gen_random_uuid(), organization_id text not null, created_by uuid, secret_encrypted text not null);
  create table browser_profiles(id uuid primary key default gen_random_uuid(), organization_id text not null, owner_id uuid not null, shared boolean not null, revision integer not null);
  create table browser_flows(id uuid primary key default gen_random_uuid(), organization_id text not null, profile_id uuid references browser_profiles(id), credential_id uuid references browser_credentials(id));
  create table browser_flow_grants(id uuid primary key default gen_random_uuid(), flow_id uuid not null references browser_flows(id), user_id uuid);
  create table corporate_notes(id uuid primary key default gen_random_uuid(), organization_id text not null, author_id uuid, body text not null);

  insert into ba_user values ('ba-founder-a','a@corp.test'),('ba-founder-b','b@corp.test'),('ba-worker','worker@corp.test');
  insert into ba_organization values ('org-a','Empresa A'),('org-b','Empresa B');
  insert into ba_member values
    ('owner-a','org-a','ba-founder-a','owner'),('owner-b','org-b','ba-founder-b','owner'),
    ('worker-a','org-a','ba-worker','member'),('worker-b','org-b','ba-worker','member');
  insert into users values
    ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','org-a','a@corp.test'),
    ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','org-b','b@corp.test'),
    ('11111111-1111-4111-8111-111111111111','org-a','worker@corp.test'),
    ('22222222-2222-4222-8222-222222222222','org-b','worker@corp.test');

  insert into scheduled_jobs(organization_id,user_id,status) values
    ('org-a','11111111-1111-4111-8111-111111111111','active'),
    ('org-b','22222222-2222-4222-8222-222222222222','active');
  insert into gmail_sync_state values
    ('11111111-1111-4111-8111-111111111111','org-a',false,now()),
    ('22222222-2222-4222-8222-222222222222','org-b',false,now());
  insert into integrations(organization_id,user_id,access_token_enc) values
    ('org-a','11111111-1111-4111-8111-111111111111','secret-a'),
    ('org-b','22222222-2222-4222-8222-222222222222','secret-b');
  insert into oauth_authorization_codes values ('code-a','11111111-1111-4111-8111-111111111111'),('code-b','22222222-2222-4222-8222-222222222222');
  insert into oauth_access_tokens values ('access-a','11111111-1111-4111-8111-111111111111'),('access-b','22222222-2222-4222-8222-222222222222');
  insert into oauth_refresh_tokens values ('refresh-a','11111111-1111-4111-8111-111111111111'),('refresh-b','22222222-2222-4222-8222-222222222222');
  insert into mcp_tokens(organization_id,user_id) values ('org-a','11111111-1111-4111-8111-111111111111'),('org-b','22222222-2222-4222-8222-222222222222');
  insert into user_mcp_servers(organization_id,user_id,enabled,trusted,auth_value_encrypted) values
    ('org-a','11111111-1111-4111-8111-111111111111',true,true,'mcp-a'),
    ('org-b','22222222-2222-4222-8222-222222222222',true,true,'mcp-b');
  insert into google_chat_links values ('spaces/a','org-a','11111111-1111-4111-8111-111111111111'),('spaces/b','org-b','22222222-2222-4222-8222-222222222222');
  insert into browser_credentials(organization_id,created_by,secret_encrypted) values ('org-a','11111111-1111-4111-8111-111111111111','company-shared-a');
  insert into browser_profiles(organization_id,owner_id,shared,revision) values
    ('org-a','11111111-1111-4111-8111-111111111111',true,3),
    ('org-a','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',true,5),
    ('org-b','22222222-2222-4222-8222-222222222222',true,7);
  insert into browser_flows(organization_id,profile_id,credential_id)
    select 'org-a', p.id, c.id from browser_profiles p cross join browser_credentials c
     where p.organization_id='org-a' and p.owner_id='11111111-1111-4111-8111-111111111111';
  insert into browser_flow_grants(flow_id,user_id) select id,'11111111-1111-4111-8111-111111111111' from browser_flows;
  insert into corporate_notes(organization_id,author_id,body) values ('org-a','11111111-1111-4111-8111-111111111111','Trabajo que la empresa conserva');
`);

const migration = await readFile(
  new URL('../../../infra/supabase/migrations/0138_member_offboarding.sql', import.meta.url),
  'utf8',
);
await db.exec(migration);
await db.exec(`delete from ba_member where id='worker-a'`);

const scalar = async (sql) => (await db.query(sql)).rows[0];
assert.equal(
  (await scalar(`select status from scheduled_jobs where organization_id='org-a'`)).status,
  'paused',
);
assert.equal(
  (await scalar(`select status from scheduled_jobs where organization_id='org-b'`)).status,
  'active',
);
assert.equal(
  (await scalar(`select paused from gmail_sync_state where organization_id='org-a'`)).paused,
  true,
);
assert.equal(
  (await scalar(`select count(*)::int n from integrations where organization_id='org-a'`)).n,
  0,
);
assert.equal(
  (await scalar(`select count(*)::int n from integrations where organization_id='org-b'`)).n,
  1,
);
assert.equal(
  (await scalar(`select count(*)::int n from oauth_access_tokens where token_hash='access-a'`)).n,
  0,
);
assert.equal(
  (await scalar(`select count(*)::int n from oauth_access_tokens where token_hash='access-b'`)).n,
  1,
);
assert.ok(
  (await scalar(`select revoked_at from mcp_tokens where organization_id='org-a'`)).revoked_at,
);
assert.equal(
  (await scalar(`select revoked_at from mcp_tokens where organization_id='org-b'`)).revoked_at,
  null,
);
assert.deepEqual(
  await scalar(
    `select enabled,trusted,auth_value_encrypted from user_mcp_servers where organization_id='org-a'`,
  ),
  { enabled: false, trusted: false, auth_value_encrypted: null },
);
assert.deepEqual(
  await scalar(
    `select shared,revision from browser_profiles where organization_id='org-a' and owner_id='11111111-1111-4111-8111-111111111111'`,
  ),
  { shared: false, revision: 4 },
);
assert.deepEqual(
  await scalar(
    `select shared,revision from browser_profiles where organization_id='org-a' and owner_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'`,
  ),
  { shared: true, revision: 5 },
);
assert.deepEqual(
  await scalar(`select shared,revision from browser_profiles where organization_id='org-b'`),
  { shared: true, revision: 7 },
);
assert.equal(
  (await scalar(`select count(*)::int n from browser_credentials where organization_id='org-a'`)).n,
  1,
);
assert.equal(
  (await scalar(`select count(*)::int n from browser_flows where organization_id='org-a'`)).n,
  1,
);
assert.equal((await scalar('select count(*)::int n from browser_flow_grants')).n, 0);
assert.equal(
  (await scalar(`select count(*)::int n from corporate_notes where organization_id='org-a'`)).n,
  1,
);
assert.equal((await scalar(`select count(*)::int n from ba_member where id='worker-b'`)).n, 1);
assert.equal(
  (
    await scalar(
      `select count(*)::int n from member_offboarding_events where organization_id='org-a'`,
    )
  ).n,
  1,
);

console.log('member offboarding SQL: 19 checks passed');
await db.close();
