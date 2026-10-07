import { describe, expect, it } from 'vitest';
import { type ChangesResponse, drainDriveChanges } from './drive-changes';

describe('cursor de cambios de Drive', () => {
  it('repite una página con error y sólo confirma el cursor al terminarla', async () => {
    const page: ChangesResponse = {
      newStartPageToken: 'next',
      changes: [{ fileId: 'a' }, { fileId: 'b' }],
    };
    const applied: string[] = [];
    const failed: string[] = [];
    let failOnce = true;
    const read = async (token: string) => {
      expect(token).toBe('start');
      return page;
    };
    const apply = async (change: { fileId: string }) => {
      applied.push(change.fileId);
      if (change.fileId === 'b' && failOnce) {
        failOnce = false;
        throw new Error('temporary failure');
      }
    };
    const markFailure = async (change: { fileId: string }) => {
      failed.push(change.fileId);
    };

    await expect(drainDriveChanges('start', read, apply, markFailure)).rejects.toThrow(
      'se reintentará la página',
    );
    expect(failed).toEqual(['b']);
    expect(await drainDriveChanges('start', read, apply, markFailure)).toBe('next');
    expect(applied).toEqual(['a', 'b', 'a', 'b']);
  });

  it('drena varias páginas antes de devolver el cursor final', async () => {
    const seen: string[] = [];
    const cursor = await drainDriveChanges(
      'one',
      async (token) => {
        seen.push(token);
        return token === 'one'
          ? { changes: [], nextPageToken: 'two' }
          : { changes: [], newStartPageToken: 'current' };
      },
      async () => undefined,
      async () => undefined,
    );
    expect(cursor).toBe('current');
    expect(seen).toEqual(['one', 'two']);
  });
});
