import assert from 'node:assert/strict';
import type { Config } from './config';
import { MeetLiveVoice } from './meet-live-voice';
import type { OpenAILiveOptions } from './openai-live';
async function main() {
  let created = 0;
  let sent = 0;
  let closed = 0;
  let played = 0;
  let callbacks: OpenAILiveOptions | undefined;
  const voice = new MeetLiveVoice({
    config: { openaiKey: 'synthetic' } as Config,
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
  console.log(
    'Meet Live: zero standby cloud audio, one session per wake, mute closes billing and stale playback',
  );
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
