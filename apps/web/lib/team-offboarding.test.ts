import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TEAM_OFFBOARDING_NOTICE } from './team-offboarding';

const SQL = readFileSync(
  fileURLToPath(
    new URL('../../../infra/supabase/migrations/0138_member_offboarding.sql', import.meta.url),
  ),
  'utf8',
);

describe('secure member offboarding', () => {
  it('runs atomically from the authoritative membership deletion', () => {
    expect(SQL).toContain('after delete on public.ba_member');
    expect(SQL).toContain('security definer');
    expect(SQL).toContain('set search_path = public, pg_temp');
  });

  it('revokes private authority and pauses owned background work', () => {
    expect(SQL).toContain("set status = 'paused'");
    expect(SQL).toContain('update public.gmail_sync_state');
    expect(SQL).toContain('delete from public.integrations');
    expect(SQL).toContain('update public.mcp_tokens');
    expect(SQL).toContain('auth_value_encrypted = null');
    expect(SQL).toContain('set shared = false, revision = revision + 1');
  });

  it('does not delete corporate history or company browser credentials', () => {
    expect(SQL).not.toMatch(
      /delete from public\.(users|conversations|messages|reports|audit_events|browser_credentials|browser_flows)/,
    );
    expect(SQL).toContain('insert into public.member_offboarding_events');
    expect(TEAM_OFFBOARDING_NOTICE.retained).toContain('conserva');
  });
});
