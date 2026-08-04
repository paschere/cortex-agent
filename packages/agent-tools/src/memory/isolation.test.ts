import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types';
import {
  forgetMemory,
  listMemories,
  loadMemoryContext,
  rememberMemory,
  setMemoryStatus,
  touchMemories,
} from './store';

/**
 * This file exists for ONE claim: a memory belongs to one person, and nothing
 * another person asks can reach it.
 *
 * The claim is enforced in Postgres (migration 0051): every function takes the
 * user as an argument and derives the row set from it, so there is no entry
 * point that takes "which memories" and could be pointed somewhere else. The
 * fake database below is therefore not a stub returning canned rows — it
 * IMPLEMENTS those functions the way the SQL does, over a fixture holding two
 * people's memories. If a caller ever bypasses the boundary, or a function
 * starts trusting an id without the owner, these fail.
 */

const ANA = 'aaaaaaaa-0000-0000-0000-000000000001';
const BEN = 'bbbbbbbb-0000-0000-0000-000000000002';

interface Row {
  id: string;
  user_id: string;
  content: string;
  kind: string;
  status: string;
  source: string;
  source_conversation_id: string | null;
  source_note: string | null;
  last_used_at: string | null;
  use_count: number;
  created_at: string;
}

function fixture(): Row[] {
  const base = {
    kind: 'preference',
    source: 'explicit',
    source_conversation_id: null,
    source_note: null,
    last_used_at: null,
    use_count: 0,
    created_at: '2026-07-01T00:00:00Z',
  };
  return [
    {
      id: 'm-ana-1',
      user_id: ANA,
      content: 'Prefers costs in USD.',
      status: 'active',
      ...base,
    },
    {
      id: 'm-ana-2',
      user_id: ANA,
      content: 'Calls tpp.example.com "the matcher".',
      status: 'active',
      ...base,
    },
    {
      id: 'm-ben-1',
      user_id: BEN,
      content: 'Ben is quietly looking for another job.',
      status: 'active',
      ...base,
    },
    {
      id: 'm-ben-2',
      user_id: BEN,
      content: 'Ben wants the Acme account moved off his plate.',
      status: 'suggested',
      ...base,
    },
  ];
}

/**
 * A db double whose `rpc` implements the migration's functions. Every one of
 * them takes p_user_id and filters on it — which is the property under test.
 */
function makeDb(rows: Row[]) {
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    const userId = (args.p_user_id as string | null) ?? null;
    // `p_user_id is not null` guards every function in 0051: a caller that has
    // lost track of who it is asking for gets nothing, never everything.
    const mine = userId ? rows.filter((r) => r.user_id === userId) : [];

    switch (fn) {
      case 'user_memory_context':
        return {
          data: mine
            .filter((r) => r.status === 'active')
            .map((r) => ({
              id: r.id,
              content: r.content,
              kind: r.kind,
              source: r.source,
              last_used_at: r.last_used_at,
            })),
          error: null,
        };
      case 'user_memory_list':
        return {
          data: mine.map((r) => ({
            id: r.id,
            content: r.content,
            kind: r.kind,
            status: r.status,
            source: r.source,
            source_conversation_id: r.source_conversation_id,
            source_note: r.source_note,
            last_used_at: r.last_used_at,
            use_count: r.use_count,
            created_at: r.created_at,
          })),
          error: null,
        };
      case 'user_memory_forget': {
        const hit = mine.find((r) => r.id === args.p_id);
        if (!hit) return { data: false, error: null };
        rows.splice(rows.indexOf(hit), 1);
        return { data: true, error: null };
      }
      case 'user_memory_set_status': {
        const hit = mine.find((r) => r.id === args.p_id);
        if (!hit) return { data: false, error: null };
        hit.status = args.p_status as string;
        return { data: true, error: null };
      }
      case 'user_memory_touch': {
        for (const r of mine) {
          if ((args.p_ids as string[]).includes(r.id)) {
            r.last_used_at = '2026-07-29T00:00:00Z';
            r.use_count += 1;
          }
        }
        return { data: null, error: null };
      }
      case 'user_memory_remember': {
        if (!userId) return { data: null, error: null };
        const id = `m-new-${rows.length}`;
        rows.push({
          id,
          user_id: userId,
          content: args.p_content as string,
          kind: args.p_kind as string,
          status: args.p_status as string,
          source: args.p_source as string,
          source_conversation_id: (args.p_conversation_id as string | null) ?? null,
          source_note: (args.p_note as string | null) ?? null,
          last_used_at: null,
          use_count: 0,
          created_at: '2026-07-29T00:00:00Z',
        });
        return { data: id, error: null };
      }
      default:
        return { data: null, error: null };
    }
  });

  return { db: { rpc } as unknown as ToolContext['db'], rpc, rows };
}

