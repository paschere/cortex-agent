import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROUP_SEND_PER_DAY,
  GROUP_SEND_PER_GROUP_PER_HOUR,
  GroupSendLimiter,
  sanitizeGroupOutbox,
} from '../src/outbox';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const GROUP = '120363000000000000@g.us';

test('sólo grupos: una persona, un estado o texto vacío no pasan', () => {
  const raw = [
    { id: id(1), jid: GROUP, text: ' Buenos días ' },
    { id: id(2), jid: '573001112233@s.whatsapp.net', text: 'a una persona' },
    { id: id(3), jid: 'status@broadcast', text: 'a un estado' },
    { id: id(1), jid: GROUP, text: 'repetido' },
    { id: 'no-uuid', jid: GROUP, text: 'x' },
    { id: id(4), jid: GROUP, text: '  ' },
    { id: id(5), jid: GROUP, text: 'x'.repeat(1001) },
  ];
  assert.deepEqual(sanitizeGroupOutbox(raw), [{ id: id(1), jid: GROUP, text: 'Buenos días' }]);
  assert.deepEqual(sanitizeGroupOutbox(null), []);
});

test('pocos por latido', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: id(10 + i), jid: GROUP, text: 'ok' }));
  assert.equal(sanitizeGroupOutbox(many).length, 3);
});

test('tope por grupo y hora, y tope diario', () => {
  const lim = new GroupSendLimiter();
  const t0 = Date.parse('2026-10-07T12:00:00Z');
  for (let i = 0; i < GROUP_SEND_PER_GROUP_PER_HOUR; i++)
    assert.equal(lim.tryTake(GROUP, t0 + i), true);
  assert.equal(lim.tryTake(GROUP, t0 + 1000), false);
  // Otro grupo sigue pudiendo; una hora después el primero también.
  assert.equal(lim.tryTake('120363111111111111@g.us', t0 + 1000), true);
  assert.equal(lim.tryTake(GROUP, t0 + 3_700_000), true);

  const day = new GroupSendLimiter();
  let ok = 0;
  for (let i = 0; i < GROUP_SEND_PER_DAY + 10; i++) {
    const jid = `1203630000000000${String(i).padStart(2, '0')}@g.us`;
    if (day.tryTake(jid, t0 + i)) ok++;
  }
  assert.equal(ok, GROUP_SEND_PER_DAY);
});
