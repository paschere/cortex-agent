import { describe, expect, it, vi } from 'vitest';
import { collectFeedPages, feedPaginationSchema } from './pagination';
const config = { recordsPath: 'data', cursorInput: 'cursor', nextCursorPath: 'next', maxPages: 5 };
describe('bounded Feed API pagination', () => {
  it('reads declared cursor pages with fixed inputs', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({ data: { data: [{ id: 1 }], next: 'two' } })
      .mockResolvedValueOnce({ data: { data: [{ id: 2 }], next: null } });
    expect(await collectFeedPages(config, { account: 'A' }, read)).toEqual({
      data: [{ id: 1 }, { id: 2 }],
      truncated: false,
      pages: 2,
    });
    expect(read).toHaveBeenLastCalledWith({ account: 'A', cursor: 'two' });
  });
  it('marks capped or looping providers incomplete instead of claiming full coverage', async () => {
    const read = vi.fn(async () => ({ data: { data: [{ id: 1 }], next: 'same' } }));
    expect((await collectFeedPages(config, {}, read)).truncated).toBe(true);
    expect(read).toHaveBeenCalledTimes(2);
    expect((await collectFeedPages({ ...config, maxPages: 1 }, {}, read)).truncated).toBe(true);
  });
  it('marks an overflowing final page incomplete even without a next cursor', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce({
        data: { data: Array.from({ length: 800 }, (_, id) => ({ id })), next: 'last' },
      })
      .mockResolvedValueOnce({
        data: { data: Array.from({ length: 300 }, (_, id) => ({ id: id + 800 })), next: null },
      });
    const result = await collectFeedPages(config, {}, read);
    expect(result.data).toHaveLength(1000);
    expect(result.truncated).toBe(true);
  });
  it('rejects paths capable of traversing prototypes and malformed record envelopes', async () => {
    expect(
      feedPaginationSchema.safeParse({ ...config, recordsPath: '__proto__.data' }).success,
    ).toBe(false);
    await expect(
      collectFeedPages(config, {}, async () => ({ data: { data: 'not a list' } })),
    ).rejects.toThrow('lista');
  });
});