describe('memory isolation', () => {
  it("never returns another person's memories", async () => {
    const { db } = makeDb(fixture());

    const ana = await loadMemoryContext(db, ANA);
    expect(ana.map((m) => m.content)).toEqual([
      'Prefers costs in USD.',
      'Calls tpp.example.com "the matcher".',
    ]);
    // The whole point.
    expect(ana.some((m) => m.content.includes('Ben'))).toBe(false);

    const ben = await loadMemoryContext(db, BEN);
    expect(ben.map((m) => m.content)).toEqual(['Ben is quietly looking for another job.']);
    expect(ben.some((m) => m.content.includes('USD'))).toBe(false);
  });

  it('hands the database the person, never a list of memory ids', async () => {
    const { db, rpc } = makeDb(fixture());
    await loadMemoryContext(db, ANA);
    const call = rpc.mock.calls.find((c) => c[0] === 'user_memory_context');
    expect(call?.[1]).toEqual({ p_user_id: ANA });
    // There is no argument here that could name someone else's rows.
    expect(Object.keys(call?.[1] ?? {})).toEqual(['p_user_id']);
  });

  it("cannot delete another person's memory by knowing its id", async () => {
    const { db, rows } = makeDb(fixture());
    // Ana holds Ben's memory id — the shape of every id-based bypass.
    await expect(forgetMemory(db, ANA, 'm-ben-1')).resolves.toBe(false);
    expect(rows.some((r) => r.id === 'm-ben-1')).toBe(true);
    // And Ben can still delete his own, so the guard is the owner, not the id.
    await expect(forgetMemory(db, BEN, 'm-ben-1')).resolves.toBe(true);
  });

  it("cannot accept, reject or archive another person's memory", async () => {
    const { db, rows } = makeDb(fixture());
    await expect(setMemoryStatus(db, ANA, 'm-ben-2', 'active')).resolves.toBe(false);
    expect(rows.find((r) => r.id === 'm-ben-2')?.status).toBe('suggested');
  });

  it("cannot mark another person's memory as useful", async () => {
    const { db, rows } = makeDb(fixture());
    touchMemories(db, ANA, ['m-ana-1', 'm-ben-1']);
    await new Promise((r) => setTimeout(r, 0));
    expect(rows.find((r) => r.id === 'm-ana-1')?.use_count).toBe(1);
    expect(rows.find((r) => r.id === 'm-ben-1')?.use_count).toBe(0);
  });

  it('writes land on the caller, so one person cannot plant a memory on another', async () => {
    const { db, rows } = makeDb(fixture());
    await rememberMemory(db, {
      userId: ANA,
      content: 'Always answers in Spanish.',
    });
    const planted = rows.find((r) => r.content === 'Always answers in Spanish.');
    expect(planted?.user_id).toBe(ANA);
    // Ben's set is untouched — there is no user id in rememberMemory's payload
    // other than the caller's own.
    expect((await loadMemoryContext(db, BEN)).length).toBe(1);
  });

  it('a caller that has lost track of who it is asking for gets nothing', async () => {
    const { db, rpc } = makeDb(fixture());
    expect(await loadMemoryContext(db, '')).toEqual([]);
    expect(await listMemories(db, '')).toEqual([]);
    expect(await rememberMemory(db, { userId: '', content: 'anything at all' })).toBeNull();
    expect(await forgetMemory(db, '', 'm-ben-1')).toBe(false);
    // It fails closed before the database is even reached.
    expect(rpc).not.toHaveBeenCalled();
  });
});
