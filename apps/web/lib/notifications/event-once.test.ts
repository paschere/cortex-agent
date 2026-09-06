import { createOrgScopedClient } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { expect, it } from 'vitest';
import { createFakeSupabase } from '../../../../packages/agent-tools/src/tenancy/__tests__/fake-postgrest';
import { notify } from './notify';
it('a duplicate event preserves read state and occurrence count, even after it was read', async () => {
  const { client, tables } = createFakeSupabase({ notifications: [] });
  const wrapped = {
    from(table: string) {
      const b = client.from(table);
      const original = b.insert.bind(b);
      b.insert = ((input: Record<string, unknown>) => {
        if (
          tables.notifications?.some(
            (r) =>
              r.organization_id === input.organization_id &&
              r.user_id === input.user_id &&
              r.dedupe_key === input.dedupe_key,
          )
        ) {
          const duplicate = {
            select: () => duplicate,
            single: async () => ({ data: null, error: { code: '23505' } }),
          };
          return duplicate;
        }
        return original({ ...input, id: 'notice', read_at: null });
      }) as typeof b.insert;
      return b;
    },
  } as SupabaseClient;
  const db = createOrgScopedClient(wrapped, 'a');
  const input = {
    userId: 'me',
    kind: 'management_attention' as const,
    title: 'Respuesta recibida',
    dedupeKey: 'workflow:reply',
  };
  expect(await notify(db, input)).toBe('notice');
  const stored = tables.notifications?.[0];
  if (!stored) throw new Error('notification missing');
  stored.read_at = '2026-09-06T12:00:00Z';
  expect(await notify(db, input)).toBe('notice');
  expect(tables.notifications).toHaveLength(1);
  expect(tables.notifications?.[0]?.occurrences).toBe(1);
  expect(tables.notifications?.[0]?.read_at).toBe('2026-09-06T12:00:00Z');
});
