import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { OpenAILiveTransport } from './openai-live';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;
  terminated = false;

  send(value: string): void {
    this.sent.push(value);
  }
  close(): void {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }
  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }
  message(event: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(event)));
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function main(): Promise<void> {
  const socket = new FakeSocket();
  let connection: { url: string; authorization: string } | null = null;
  const audio: Buffer[] = [];
  let clears = 0;
  const errors: Error[] = [];
  const delegations: Array<{ id: string; input: string }> = [];
  const transcripts: Array<{ role: string; text: string }> = [];
  let outputActivity = 0;
  const live = new OpenAILiveTransport({
    apiKey: 'secret',
    instructions: 'Habla en español.',
    voice: 'marin',
    onAudio: (chunk) => audio.push(chunk),
    onClearPlayback: () => {
      clears += 1;
    },
    onTranscript: (fragment) => transcripts.push(fragment),
    onOutputActivity: () => {
      outputActivity += 1;
    },
    onDelegation: async (request) => {
      delegations.push({ id: request.id, input: request.transcript.input });
      return 'Resultado verificado';
    },
    onError: (error) => errors.push(error),
    webSocketFactory: (url, options) => {
      connection = { url, authorization: String(options.headers?.Authorization) };
      return socket as unknown as WebSocket;
    },
  });

  const starting = live.start();
  socket.open();
  const start = JSON.parse(socket.sent[0] ?? '{}');
  assert.deepEqual(connection, {
    url: 'wss://api.openai.com/v1/live/sessions',
    authorization: 'Bearer secret',
  });
  assert.equal(start.type, 'session.start');
  assert.deepEqual(start.session.audio, {
    format: { type: 'audio/pcm', rate: 24_000 },
    output: { voice: 'marin' },
  });
  assert.deepEqual(start.session.delegation, { type: 'client' });
  socket.message({ type: 'session.started', session: { id: 'live_1' } });
  await starting;

  live.sendAudio(Buffer.from([1, 2, 3]));
  live.sendAudio(Buffer.from([4, 5, 6]));
  const appends = socket.sent
    .map((value) => JSON.parse(value))
    .filter((event) => event.type === 'session.input_audio.append');
  assert.deepEqual(
    appends.map((event) => Buffer.from(event.audio, 'base64')),
    [Buffer.from([1, 2]), Buffer.from([3, 4, 5, 6])],
  );

  socket.message({
    type: 'session.output_audio.delta',
    delta: Buffer.from([7, 8]).toString('base64'),
  });
  assert.deepEqual(audio, [Buffer.from([7, 8])]);
  assert.equal(outputActivity, 1);
  socket.message({ type: 'session.input_transcript.delta', delta: 'Busca el contrato' });
  socket.message({ type: 'session.input_transcript.delta', delta: ' por favor' });
  assert.equal(clears, 1, 'barge-in clears queued output only once');
  assert.deepEqual(transcripts, [
    { role: 'user', text: 'Busca el contrato' },
    { role: 'user', text: ' por favor' },
  ]);

  assert.equal(live.appendCommentary('Puedes hablar ahora.'), true);
  const commentary = socket.sent
    .map((value) => JSON.parse(value))
    .find((event) => event.type === 'session.commentary.append' && event.delegation_id === null);
  assert.equal(commentary.content, 'Puedes hablar ahora.');

  socket.message({
    type: 'session.delegation.created',
    offset_ms: 1200,
    delegation: { id: 'item_opaque', type: 'delegation', target: 'client' },
  });
  await tick();
  assert.deepEqual(delegations, [{ id: 'item_opaque', input: 'Busca el contrato por favor' }]);
  const result = socket.sent
    .map((value) => JSON.parse(value))
    .find(
      (event) =>
        event.type === 'session.commentary.append' && event.delegation_id === 'item_opaque',
    );
  assert.equal(result.delegation_id, 'item_opaque');
  assert.equal(result.content, 'Resultado verificado');

  const closing = live.close();
  assert.equal(JSON.parse(socket.sent.at(-1) ?? '{}').type, 'session.close');
  socket.message({ type: 'session.closed', reason: 'close_requested', usage: { seconds: 1 } });
  await closing;
  assert.equal(socket.closed, true);
  assert.deepEqual(errors, []);

  const failedSocket = new FakeSocket();
  const failedErrors: Error[] = [];
  const failed = new OpenAILiveTransport({
    apiKey: 'secret',
    instructions: '',
    onAudio: () => {},
    onClearPlayback: () => {},
    onDelegation: async () => '',
    onError: (error) => failedErrors.push(error),
    startTimeoutMs: 5,
    webSocketFactory: () => failedSocket as unknown as WebSocket,
  });
  await assert.rejects(failed.start(), /timed out/);
  assert.equal(failedSocket.terminated, true);
  assert.equal(failedErrors.length, 1);

  console.log('openai-live tests passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
