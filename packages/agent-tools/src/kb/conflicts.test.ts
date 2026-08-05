import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import {
  CONFLICT_MIN_SIMILARITY,
  type ConflictSourceHit,
  extractFigures,
  figuresDiverge,
  findConflicts,
} from './conflicts';

/**
 * The corpus these fixtures come from is the measured one described in the
 * header of conflicts.ts: an Acme framework contract from March, a signed scan
 * of the same contract six days later, and a renegotiation call in July. The
 * similarities are the ones actually observed (1.0000 for the scan, 0.8590 for
 * the call), so what is asserted here is what the system will really see.
 */

const MARCH = {
  chunkId: '11111111-1111-1111-1111-111111111111',
  documentId: 'aaaaaaaa-0000-0000-0000-00000000000a',
  documentTitle: 'Contrato marco Acme Corp — marzo 2026',
  chunkIndex: 0,
  datedAt: '2026-03-05T00:00:00Z',
  content:
    'Un desarrollador React senior se factura a 8.500 USD por mes. Un React semi senior se factura a 6.200 USD por mes.',
} satisfies ConflictSourceHit;

function rpcReturning(rows: unknown[]) {
  const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
  return { db: { rpc } as unknown as SupabaseClient, rpc };
}

const JULY_CALL = {
  source_chunk_id: MARCH.chunkId,
  chunk_id: '22222222-2222-2222-2222-222222222222',
  document_id: 'bbbbbbbb-0000-0000-0000-00000000000b',
  document_title: 'Llamada de renegociación con Acme Corp',
  space_name: 'General',
  space_scope: 'global',
  chunk_index: 0,
  content:
    'Speaker 1: la tarifa del React senior sube a 9.200 USD por mes. Speaker 2: y el semi senior queda en 6.800 USD.',
  dated_at: '2026-07-18T00:00:00Z',
  valid_until: null,
  superseded_by: null,
  similarity: 0.859,
};

const SIGNED_SCAN = {
  ...JULY_CALL,
  chunk_id: '33333333-3333-3333-3333-333333333333',
  document_id: 'cccccccc-0000-0000-0000-00000000000c',
  document_title: 'Contrato marco Acme Corp — copia firmada (escaneo)',
  content: MARCH.content,
  dated_at: '2026-03-11T00:00:00Z',
  similarity: 1.0,
};

describe('extractFigures', () => {
  it('reads Colombian number formatting as one figure, not several', () => {
    expect([...extractFigures('se factura a 8.500 USD')]).toEqual(['8500']);
    expect([...extractFigures('la tarifa hora por 1,25')]).toEqual(['1.25']);
  });

  it('ignores speaker labels, which every transcript chunk opens with', () => {
    // Without this, "Speaker 1:" makes every recording disagree with every
    // document that happens to mention the number 1.
    expect([...extractFigures('Speaker 1: quedamos en 9.200')]).toEqual(['9200']);
    expect([...extractFigures('Hablante 2: sin cifras aquí')]).toEqual([]);
  });
});

describe('figuresDiverge', () => {
  it('is true when the same claim carries different numbers', () => {
    expect(figuresDiverge('la tarifa es 8.500 USD', 'la tarifa sube a 9.200 USD')).toBe(true);
  });

  it('is false when the numbers agree, however differently written', () => {
    expect(figuresDiverge('la tarifa es 8.500 USD', 'quedó en 8500 dólares')).toBe(false);
  });

  it('is false when either side has no figures — a paraphrase is not a conflict', () => {
    expect(figuresDiverge('la tarifa es 8.500 USD', 'hablamos de la tarifa del senior')).toBe(
      false,
    );
  });
});

describe('findConflicts', () => {
  const userId = '00000000-0000-0000-0000-0000000000aa';

  it('flags the March contract against the July call, and names the newer one', async () => {
    const { db } = rpcReturning([JULY_CALL]);
    const [conflict] = await findConflicts(db, { userId, hits: [MARCH] });

    expect(conflict).toBeDefined();
    expect(conflict?.rival.documentTitle).toBe('Llamada de renegociación con Acme Corp');
    expect(conflict?.newer).toBe('rival');
    // The note has to be usable as-is: both dates, and which one is later.
    expect(conflict?.note).toContain('18 de julio de 2026');
    expect(conflict?.note).toContain('5 de marzo de 2026');
  });

  it('does NOT flag the same contract stored twice', async () => {
    // The loudest available false positive: a signed scan of the same page.
    // Killed twice over — identical text (similarity 1.0) and six days apart.
    const { db } = rpcReturning([SIGNED_SCAN]);
    expect(await findConflicts(db, { userId, hits: [MARCH] })).toEqual([]);
  });

  it('does not flag a restatement in which no figure changed', async () => {
    const { db } = rpcReturning([
      {
        ...JULY_CALL,
        similarity: 0.9,
        content: 'La tarifa del React senior sigue siendo 8.500 USD y la del semi senior 6.200.',
      },
    ]);
    expect(await findConflicts(db, { userId, hits: [MARCH] })).toEqual([]);
  });

  it('does not flag two documents of the same fortnight', async () => {
    const { db } = rpcReturning([
      { ...JULY_CALL, similarity: 0.9, dated_at: '2026-03-09T00:00:00Z' },
    ]);
    expect(await findConflicts(db, { userId, hits: [MARCH] })).toEqual([]);
  });

  it('says one disagreement once, however many chunks pair up', async () => {
    const second = { ...MARCH, chunkId: '44444444-4444-4444-4444-444444444444', chunkIndex: 1 };
    const { db } = rpcReturning([JULY_CALL, { ...JULY_CALL, source_chunk_id: second.chunkId }]);
    const conflicts = await findConflicts(db, { userId, hits: [MARCH, second] });
    expect(conflicts).toHaveLength(1);
  });

  it('asks the database for the measured similarity floor', async () => {
    const { db, rpc } = rpcReturning([]);
    await findConflicts(db, { userId, hits: [MARCH] });
    expect(rpc).toHaveBeenCalledWith(
      'kb_conflict_candidates',
      expect.objectContaining({ p_min_similarity: CONFLICT_MIN_SIMILARITY, p_user_id: userId }),
    );
  });

  it('loses the conflict rather than the answer when the probe fails', async () => {
    const db = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
    } as unknown as SupabaseClient;
    const onFailure = vi.fn();
    await expect(findConflicts(db, { userId, hits: [MARCH] }, onFailure)).resolves.toEqual([]);
    expect(onFailure).toHaveBeenCalled();
  });

  it('never asks anything when it does not know who is asking', async () => {
    const { db, rpc } = rpcReturning([JULY_CALL]);
    expect(await findConflicts(db, { userId: '', hits: [MARCH] })).toEqual([]);
    expect(rpc).not.toHaveBeenCalled();
  });
});
