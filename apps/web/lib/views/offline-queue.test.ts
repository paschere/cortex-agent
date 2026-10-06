import { describe, expect, it } from 'vitest';
import { forValidation, hasPending, pendingIds, swapPending } from './offline-files';
import {
  type QueuedSubmission,
  type SendOutcome,
  type SentRecord,
  backoffMs,
  canCorrect,
  drainQueue,
  enqueue,
  isOfflineFailure,
  minutesLeft,
  pendingOf,
  pushSent,
  queueItem,
} from './offline-queue';

const item = (clientId: string, at: number, key = 'v:f'): QueuedSubmission =>
  queueItem({ clientId, key, blockId: 'f', values: { a: clientId }, now: at });

describe('cola sin internet', () => {
  it('agrega en orden y sin duplicar el mismo clientId', () => {
    let q: QueuedSubmission[] = [];
    q = enqueue(q, item('b', 20));
    q = enqueue(q, item('a', 10));
    q = enqueue(q, item('a', 99));
    expect(q.map((x) => x.clientId)).toEqual(['a', 'b']);
  });

  it('envía en orden y vacía la cola', async () => {
    const order: string[] = [];
    const res = await drainQueue(
      [item('b', 20), item('a', 10), item('c', 30)],
      async (i) => {
        order.push(i.clientId);
        return { kind: 'ok' };
      },
      { now: 100 },
    );
    expect(order).toEqual(['a', 'b', 'c']);
    expect(res.queue).toEqual([]);
    expect(res.sent).toEqual(['a', 'b', 'c']);
  });

  it('un fallo de red detiene el proceso, guarda el intento y no adelanta a los demás', async () => {
    const calls: string[] = [];
    const send = async (i: QueuedSubmission): Promise<SendOutcome> => {
      calls.push(i.clientId);
      return i.clientId === 'b' ? { kind: 'retry' } : { kind: 'ok' };
    };
    const res = await drainQueue([item('a', 10), item('b', 20), item('c', 30)], send, {
      now: 1000,
    });
    expect(calls).toEqual(['a', 'b']);
    expect(res.sent).toEqual(['a']);
    expect(res.queue.map((q) => q.clientId)).toEqual(['b', 'c']);
    expect(res.queue[0]?.attempts).toBe(1);
    expect(res.queue[0]?.nextAt).toBe(1000 + backoffMs(1));
  });

  it('respeta la espera salvo que se fuerce (volvió la señal)', async () => {
    const waiting = { ...item('a', 10), attempts: 1, nextAt: 5000 };
    const never = async (): Promise<SendOutcome> => ({ kind: 'ok' });
    const early = await drainQueue([waiting], never, { now: 1000 });
    expect(early.sent).toEqual([]);
    const forced = await drainQueue([waiting], never, { now: 1000, force: true });
    expect(forced.sent).toEqual(['a']);
  });

  it('un rechazo del servidor se marca, no se reintenta y no frena a los siguientes', async () => {
    const res = await drainQueue(
      [item('a', 10), item('b', 20)],
      async (i) =>
        i.clientId === 'a' ? { kind: 'rejected', error: 'Falta el nombre' } : { kind: 'ok' },
      { now: 100 },
    );
    expect(res.sent).toEqual(['b']);
    expect(res.queue).toHaveLength(1);
    expect(res.queue[0]?.rejected).toBe('Falta el nombre');
    expect(pendingOf(res.queue)).toEqual([]);
    // Un segundo vaciado no vuelve a mandar el rechazado.
    const again = await drainQueue(res.queue, async () => ({ kind: 'ok' }), {
      now: 200,
      force: true,
    });
    expect(again.sent).toEqual([]);
  });

  it('idempotencia: el reintento lleva el mismo clientId', async () => {
    const seen: string[] = [];
    let n = 0;
    const send = async (i: QueuedSubmission): Promise<SendOutcome> => {
      seen.push(i.clientId);
      return ++n === 1 ? { kind: 'retry' } : { kind: 'ok' };
    };
    const first = await drainQueue([item('x', 10)], send, { now: 100 });
    const second = await drainQueue(first.queue, send, { now: 100, force: true });
    expect(seen).toEqual(['x', 'x']);
    expect(second.queue).toEqual([]);
  });

  it('sólo toca la cola de su formulario', async () => {
    const res = await drainQueue(
      [item('a', 10, 'v:f'), item('b', 20, 'v:g')],
      async () => ({ kind: 'ok' }),
      { now: 100, key: 'v:g' },
    );
    expect(res.sent).toEqual(['b']);
    expect(res.queue.map((q) => q.clientId)).toEqual(['a']);
  });

  it('la espera crece y tiene tope', () => {
    expect(backoffMs(0)).toBe(0);
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(50)).toBe(600_000);
  });

  it('distingue falta de red de un rechazo de datos', () => {
    expect(isOfflineFailure({ online: false })).toBe(true);
    expect(isOfflineFailure({ online: true, thrown: true })).toBe(true);
    expect(isOfflineFailure({ online: true, status: 503 })).toBe(true);
    expect(isOfflineFailure({ online: true, status: 429 })).toBe(true);
    expect(isOfflineFailure({ online: true, status: 400 })).toBe(false);
    expect(isOfflineFailure({ online: true })).toBe(false);
  });
});

