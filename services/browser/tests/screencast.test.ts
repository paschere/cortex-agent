import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import type { WebSocket } from 'ws';
import { Screencast } from '../src/screencast';

test('stream ignores late ACKs and drops frames under socket backpressure', async () => {
  const calls: { method: string; args: unknown }[] = [];
  const cdp = Object.assign(new EventEmitter(), {
    send: async (method: string, args: unknown) => {
      calls.push({ method, args });
    },
    detach: async () => {},
  });
  const page = { context: () => ({ newCDPSession: async () => cdp }) } as unknown as Page;
  const sent: string[] = [];
  const socket = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: (s: string) => sent.push(s),
    close: () => {},
  });
  const cast = new Screencast(page, { width: 1000, height: 700 }, () => true);
  await cast.attach(socket as unknown as WebSocket);
  try {
    cdp.emit('Page.screencastFrame', { sessionId: 10, data: 'jpeg' });
    const first = JSON.parse(sent[0]!);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'ack', sequence: first.sequence })));
    cdp.emit('Page.screencastFrame', { sessionId: 11, data: 'jpeg' });
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'ack', sequence: first.sequence })));
    assert.equal(calls.filter((c) => c.method === 'Page.screencastFrameAck').length, 1);
    const second = JSON.parse(sent[1]!);
    socket.emit('message', Buffer.from(JSON.stringify({ type: 'ack', sequence: second.sequence })));
    assert.equal(calls.filter((c) => c.method === 'Page.screencastFrameAck').length, 2);
    socket.bufferedAmount = 600000;
    cdp.emit('Page.screencastFrame', { sessionId: 12, data: 'jpeg' });
    assert.equal(sent.length, 2, 'congested clients do not accumulate stale images');
    assert.equal(calls.filter((c) => c.method === 'Page.screencastFrameAck').length, 3);
  } finally {
    await cast.stop();
  }
});
