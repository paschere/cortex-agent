import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const guarded = [
  'app/api/chat/attachments/route.ts',
  'app/api/chat/followups/route.ts',
  'app/api/chat/turn-metrics/route.ts',
  'app/api/mandates/exercised/route.ts',
  'app/(chat)/chat/[conversationId]/page.tsx',
  'app/(chat)/chat/actions.ts',
];

describe('conversation ids do not grant access inside a shared company tenant', () => {
  it.each(guarded)('%s checks the current directory owner', (file) => {
    const source = readFileSync(resolve(root, file), 'utf8');
    expect(source).toContain(".from('conversations')");
    expect(source).toMatch(/\.eq\('user_id',\s*user\.id\)/);
  });

  it('serves chat charts only to their creator', () => {
    const source = readFileSync(resolve(root, 'app/api/chat/charts/[id]/route.ts'), 'utf8');
    expect(source).toMatch(/\.eq\('created_by',\s*user\.id\)/);
  });

  it('reserves cross-member transcript access for company owners', () => {
    const source = readFileSync(resolve(root, 'app/(app)/conversations/[id]/page.tsx'), 'utf8');
    expect(source).toContain("user.organization.kind === 'company'");
    expect(source).toContain("user.organization.role === 'owner'");
    expect(source).not.toContain("user.role === 'org_admin'");
  });
});