describe('mis últimos envíos', () => {
  const rec = (rowId: string, at: number, editUntil: number | null): SentRecord => ({
    rowId,
    at,
    summary: rowId,
    values: {},
    editToken: 't',
    editUntil,
  });
  it('conserva los más recientes sin repetir fila', () => {
    let list: SentRecord[] = [];
    for (let i = 0; i < 12; i++) list = pushSent(list, rec(`r${i}`, i, null));
    expect(list).toHaveLength(8);
    expect(list[0]?.rowId).toBe('r11');
    list = pushSent(list, rec('r5', 99, null));
    expect(list.filter((r) => r.rowId === 'r5')).toHaveLength(1);
    expect(list[0]?.rowId).toBe('r5');
  });
  it('corregir mientras dure la ventana', () => {
    const r = rec('a', 0, 10 * 60_000);
    expect(canCorrect(r, 5 * 60_000)).toBe(true);
    expect(minutesLeft(r, 5 * 60_000)).toBe(5);
    expect(canCorrect(r, 10 * 60_000)).toBe(false);
    expect(canCorrect(rec('b', 0, null), 0)).toBe(false);
    expect(minutesLeft(rec('b', 0, null), 0)).toBe(0);
  });
});

describe('fotos pendientes', () => {
  const pending = JSON.stringify({
    url: 'pending:abc',
    name: 'f.jpg',
    mime: 'image/jpeg',
    size: 3,
  });
  it('encuentra los ids y cambia la URL provisional por la real', () => {
    expect(pendingIds(pending)).toEqual(['abc']);
    expect(hasPending({ foto: pending, otro: 'x' })).toBe(true);
    const out = swapPending(pending, {
      abc: { url: '/api/files/blob/zzz', name: 'f.jpg', mime: 'image/jpeg', size: 3 },
    });
    expect(JSON.parse(out).url).toBe('/api/files/blob/zzz');
    expect(pendingIds(out)).toEqual([]);
  });
  it('mantiene el arreglo en campos múltiples y deja las ya subidas', () => {
    const multi = JSON.stringify([
      { url: '/api/files/blob/ya', name: 'a.jpg', mime: 'image/jpeg', size: 1 },
      { url: 'pending:p2', name: 'b.jpg', mime: 'image/jpeg', size: 1 },
    ]);
    const out = JSON.parse(
      swapPending(multi, {
        p2: { url: '/api/files/blob/n', name: 'b.jpg', mime: 'image/jpeg', size: 1 },
      }),
    );
    expect(out.map((f: { url: string }) => f.url)).toEqual([
      '/api/files/blob/ya',
      '/api/files/blob/n',
    ]);
  });
  it('para validar en pantalla la URL provisional cuenta como puesta', () => {
    expect(pendingIds(forValidation(pending))).toEqual([]);
    expect(forValidation('hola')).toBe('hola');
  });
});
