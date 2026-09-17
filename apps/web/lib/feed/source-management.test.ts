import { describe, expect, it } from 'vitest';
import { feedSourceActionSchema, publicFeedSource } from './source-management';

describe('persistent Feed source boundary', () => {
  it('accepts only the three explicit mutations', () => {
    const id = crypto.randomUUID();
    expect(feedSourceActionSchema.safeParse({ action: 'refresh', id }).success).toBe(true);
    expect(feedSourceActionSchema.safeParse({ action: 'disable', id }).success).toBe(true);
    expect(
      feedSourceActionSchema.safeParse({ action: 'version', id, attachmentId: crypto.randomUUID() })
        .success,
    ).toBe(true);
    expect(feedSourceActionSchema.safeParse({ action: 'delete', id }).success).toBe(false);
  });

  it('projects status without exposing connector config or credentials', () => {
    const source = publicFeedSource({
      id: crypto.randomUUID(),
      kind: 'api',
      name: 'CRM',
      latest_attachment_id: null,
      status: 'ok',
      last_checked_at: '2026-09-16T12:00:00Z',
      error: null,
      enabled: true,
      config: { token: 'secret' },
    });
    expect(source).not.toHaveProperty('config');
    expect(JSON.stringify(source)).not.toContain('secret');
  });
});
