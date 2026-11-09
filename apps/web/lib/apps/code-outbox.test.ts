import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CodeOp,
  CodeOutbox,
  type CodeOutboxState,
  type CodeOutboxStore,
  type SendResult,
  outcomeOf,
  parseLocalRef,
  resolveRefs,
  unresolvedRefs,
} from './code-outbox';

class MemStore implements CodeOutboxStore {
  ops = new Map<string, CodeOp>();
  blobs = new Map<string, Blob>();
  async load() {
    return [...this.ops.values()];
  }
  async put(op: CodeOp) {
    this.ops.set(op.clientId, op);
  }
  async remove(id: string) {
    this.ops.delete(id);
  }
  async putBlob(id: string, b: Blob) {
    this.blobs.set(id, b);
  }
  async getBlob(id: string) {
    return this.blobs.get(id) ?? null;
  }
  async removeBlob(id: string) {
    this.blobs.delete(id);
  }
}

type Sent = { op: string; args: Record<string, unknown>; file?: File };

function harness(opts: { online?: boolean } = {}) {
  const store = new MemStore();
  const sent: Sent[] = [];
  const states: CodeOutboxState[] = [];
  const sentTables: string[] = [];
  const env = { online: opts.online ?? false, t: 1_000, results: [] as SendResult[] };
  const box = new CodeOutbox({
    appKey: 'planta',
    userKey: 'u1',
    store,
    isOnline: () => env.online,
    now: () => env.t++,
    send: async (op, args, file) => {
      sent.push({ op, args, file });
      const next = env.results.shift();
      if (next) return next;
      if (op === 'tables.insert') return { ok: true, data: { id: `real-${sent.length}` } };
      if (op === 'files.upload') return { ok: true, data: { url: `https://f/${sent.length}.jpg` } };
      return { ok: true, data: {} };
    },
    onState: (s) => states.push(s),
    onSent: (t) => sentTables.push(t),
  });
  return { box, store, sent, states, sentTables, env };
}

beforeEach(() => vi.useRealTimers());

describe('referencias locales', () => {
  it('reconoce local:<id> y cambia solo las que conoce, también dentro de un JSON', () => {
    expect(parseLocalRef('local:abc-123456')).toBe('abc-123456');
    expect(parseLocalRef('local:x')).toBeNull();
    expect(parseLocalRef('otra')).toBeNull();
    const refs = new Map([['abc-123456', 'https://f/1.jpg']]);
    expect(
      resolveRefs(
        { foto: '[{"url":"local:abc-123456","name":"a"}]', otra: 'local:zzz-999999', n: 1 },
        refs,
      ),
    ).toEqual({ foto: '[{"url":"https://f/1.jpg","name":"a"}]', otra: 'local:zzz-999999', n: 1 });
    expect(unresolvedRefs({ a: ['local:zzz-999999', 'local:abc-123456'] }, refs)).toEqual([
      'zzz-999999',
    ]);
  });

  it('red caída o 5xx/429 = reintentar; un 4xx = rechazado', () => {
    expect(outcomeOf({ ok: false, error: 'x', status: 500 }, true)).toEqual({ kind: 'retry' });
    expect(outcomeOf({ ok: false, error: 'x', status: 429 }, true)).toEqual({ kind: 'retry' });
    expect(outcomeOf({ ok: false, error: 'x' }, false)).toEqual({ kind: 'retry' });
    expect(outcomeOf({ ok: false, error: 'No puedes', status: 403 }, true)).toEqual({
      kind: 'rejected',
      error: 'No puedes',
    });
    expect(outcomeOf({ ok: true, data: null }, true)).toEqual({ kind: 'ok' });
  });
});

