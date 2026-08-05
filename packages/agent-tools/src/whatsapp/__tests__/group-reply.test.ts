import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type GroupReplyRow,
  type GroupTurnRequest,
  handleGroupMention,
  shouldStageMessage,
} from '../group-reply';
import { UNKNOWN_GROUP_SENDER_REPLY, isGroupReplyScope } from '../mentions';
import { type Row, makeDb, silentLogger } from './fake-db';

/**
 * What these tests protect, and why they are shaped this way.
 *
 * The interesting claims about answering in a group are all NEGATIVE — it does
 * not answer when nobody called it, it does not run tools for a stranger, it
 * does not answer twice, it does not keep talking forever. An assertion that a
 * reply came back empty proves none of them: a turn could have run, spent
 * money, read the brain and then produced nothing.
 *
 * So the turn is a spy, and the assertions are about whether it was CALLED. The
 * strong version of "a stranger cannot trigger a Brain Knowledge read" is that
 * `runTurn` never ran, and that is what is checked.
 */

const ORG = 'org-acme';
const GROUP = '120363000000000001@g.us';
const SELF = ['573001112233:14@s.whatsapp.net'];
const SELF_JID = '573001112233@s.whatsapp.net';
const ANA_JID = '573009998877@s.whatsapp.net';
const ANA_USER = '00000000-0000-0000-0000-000000000001';
const SPACE = '00000000-0000-0000-0000-0000000000aa';

const NOW = Date.parse('2026-03-03T15:00:00Z');

let store: Record<string, Row[]>;
let runTurn: ReturnType<typeof vi.fn>;

const GROUP_ROW: GroupReplyRow = {
  jid: GROUP,
  subject: 'Despachos Acme',
  reply_enabled: true,
  reply_scope: 'plain',
  reply_space_id: null,
  reply_limit_per_hour: 3,
};

function deps(overrides: { nowMs?: number } = {}) {
  return {
    organizationId: ORG,
    db: makeDb(store, {
      // The unique index from migration 0072, modelled — it is the mechanism
      // under test, not scenery.
      whatsapp_group_replies: ['organization_id', 'group_jid', 'message_id'],
    }),
    logger: silentLogger,
    runTurn: runTurn as unknown as (req: GroupTurnRequest) => Promise<{
      publicText: string;
      privateText: string | null;
      withheldReason: string | null;
    }>,
    nowMs: overrides.nowMs ?? NOW,
  };
}

const ANA = async () => ({ userId: ANA_USER, phone: '573009998877', displayName: 'Ana Ruiz' });
const NOBODY = async () => null;
const scopeOf = (raw: string) => (isGroupReplyScope(raw) ? raw : ('plain' as const));

function mention(overrides: Partial<Parameters<typeof handleGroupMention>[2]> = {}) {
  return {
    groupJid: GROUP,
    messageId: 'wa-1',
    senderJid: ANA_JID,
    senderName: 'Ana',
    text: '@573001112233 ¿qué quedó del despacho?',
    mentionedJids: [SELF_JID],
    quotedAuthorJid: null,
    selfJids: SELF,
    recent: [],
    ...overrides,
  };
}

beforeEach(() => {
  store = {
    whatsapp_group_replies: [],
    users: [{ id: ANA_USER, role: 'member', organization_id: ORG }],
  };
  runTurn = vi.fn(async () => ({
    publicText: 'Salió a las 6, ya está cargado.',
    privateText: null,
    withheldReason: null,
  }));
});

