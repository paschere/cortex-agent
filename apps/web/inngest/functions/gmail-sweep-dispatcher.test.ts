import { enqueueJobsStrict } from '@/lib/jobs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type GmailSweepMailbox,
  buildGmailSweepPage,
  dispatchGmailSweepPage,
  gmailSweepEvents,
} from './gmail-sweep-dispatcher';

function mailbox(n: number, organizationId = `org-${n % 7}`): GmailSweepMailbox {
  return { userId: n.toString().padStart(4, '0'), organizationId };
}

async function drain(rows: GmailSweepMailbox[], pageSize = 200) {
  const dispatched: GmailSweepMailbox[] = [];
  let afterUserId: string | undefined;
  do {
    const page = await buildGmailSweepPage({
      afterUserId,
      pageSize,
      load: async (after, limit) =>
        rows.filter((row) => !after || row.userId > after).slice(0, limit),
    });
    dispatched.push(...page.mailboxes);
    afterUserId = page.nextAfterUserId;
  } while (afterUserId);
  return dispatched;
}

describe('gmail sweep dispatcher', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('covers more than two pages without omissions', async () => {
    const rows = Array.from({ length: 450 }, (_, index) => mailbox(index));
    expect(await drain(rows)).toEqual(rows);
  });

  it('emits nothing for an empty fleet', async () => {
    const page = await buildGmailSweepPage({
      pageSize: 200,
      load: async () => [],
    });
    expect(gmailSweepEvents(page)).toEqual([]);
  });

  it('does not dispatch a mailbox paused between pages', async () => {
    const active = Array.from({ length: 201 }, (_, index) => mailbox(index));
    const first = await buildGmailSweepPage({
      pageSize: 200,
      load: async (_after, limit) => active.slice(0, limit),
    });
    active.splice(200, 1);
    const second = await buildGmailSweepPage({
      afterUserId: first.nextAfterUserId,
      pageSize: 200,
      load: async (after, limit) =>
        active.filter((row) => !after || row.userId > after).slice(0, limit),
    });
    expect(second.mailboxes).toEqual([]);
  });

  it('propagates a page failure without advancing the cursor', async () => {
    const seen: Array<string | undefined> = [];
    const load = async (after: string | undefined) => {
      seen.push(after);
      if (seen.length === 1) throw new Error('database unavailable');
      return [mailbox(201)];
    };
    await expect(buildGmailSweepPage({ afterUserId: '0199', pageSize: 200, load })).rejects.toThrow(
      'database unavailable',
    );
    const retry = await buildGmailSweepPage({ afterUserId: '0199', pageSize: 200, load });
    expect(seen).toEqual(['0199', '0199']);
    expect(retry.mailboxes).toEqual([mailbox(201)]);
  });

  it('keeps organization identity even if an upstream fixture repeats a user id', () => {
    const events = gmailSweepEvents({
      mailboxes: [mailbox(1, 'org-a'), mailbox(1, 'org-b')],
    });
    expect(events.map((event) => event.data)).toEqual([
      { userId: '0001', organizationId: 'org-a' },
      { userId: '0001', organizationId: 'org-b' },
    ]);
  });

  it('does not report success when a strict queue fails after a partial dispatch', async () => {
    const page = {
      mailboxes: [mailbox(1), mailbox(2)],
      nextAfterUserId: '0002',
    };
    vi.stubEnv('JOBS_WORKER_URL', 'https://jobs.example.test');
    vi.stubEnv('JOBS_SECRET', 'test-secret');
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(enqueueJobsStrict(gmailSweepEvents(page))).rejects.toThrow(
      'No se pudo encolar el trabajo gmail/sweep.user',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('uses the strict queue capability when the pg-boss shim exposes it', async () => {
    const strict = vi.fn().mockRejectedValue(new Error('queue rejected'));
    await expect(
      dispatchGmailSweepPage(
        {
          run: async (_name, fn) => fn(),
          sendEvent: async () => undefined,
          sendEventStrict: strict,
          sleep: async () => undefined,
        },
        { mailboxes: [mailbox(1)] },
      ),
    ).rejects.toThrow('queue rejected');
    expect(strict).toHaveBeenCalledOnce();
  });
});