describe('CodeOutbox: encolar y vaciar', () => {
  it('sin señal guarda, avisa el estado y no envía; al volver la señal sale en orden', async () => {
    const h = harness();
    await h.box.start();
    const a = await h.box.enqueue({
      op: 'tables.insert',
      args: { table: 'vuelos', values: { n: 1 } },
    });
    const b = await h.box.enqueue({
      op: 'tables.update',
      args: { table: 'vuelos', id: 'r9', values: { n: 2 } },
    });
    expect(a).toMatchObject({ queued: true });
    expect(a.ref).toBe(`local:${a.localId}`);
    expect(h.sent).toHaveLength(0);
    expect(h.box.state()).toMatchObject({ pending: 2, failed: 0, online: false });
    expect(h.store.ops.size).toBe(2);

    h.env.online = true;
    await h.box.drain(true);
    expect(h.sent.map((s) => s.op)).toEqual(['tables.insert', 'tables.update']);
    expect(h.store.ops.size).toBe(0);
    expect(h.box.state().pending).toBe(0);
    expect(h.sentTables).toEqual(['vuelos', 'vuelos']);
    expect(b.localId).not.toBe(a.localId);
  });

  it('un fallo de red detiene todo y reintenta con espera; lo de después no se adelanta', async () => {
    const h = harness({ online: true });
    await h.box.start();
    h.env.online = false;
    await h.box.enqueue({ op: 'tables.action', args: { table: 't', id: 'a', action: 'x' } });
    await h.box.enqueue({ op: 'tables.action', args: { table: 't', id: 'b', action: 'y' } });
    h.env.online = true;
    h.env.results = [{ ok: false, error: 'caído', status: 503 }];
    await h.box.drain(true);
    expect(h.sent).toHaveLength(1);
    expect(h.box.state().items.map((i) => i.state)).toEqual(['retrying', 'pending']);
    // Sin `force`, la espera creciente manda.
    await h.box.drain(false);
    expect(h.sent).toHaveLength(1);
    await h.box.drain(true);
    expect(h.sent.map((s) => s.args.id)).toEqual(['a', 'a', 'b']);
  });

  it('un rechazo del servidor queda a la vista, no frena otras filas, y se puede descartar o reintentar', async () => {
    const h = harness({ online: false });
    await h.box.start();
    await h.box.enqueue({ op: 'tables.update', args: { table: 't', id: 'a', values: { x: 1 } } });
    await h.box.enqueue({ op: 'tables.update', args: { table: 't', id: 'a', values: { x: 2 } } });
    await h.box.enqueue({ op: 'tables.update', args: { table: 't', id: 'b', values: { x: 3 } } });
    h.env.online = true;
    h.env.results = [{ ok: false, error: 'Dato inválido', status: 400 }];
    await h.box.drain(true);
    // La 2ª es de la misma fila rechazada: espera. La 3ª (otra fila) sale.
    expect(h.sent.map((s) => s.args.id)).toEqual(['a', 'b']);
    const st = h.box.state();
    expect(st).toMatchObject({ pending: 1, failed: 1 });
    expect(st.items[0]).toMatchObject({ state: 'rejected', error: 'Dato inválido' });
    await h.box.retry();
    expect(h.box.state()).toMatchObject({ pending: 0, failed: 0 });

    const h2 = harness({ online: false });
    await h2.box.start();
    const q = await h2.box.enqueue({
      op: 'files.upload',
      args: { table: 't', id: 'a', field: 'f' },
      file: new File(['hola'], 'foto.jpg', { type: 'image/jpeg' }),
    });
    expect(h2.store.blobs.size).toBe(1);
    await h2.box.discard(q.localId);
    expect(h2.store.blobs.size).toBe(0);
    expect(h2.box.state().items).toHaveLength(0);
  });

  it('el archivo guardado viaja al enviar y se borra del teléfono', async () => {
    const h = harness({ online: false });
    await h.box.start();
    await h.box.enqueue({
      op: 'files.upload',
      args: { table: 't', id: 'a', field: 'f', name: 'x' },
      file: new File(['hola'], 'foto.jpg', { type: 'image/jpeg' }),
    });
    h.env.online = true;
    await h.box.drain(true);
    expect(h.sent[0]?.file?.name).toBe('foto.jpg');
    expect(h.sent[0]?.file?.type).toBe('image/jpeg');
    expect(h.store.blobs.size).toBe(0);
  });

  it('el id de una fila creada sin señal se cambia por el real en lo que viene después', async () => {
    const h = harness({ online: false });
    await h.box.start();
    const ins = await h.box.enqueue({
      op: 'tables.insert',
      args: { table: 'vuelos', values: { n: 1 } },
    });
    expect(h.box.hasPendingFor('vuelos', ins.localId)).toBe(true);
    expect(h.box.dependsOnQueued({ table: 'vuelos', id: ins.localId })).toBe(true);
    await h.box.enqueue({
      op: 'tables.update',
      args: { table: 'vuelos', id: ins.localId, values: { n: 2 } },
    });
    await h.box.enqueue({
      op: 'files.upload',
      args: { table: 'vuelos', id: ins.ref, field: 'foto' },
      file: new File(['x'], 'f.jpg', { type: 'image/jpeg' }),
    });
    await h.box.enqueue({
      op: 'tables.action',
      args: { table: 'vuelos', id: ins.localId, action: 'cerrar' },
    });
    h.env.online = true;
    await h.box.drain(true);
    expect(h.sent.map((s) => s.op)).toEqual([
      'tables.insert',
      'tables.update',
      'files.upload',
      'tables.action',
    ]);
    expect(h.sent.slice(1).map((s) => s.args.id)).toEqual(['real-1', 'real-1', 'real-1']);
    expect(h.box.state().items).toHaveLength(0);
  });

  it('una referencia a un archivo subido en los valores se cambia por su URL', async () => {
    const h = harness({ online: false });
    await h.box.start();
    const up = await h.box.enqueue({
      op: 'files.upload',
      args: { table: 'vuelos', id: 'r1', field: 'foto' },
      file: new File(['x'], 'f.jpg', { type: 'image/jpeg' }),
    });
    await h.box.enqueue({
      op: 'tables.update',
      args: { table: 'vuelos', id: 'r2', values: { portada: up.ref } },
    });
    h.env.online = true;
    await h.box.drain(true);
    expect(h.sent[1]?.args.values).toEqual({ portada: 'https://f/1.jpg' });
  });

  it('si lo que produce la referencia fue rechazado, lo que depende de ella también', async () => {
    const h = harness({ online: false });
    await h.box.start();
    const up = await h.box.enqueue({
      op: 'files.upload',
      args: { table: 'vuelos', id: 'r1', field: 'foto' },
      file: new File(['x'], 'f.jpg', { type: 'image/jpeg' }),
    });
    await h.box.enqueue({
      op: 'tables.update',
      args: { table: 'vuelos', id: 'r2', values: { portada: up.ref } },
    });
    h.env.online = true;
    h.env.results = [{ ok: false, error: 'Muy pesado', status: 413 }];
    await h.box.drain(true);
    // La dependiente ni siquiera sale al servidor: se rechaza aquí.
    expect(h.sent).toHaveLength(1);
    const items = h.box.state().items;
    expect(items.map((i) => i.state)).toEqual(['rejected', 'rejected']);
    expect(items[1]?.error).toContain('anterior');
  });

  it('al iniciar recupera lo guardado y borra lo que dejó otra persona', async () => {
    const h = harness({ online: false });
    await h.box.start();
    await h.box.enqueue({ op: 'tables.insert', args: { table: 't', values: {} } });
    // Otra sesión en el mismo teléfono.
    const base = [...h.store.ops.values()][0] as CodeOp;
    h.store.ops.set('ajeno', { ...base, clientId: 'ajeno', userKey: 'u2' });
    h.store.blobs.set('b', new Blob(['x']));
    h.store.ops.set('ajeno', { ...base, clientId: 'ajeno', userKey: 'u2', blobId: 'b' });
    const again = new CodeOutbox({
      appKey: 'planta',
      userKey: 'u1',
      store: h.store,
      isOnline: () => false,
      send: async () => ({ ok: true, data: {} }),
    });
    await again.start();
    expect(again.state().items).toHaveLength(1);
    expect(h.store.ops.has('ajeno')).toBe(false);
    expect(h.store.blobs.size).toBe(0);
    again.stop();
    h.box.stop();
  });
});
