import assert from 'node:assert/strict';
import type { Config } from './config';
import { MeetLiveVoice } from './meet-live-voice';
import type { OpenAILiveOptions } from './openai-live';
async function main() {
  let created = 0;
  let sent = 0;
  let closed = 0;
  let played = 0;
  let captures = 0;
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.bootstrap)
      return Response.json({ instructions: 'Eres Cortex, gerente virtual de Empresa A.' });
    requests.push(body);
    return Response.json({ answer: 'Resultado verificado' });
  };
  let callbacks: OpenAILiveOptions | undefined;
  const voice = new MeetLiveVoice({
    config: {
      openaiKey: 'synthetic',
      cortexBaseUrl: 'https://cortex.invalid',
      serviceToken: 'test',
    } as Config,
    captureView: async () => {
      captures++;
      return { imageBase64: 'synthetic', capturedAt: Date.now(), scope: 'meeting-viewport' };
    },
    owner: 'org-a',
    sessionId: 'call-a',
    audio: async () => {
      played++;
    },
    clear: async () => {},
    transcript: () => {},
    status: () => {},
    createTransport: (opts) => {
      created++;
      callbacks = opts;
      return {
        start: async () => {},
        sendAudio: () => {
          sent++;
        },
        appendCommentary: () => true,
        close: async () => {
          closed++;
        },
      };
    },
  });
  voice.push(Buffer.alloc(320));
  assert.equal(created, 0);
  assert.equal(sent, 0);
  await Promise.all([voice.wake(), voice.wake()]);
  assert.equal(created, 1);
  assert.match(callbacks?.instructions ?? '', /Empresa A/);
  assert.equal(callbacks?.voice, 'bossa');
  await callbacks?.onDelegation({
    id: 'd1',
    offsetMs: 0,
    transcript: { input: 'Mira lo que estoy mostrando', output: '' },
  });
  assert.equal(captures, 1);
  assert.equal(requests[0].visualRequested, true);
  await callbacks?.onDelegation({
    id: 'd2',
    offsetMs: 1,
    transcript: { input: 'Mira lo que estoy mostrando. Ahora busca mi factura.', output: '' },
  });
  assert.equal(captures, 1, 'earlier visual request cannot cause another capture');
  assert.equal(requests[1].visualRequested, false);
  assert.equal(requests[1].visual, undefined);
  globalThis.fetch = originalFetch;
  voice.push(Buffer.alloc(320));
  assert.equal(sent, 1);
  callbacks?.onAudio(Buffer.alloc(480));
  voice.setMuted(true);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(played, 0, 'queued audio discarded immediately on mute');
  assert.equal(closed, 1);
  voice.push(Buffer.alloc(320));
  await voice.wake();
  assert.equal(sent, 1);
  assert.equal(created, 1);
  await voice.sleep();
  let releaseBootstrap: ((response: Response) => void) | undefined;
  let cancelledCreated = 0;
  globalThis.fetch = async () =>
    new Promise<Response>((resolve) => {
      releaseBootstrap = resolve;
    });
  const cancelled = new MeetLiveVoice({
    config: {
      openaiKey: 'synthetic',
      cortexBaseUrl: 'https://cortex.invalid',
      serviceToken: 'test',
    } as Config,
    owner: 'org-b',
    sessionId: 'call-b',
    audio: async () => {},
    clear: async () => {},
    transcript: () => {},
    status: () => {},
    createTransport: () => {
      cancelledCreated++;
      throw new Error('must not connect after mute');
    },
  });
  const pending = cancelled.wake();
  cancelled.setMuted(true);
  releaseBootstrap?.(Response.json({ instructions: 'Cortex empresa B' }));
  await pending;
  assert.equal(cancelledCreated, 0, 'mute during context loading cannot open a billable session');
  globalThis.fetch = async () => new Response('', { status: 503 });
  cancelled.setMuted(false);
  const unavailable = new MeetLiveVoice({
    config: {
      openaiKey: 'synthetic',
      cortexBaseUrl: 'https://cortex.invalid',
      serviceToken: 'test',
    } as Config,
    owner: 'org-c',
    sessionId: 'call-c',
    audio: async () => {},
    clear: async () => {},
    transcript: () => {},
    status: () => {},
    createTransport: () => {
      cancelledCreated++;
      throw new Error('must not connect without identity');
    },
  });
  await unavailable.wake();
  assert.equal(cancelledCreated, 0, 'missing company context fails closed');
  globalThis.fetch = originalFetch;
  console.log(
    'Meet Live: zero standby cloud audio, one session per wake, mute closes billing and stale playback',
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
