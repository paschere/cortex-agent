import { describe, expect, it } from 'vitest';
import {
  type Conflict,
  type OutboxOutcome,
  type QueuedOp,
  drainOutbox,
  enqueueEntry,
  itemState,
  newOp,
  pendingEntries,
  resolveConflict,
  retryEntry,
  summarizeOutbox,
} from './op-queue';

const op = (id: string, at: number, row = 'r1', over: Partial<QueuedOp> = {}): QueuedOp =>
  newOp({
    clientId: id,
    appId: 'app',
    screen: 'envios',
    kind: 'edit',
    blockId: 'det',
    rowId: row,
    label: `cambio ${id}`,
    patch: { estado: id },
    now: at,
    ...over,
  });

const rowOf = (e: QueuedOp) => e.rowId;
const ok = async (): Promise<OutboxOutcome> => ({ kind: 'ok' });
const CONFLICT: Conflict[] = [
  { field: 'estado', was: 'Recibido', mine: 'Entregado', theirs: 'Anulado' },
];

describe('orden', () => {
  it('guarda en orden de creación, sin duplicar el mismo clientId', () => {
    let q: QueuedOp[] = [];
    q = enqueueEntry(q, op('b', 20));
    q = enqueueEntry(q, op('a', 10));
    q = enqueueEntry(q, op('a', 99));
    expect(q.map((x) => x.clientId)).toEqual(['a', 'b']);
  });

  it('un empate de hora conserva el orden en que se guardaron', () => {
    let q: QueuedOp[] = [];
    for (const id of ['x', 'y', 'z']) q = enqueueEntry(q, op(id, 5));
    expect(q.map((x) => x.clientId)).toEqual(['x', 'y', 'z']);
  });

  it('envía todo en orden y vacía la cola', async () => {
    const seen: string[] = [];
    const out = await drainOutbox(
      [op('c', 30, 'r3'), op('a', 10, 'r1'), op('b', 20, 'r2')],
      async (e) => {
        seen.push(e.clientId);
        return { kind: 'ok' };
      },
      { now: 100, rowOf },
    );
    expect(seen).toEqual(['a', 'b', 'c']);
    expect(out.entries).toEqual([]);
    expect(out.sent).toEqual(['a', 'b', 'c']);
  });
});

describe('reintento', () => {
  it('un fallo de red detiene todo para no adelantar lo de después y programa el reintento', async () => {
    const seen: string[] = [];
    const out = await drainOutbox(
      [op('a', 10, 'r1'), op('b', 20, 'r2'), op('c', 30, 'r3')],
      async (e) => {
        seen.push(e.clientId);
        return e.clientId === 'b' ? { kind: 'retry' } : { kind: 'ok' };
      },
      { now: 1000, rowOf },
    );
    expect(seen).toEqual(['a', 'b']);
    expect(out.sent).toEqual(['a']);
    const b = out.entries.find((e) => e.clientId === 'b');
    expect(b?.attempts).toBe(1);
    expect(b?.nextAt).toBeGreaterThan(1000);
    expect(out.entries.map((e) => e.clientId)).toEqual(['b', 'c']);
  });

  it('respeta la espera salvo que se fuerce (volvió la señal)', async () => {
    const waiting = { ...op('a', 10), attempts: 2, nextAt: 5_000 };
    let calls = 0;
    const send = async (): Promise<OutboxOutcome> => {
      calls += 1;
      return { kind: 'ok' };
    };
    await drainOutbox([waiting], send, { now: 1_000, rowOf });
    expect(calls).toBe(0);
    await drainOutbox([waiting], send, { now: 1_000, force: true, rowOf });
    expect(calls).toBe(1);
  });

  it('el reintento manual limpia el rechazo y deja salir ya', () => {
    const rejected = { ...op('a', 10), attempts: 3, nextAt: 9_999, rejected: 'No permitido' };
    const [again] = retryEntry([rejected], 'a', 500);
    expect(again?.rejected).toBeUndefined();
    expect(again).toMatchObject({ attempts: 0, nextAt: 500 });
  });
});

