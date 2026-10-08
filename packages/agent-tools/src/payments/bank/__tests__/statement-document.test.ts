import { NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const visible = vi.fn();
const stored = vi.fn();

vi.mock('../../../kb/spaces', () => ({ getVisibleDocument: (...a: unknown[]) => visible(...a) }));
vi.mock('../../../files', () => ({ getFile: (...a: unknown[]) => stored(...a) }));
vi.mock('../../../index', () => ({ registerTool: (t: unknown) => t }));

import { loadStatementDocument } from '../tools';

const DOC = '22222222-2222-4222-8222-222222222222';

function dbWith(row: Record<string, unknown> | null) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
    }),
  } as unknown as SupabaseClient;
}

describe('loadStatementDocument (extracto que bajó un trámite)', () => {
  beforeEach(() => {
    visible.mockReset();
    stored.mockReset();
  });

  it('lee los bytes de kb-uploads cuando el documento es visible', async () => {
    visible.mockResolvedValue({ id: DOC, title: 'extracto' });
    stored.mockResolvedValue({ content: new Uint8Array([1, 2]), contentType: 'text/csv' });
    const out = await loadStatementDocument(
      dbWith({ source_ref: 'u/d/extracto.csv', mime: 'text/csv', title: 'extracto' }),
      DOC,
      'user-1',
    );
    expect(stored).toHaveBeenCalledWith(expect.anything(), 'kb-uploads', 'u/d/extracto.csv');
    expect(out.fileName).toBe('extracto.csv');
    expect(out.bytes.byteLength).toBe(2);
  });

  it('un documento de un espacio que no ve (u otra organización) se lee como inexistente', async () => {
    visible.mockRejectedValue(new NotFoundError('x'));
    await expect(loadStatementDocument(dbWith(null), DOC, 'user-1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(stored).not.toHaveBeenCalled();
  });

  it('un documento sin archivo detrás se rechaza', async () => {
    visible.mockResolvedValue({ id: DOC, title: 'nota' });
    await expect(
      loadStatementDocument(dbWith({ source_ref: null, mime: null, title: 'nota' }), DOC, 'u'),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