describe('when Cortex has not been spoken to', () => {
  it('says nothing and runs nothing', async () => {
    const result = await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention({ mentionedJids: [], text: 'cortex, mira esto' }),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    expect(result.outcome).toBe('ignored');
    expect(result.reply).toBeNull();
    expect(runTurn).not.toHaveBeenCalled();
    // Not even a claim row: a message that was not addressed to Cortex is not
    // an event, and writing one per group message would be a row per message.
    expect(store.whatsapp_group_replies).toHaveLength(0);
  });

  it('says nothing when answering is switched off for the group', async () => {
    const result = await handleGroupMention(
      deps(),
      { ...GROUP_ROW, reply_enabled: false },
      mention(),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    expect(result.outcome).toBe('ignored');
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe('when the number is not linked to anybody', () => {
  it('runs NOTHING — no model, no tool, no read', async () => {
    // The whole point. A client or a supplier in the group can tap the name;
    // that must not be able to spend a RUNT lookup or read the brain.
    const result = await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention(),
      NOBODY,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    expect(result.outcome).toBe('unlinked');
    expect(runTurn).not.toHaveBeenCalled();
    expect(result.reply).toBe(UNKNOWN_GROUP_SENDER_REPLY);
    expect(store.whatsapp_group_replies?.[0]?.outcome).toBe('unlinked');
    expect(store.whatsapp_group_replies?.[0]?.user_id).toBeNull();
  });

  it('says it once, not on every mention', async () => {
    // Repeating the refusal is the behaviour that gets a bot thrown out.
    await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention(),
      NOBODY,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );
    const second = await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention({ messageId: 'wa-2' }),
      NOBODY,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    expect(second.outcome).toBe('unlinked');
    expect(second.reply).toBeNull();
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe('when a linked person mentions it', () => {
  it('answers, once', async () => {
    const result = await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention(),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    expect(result.outcome).toBe('answered');
    expect(result.reply).toContain('Salió a las 6');
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(store.whatsapp_group_replies?.[0]?.user_id).toBe(ANA_USER);
  });

  it('never answers the same mention twice', async () => {
    // WhatsApp re-delivers routinely — after a reconnect, during history sync.
    // Answering twice is both noise and, in a room with a client, an audible
    // malfunction.
    const first = await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention(),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );
    const again = await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention(),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    expect(first.outcome).toBe('answered');
    expect(again.outcome).toBe('duplicate');
    expect(again.reply).toBeNull();
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(store.whatsapp_group_replies).toHaveLength(1);
  });

  it('strips the handle out of the question and hands over the room context', async () => {
    await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention({
        recent: [
          {
            senderName: 'Beto',
            senderJid: null,
            sentAt: new Date(NOW - 5 * 60_000).toISOString(),
            text: 'el camión sigue en la bodega',
          },
        ],
      }),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    const turn = runTurn.mock.calls[0]?.[0] as GroupTurnRequest;
    expect(turn.userText).toBe('¿qué quedó del despacho?');
    expect(turn.contextBlock).toContain('el camión sigue en la bodega');
  });

  it('answers a reply to something it said, without a fresh tag', async () => {
    const result = await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention({ mentionedJids: [], quotedAuthorJid: SELF_JID, text: '¿y a qué hora llega?' }),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    expect(result.outcome).toBe('answered');
    expect(runTurn).toHaveBeenCalledTimes(1);
  });
});

describe('the retrieval ceiling', () => {
  it('lets a group at the default scope retrieve NOTHING', async () => {
    // `plain` offers no tools, but the turn engine also runs a retrieval
    // prepend of its own — so an unset ceiling here would put the asker's own
    // private notes into a prompt answering into a room with a client in it.
    await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention(),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    const turn = runTurn.mock.calls[0]?.[0] as GroupTurnRequest;
    expect(turn.kbSpaceIds).toEqual([]);
  });

  it('pins retrieval to the one company space chosen for the group', async () => {
    await handleGroupMention(
      deps(),
      { ...GROUP_ROW, reply_scope: 'knowledge', reply_space_id: SPACE },
      mention(),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    const turn = runTurn.mock.calls[0]?.[0] as GroupTurnRequest;
    expect(turn.kbSpaceIds).toEqual([SPACE]);
  });

  it('retrieves nothing when the knowledge scope has no space configured', async () => {
    // An unset restriction must never degrade into no restriction.
    await handleGroupMention(
      deps(),
      { ...GROUP_ROW, reply_scope: 'knowledge', reply_space_id: null },
      mention(),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    const turn = runTurn.mock.calls[0]?.[0] as GroupTurnRequest;
    expect(turn.kbSpaceIds).toEqual([]);
  });
});

describe('when the answer is too sensitive for the room', () => {
  it('says so in the group and hands the substance back for private delivery', async () => {
    runTurn = vi.fn(async () => ({
      publicText: 'Eso lleva datos personales, te lo mandé directo ⚡',
      privateText: 'María gana …',
      withheldReason: 'pii',
    }));

    const result = await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention(),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    expect(result.outcome).toBe('withheld');
    expect(result.reply).not.toContain('María');
    expect(result.privateReply?.text).toContain('María');
    expect(result.privateReply?.userId).toBe(ANA_USER);
    expect(store.whatsapp_group_replies?.[0]?.withheld_reason).toBe('pii');
  });
});

describe('the per-group ceiling', () => {
  it('goes quiet once the group has had its hour’s worth', async () => {
    for (let i = 0; i < 3; i++) {
      const out = await handleGroupMention(
        deps(),
        GROUP_ROW,
        mention({ messageId: `wa-${i}` }),
        ANA,
        scopeOf,
        UNKNOWN_GROUP_SENDER_REPLY,
      );
      expect(out.outcome).toBe('answered');
    }

    const fourth = await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention({ messageId: 'wa-4' }),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    expect(fourth.outcome).toBe('rate_limited');
    // Silent, not "estoy limitado" — that is one more message in a group that
    // has just had too many.
    expect(fourth.reply).toBeNull();
    expect(runTurn).toHaveBeenCalledTimes(3);
  });

  it('lets the window roll forward', async () => {
    for (let i = 0; i < 3; i++) {
      await handleGroupMention(
        deps(),
        GROUP_ROW,
        mention({ messageId: `wa-${i}` }),
        ANA,
        scopeOf,
        UNKNOWN_GROUP_SENDER_REPLY,
      );
    }

    const later = await handleGroupMention(
      deps({ nowMs: NOW + 61 * 60_000 }),
      GROUP_ROW,
      mention({ messageId: 'wa-later' }),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    expect(later.outcome).toBe('answered');
  });

  it('cannot be used by a stranger to mute Cortex for everybody else', async () => {
    // Silence does not count against the ceiling — otherwise anyone in the
    // group could exhaust it with mentions that were never going to be
    // answered, which is a denial of service with no privileges required.
    for (let i = 0; i < 5; i++) {
      await handleGroupMention(
        deps(),
        GROUP_ROW,
        mention({ messageId: `spam-${i}`, senderJid: '573001110000@s.whatsapp.net' }),
        NOBODY,
        scopeOf,
        UNKNOWN_GROUP_SENDER_REPLY,
      );
    }

    const ana = await handleGroupMention(
      deps(),
      GROUP_ROW,
      mention({ messageId: 'wa-ana' }),
      ANA,
      scopeOf,
      UNKNOWN_GROUP_SENDER_REPLY,
    );

    // One refusal was spoken; the four silent ones cost nothing.
    expect(ana.outcome).toBe('answered');
  });
});

describe('shouldStageMessage', () => {
  const AT = Date.parse('2026-03-03T14:00:00Z');

  it('stores nothing for a group that only ANSWERS', async () => {
    // The one that matters now that a group has two switches. A group where
    // Cortex replies but archiving is off must leave no trace at all — not a
    // message, not a stub.
    expect(
      shouldStageMessage(
        { archive_enabled: false, space_id: null, enabled_by: null, archive_from: null },
        AT,
      ),
    ).toBe(false);
  });

  it('stores a message for a group that archives', () => {
    expect(
      shouldStageMessage(
        {
          archive_enabled: true,
          space_id: SPACE,
          enabled_by: ANA_USER,
          archive_from: '2026-03-01T00:00:00Z',
        },
        AT,
      ),
    ).toBe(true);
  });

  it('never reaches behind the moment archiving was switched on', () => {
    expect(
      shouldStageMessage(
        {
          archive_enabled: true,
          space_id: SPACE,
          enabled_by: ANA_USER,
          archive_from: '2026-03-03T15:00:00Z',
        },
        AT,
      ),
    ).toBe(false);
  });

  it('refuses a group with archiving on but nowhere to put anything', () => {
    expect(
      shouldStageMessage(
        { archive_enabled: true, space_id: null, enabled_by: ANA_USER, archive_from: null },
        AT,
      ),
    ).toBe(false);
    expect(shouldStageMessage(null, AT)).toBe(false);
  });
});
