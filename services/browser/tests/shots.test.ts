import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShotStore } from '../src/shots';

const jpeg = (n: number) => Buffer.alloc(n, 1);

test('guarda y devuelve la foto sólo a su dueño y su pestaña', () => {
  const store = new ShotStore();
  const id = store.put('org:1', 's1', jpeg(2000));
  assert.ok(id);
  assert.equal(store.get('org:1', 's1', id)?.length, 2000);
  assert.equal(store.get('org:2', 's1', id), null);
  assert.equal(store.get('org:1', 's2', id), null);
  assert.equal(store.get('org:1', 's1', 'inexistente'), null);
});

test('una foto vacía o demasiado pesada no se guarda', () => {
  const store = new ShotStore();
  assert.equal(store.put('o', 's', jpeg(0)), null);
  assert.equal(store.put('o', 's', jpeg(500_000)), null);
  assert.equal(store.size, 0);
});

test('vence por tiempo', () => {
  const store = new ShotStore(1_000_000, 1000);
  const id = store.put('o', 's', jpeg(100), 0);
  assert.ok(id);
  assert.ok(store.get('o', 's', id, 500));
  assert.equal(store.get('o', 's', id, 2000), null);
  assert.equal(store.bytes, 0);
});

test('al llenarse el tope desaloja las más viejas y conserva la nueva', () => {
  const store = new ShotStore(5000, 1_000_000);
  const a = store.put('o', 's', jpeg(2000), 1);
  const b = store.put('o', 's', jpeg(2000), 2);
  const c = store.put('o', 's', jpeg(2000), 3);
  assert.ok(a && b && c);
  assert.equal(store.get('o', 's', a, 4), null);
  assert.ok(store.get('o', 's', b, 4));
  assert.ok(store.get('o', 's', c, 4));
  assert.ok(store.bytes <= 5000);
});
