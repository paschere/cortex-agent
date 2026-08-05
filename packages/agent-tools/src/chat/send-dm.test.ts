import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import { chatSendDm, findChatDmLink, notLinkedExplanation } from './send-dm';
import {
  capForChat,
  isChatAppConfigured,
  normalizeChatSpace,
  resetChatAppCredentials,
} from './service-account';

const USER = '00000000-0000-0000-0000-000000000001';

/** A `google_chat_links` lookup that resolves to `row`. */
function makeCtx(row: Record<string, unknown> | null): ToolContext {
  const chain = {
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        not: vi.fn().mockReturnValue({
          order: vi.fn().mockReturnValue({
            limit: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
            }),
          }),
        }),
      }),
    }),
  };
  return {
    organizationId: 'org-test',
    userId: USER,
    agentId: '00000000-0000-0000-0000-000000000002',
    db: { from: vi.fn().mockReturnValue(chain) } as unknown as ToolContext['db'],
    integrations: {} as ToolContext['integrations'],
    logger: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    } as unknown as ToolContext['logger'],
  };
}

function withServiceAccount() {
  process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: 'cortex@example.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\\nnot-a-real-key\\n-----END PRIVATE KEY-----',
  });
  resetChatAppCredentials();
}

afterEach(() => {
  // biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
  delete process.env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON;
  resetChatAppCredentials();
});

describe('chat.send_dm', () => {
  it('reports the app as unconfigured instead of throwing', async () => {
    resetChatAppCredentials();
    expect(isChatAppConfigured()).toBe(false);
    const out = await chatSendDm.handler({ text: 'hello' }, makeCtx(null));
    expect(out.sent).toBe(false);
    expect(out.reason).toBe('chat app not configured');
    expect(out.markdown).toMatch(/not set up/i);
  });

  it('reports "not linked" with an actionable explanation, never a made-up space', async () => {
    withServiceAccount();
    const out = await chatSendDm.handler({ text: 'hello' }, makeCtx(null));
    expect(out.sent).toBe(false);
    expect(out.reason).toBe('not linked');
    expect(out.space).toBeNull();
    expect(out.markdown).toMatch(/say hi/i);
  });

  it('addresses the caller in the second person when DMing themselves', async () => {
    withServiceAccount();
    const out = await chatSendDm.handler({ text: 'hello' }, makeCtx(null));
    expect(out.markdown).toContain("you haven't");
  });
});

describe('findChatDmLink', () => {
  it('normalizes the stored space and carries the display name', async () => {
    const link = await findChatDmLink(
      makeCtx({ dm_space: 'spaces/AAQA1b2c3d4', display_name: 'Ana' }),
      USER,
    );
    expect(link).toEqual({ space: 'spaces/AAQA1b2c3d4', displayName: 'Ana' });
  });

  it('is null when the row has no usable DM space', async () => {
    expect(await findChatDmLink(makeCtx({ dm_space: '  ' }), USER)).toBeNull();
    expect(await findChatDmLink(makeCtx(null), USER)).toBeNull();
  });
});

describe('normalizeChatSpace', () => {
  it.each([
    ['spaces/AAQA1b2c3d4', 'spaces/AAQA1b2c3d4'],
    ['AAQA1b2c3d4', 'spaces/AAQA1b2c3d4'],
    ['/spaces/AAQA1b2c3d4', 'spaces/AAQA1b2c3d4'],
  ])('accepts %s', (input, expected) => {
    expect(normalizeChatSpace(input)).toBe(expected);
  });

  it.each(['', '   ', 'spaces/AAA/messages', 'https://evil.example.com', 'spaces/../../etc'])(
    'rejects %s',
    (input) => {
      expect(normalizeChatSpace(input)).toBeNull();
    },
  );
});

describe('capForChat', () => {
  it('leaves short text alone', () => {
    expect(capForChat('short', 100)).toBe('short');
  });

  it('trims on a line boundary and points at the full report', () => {
    const text = `${'line of digest text\n'.repeat(60)}`;
    const capped = capForChat(text, 200, 'https://os.example.com');
    expect(capped.length).toBeLessThanOrEqual(200);
    expect(capped).toContain('See the full report in Cortex');
    // The cut lands on a line boundary, not mid-word.
    expect(capped.split('\n…')[0]?.endsWith('line of digest text')).toBe(true);
  });

  it('falls back to plain wording when no base URL is available', () => {
    const previous = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = '';
    expect(capForChat('x'.repeat(500), 100)).toContain('(See the full report in Cortex.)');
    if (previous === undefined) {
      // biome-ignore lint/performance/noDelete: restore the original absence
      delete process.env.APP_BASE_URL;
    } else {
      process.env.APP_BASE_URL = previous;
    }
  });
});

describe('notLinkedExplanation', () => {
  it('speaks to the right person', () => {
    expect(notLinkedExplanation('you')).toContain("you haven't");
    expect(notLinkedExplanation('they')).toContain("they haven't");
  });
});