describe('rechazos', () => {
  it('lo rechazado queda a la vista y no frena lo que no tiene que ver', async () => {
    const out = await drainOutbox(
      [op('a', 10, 'r1'), op('b', 20, 'r2')],
      async (e) =>
        e.clientId === 'a' ? { kind: 'rejected', error: 'Sin permiso' } : { kind: 'ok' },
      { now: 100, rowOf },
    );
    expect(out.sent).toEqual(['b']);
    expect(out.entries).toHaveLength(1);
    expect(out.entries[0]).toMatchObject({ clientId: 'a', rejected: 'Sin permiso' });
    expect(pendingEntries(out.entries)).toHaveLength(0);
  });

  it('lo que sigue sobre el MISMO registro espera a que se resuelva', async () => {
    const seen: string[] = [];
    const out = await drainOutbox(
      [op('a', 10, 'r1'), op('b', 20, 'r1'), op('c', 30, 'r2')],
      async (e) => {
        seen.push(e.clientId);
        return e.clientId === 'a' ? { kind: 'rejected', error: 'No' } : { kind: 'ok' };
      },
      { now: 100, rowOf },
    );
    expect(seen).toEqual(['a', 'c']);
    expect(out.entries.map((e) => e.clientId)).toEqual(['a', 'b']);
  });
});

describe('conflictos', () => {
  it('el registro cambió: queda marcado con los dos valores y espera una decisión', async () => {
    const out = await drainOutbox(
      [op('a', 10, 'r1', { expect: { estado: 'Recibido' } }), op('b', 20, 'r1')],
      async (e) =>
        e.clientId === 'a' ? { kind: 'conflict', conflicts: CONFLICT } : { kind: 'ok' },
      { now: 100, rowOf },
    );
    expect(out.sent).toEqual([]);
    expect(out.entries[0]?.conflict).toEqual(CONFLICT);
    expect(itemState(out.entries[0] as QueuedOp)).toBe('conflict');
    // b es del mismo registro: no se cuela.
    expect(out.entries.map((e) => e.clientId)).toEqual(['a', 'b']);
  });

  it('«aplicar lo mío» vuelve a mandarlo sin comparar; «descartar» lo saca', () => {
    const stuck = { ...op('a', 10, 'r1', { expect: { estado: 'Recibido' } }), conflict: CONFLICT };
    const [mine] = resolveConflict([stuck], 'a', 'mine', 777);
    expect(mine?.conflict).toBeUndefined();
    expect(mine?.expect).toBeUndefined();
    expect(mine).toMatchObject({ attempts: 0, nextAt: 777 });
    expect(resolveConflict([stuck], 'a', 'theirs', 777)).toEqual([]);
  });

  it('tras resolver, el siguiente del mismo registro ya puede salir en orden', async () => {
    const stuck = { ...op('a', 10, 'r1'), conflict: CONFLICT };
    const resolved = resolveConflict([stuck, op('b', 20, 'r1')], 'a', 'mine', 100);
    const seen: string[] = [];
    await drainOutbox(
      resolved,
      async (e) => {
        seen.push(e.clientId);
        return { kind: 'ok' };
      },
      { now: 100, force: true, rowOf },
    );
    expect(seen).toEqual(['a', 'b']);
  });
});

describe('la barra y los estados', () => {
  it('estados por entrada', () => {
    expect(itemState(op('a', 1))).toBe('pending');
    expect(itemState({ ...op('a', 1), attempts: 2 })).toBe('retrying');
    expect(itemState({ ...op('a', 1), rejected: 'x' })).toBe('rejected');
  });

  it('sin señal con pendientes', () => {
    const items = [
      { state: 'pending' as const },
      { state: 'retrying' as const },
      { state: 'pending' as const },
    ];
    expect(summarizeOutbox(items, false, false)).toMatchObject({
      pending: 3,
      tone: 'offline',
      text: 'Sin señal · 3 pendientes por enviar',
    });
    expect(summarizeOutbox(items.slice(0, 1), false, false).text).toBe(
      'Sin señal · 1 pendiente por enviar',
    );
  });

  it('con señal envía; lo rechazado pide revisión; sin nada no hay barra', () => {
    expect(summarizeOutbox([{ state: 'pending' }], true, true).text).toBe('Enviando · 1 pendiente');
    expect(summarizeOutbox([{ state: 'pending' }, { state: 'conflict' }], true, false).text).toBe(
      'Por enviar · 1 pendiente · 1 necesita revisión',
    );
    expect(summarizeOutbox([{ state: 'rejected' }], true, false)).toMatchObject({
      tone: 'review',
      text: '1 necesita revisión',
    });
    expect(summarizeOutbox([], true, false)).toMatchObject({ text: null, tone: null });
    expect(summarizeOutbox([], false, false)).toMatchObject({ text: 'Sin señal', tone: 'offline' });
  });
});
