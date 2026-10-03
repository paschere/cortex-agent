import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTBOX_PER_BEAT, gapMs, sanitizeOutbox, typingMs } from '../src/outbox';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('sólo chats 1:1, texto razonable, sin repetidos y pocos por latido', () => {
  const raw = [
    { id: id(1), jid: '573001112233@s.whatsapp.net', text: ' Hola, ya te reviso. ' },
    { id: id(2), jid: '120363000000000000@g.us', text: 'a un grupo' },
    { id: id(3), jid: 'status@broadcast', text: 'a un estado' },
    { id: id(1), jid: '573001112233@s.whatsapp.net', text: 'repetido' },
    { id: 'no-uuid', jid: '573001112233@s.whatsapp.net', text: 'x' },
    { id: id(4), jid: '573001112233@s.whatsapp.net', text: '   ' },
    { id: id(5), jid: '573001112233@s.whatsapp.net', text: 'x'.repeat(3001) },
  ];
  assert.deepEqual(sanitizeOutbox(raw), [
    { id: id(1), jid: '573001112233@s.whatsapp.net', text: 'Hola, ya te reviso.' },
  ]);
  assert.deepEqual(sanitizeOutbox(null), []);
  assert.deepEqual(sanitizeOutbox({}), []);

  const many = Array.from({ length: 20 }, (_, i) => ({
    id: id(100 + i),
    jid: '573001112233@s.whatsapp.net',
    text: 'ok',
  }));
  assert.equal(sanitizeOutbox(many).length, OUTBOX_PER_BEAT);
});

test('ritmo de persona: escribiendo proporcional y con tope, pausa entre mensajes', () => {
  assert.equal(typingMs('hola'), 948);
  assert.equal(typingMs('x'.repeat(2000)), 4_500);
  assert.equal(
    gapMs(() => 0),
    1_500,
  );
  assert.equal(
    gapMs(() => 0.999),
    2_998,
  );
});
