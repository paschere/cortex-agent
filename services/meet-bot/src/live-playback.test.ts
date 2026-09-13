import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { VOICE_INJECT_SCRIPT } from './voice-inject';
const sources: Array<{ stopped: boolean; stop: () => void; onended?: () => void }> = [];
const track = { id: 'mic', enabled: true, readyState: 'live' };
const context = {
  state: 'running',
  currentTime: 1,
  createMediaStreamDestination: () => ({ stream: { getAudioTracks: () => [track] } }),
  createGain: () => ({ gain: { value: 1 }, connect() {} }),
  createConstantSource: () => ({ connect() {}, start() {} }),
  createBuffer: (_channels: number, length: number, rate: number) => ({
    length,
    duration: length / rate,
    getChannelData: () => new Float32Array(length),
  }),
  createBufferSource: () => {
    const source = {
      stopped: false,
      connect() {},
      disconnect() {},
      start() {},
      stop() {
        this.stopped = true;
        this.onended?.();
      },
      onended: undefined as (() => void) | undefined,
    };
    sources.push(source);
    return source;
  },
};
class Devices {
  async enumerateDevices() {
    return [];
  }
  async getUserMedia() {
    return {};
  }
}
const win: Record<string, unknown> = {
  AudioContext: class {
    constructor() {
      Object.assign(this, context);
    }
  },
};
runInNewContext(VOICE_INJECT_SCRIPT, {
  window: win,
  navigator: new Devices(),
  MediaDevices: Devices,
  MediaStream: class {},
  atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
  setTimeout,
  Uint8Array,
  Int16Array,
});
const voice = win.__cortexVoice as {
  speakPcm: (b: string, rate: number) => void;
  isSpeaking: () => boolean;
  stopPlayback: () => void;
  mute: () => void;
};
const pcm = Buffer.alloc(4800).toString('base64');
voice.speakPcm(pcm, 24000);
voice.speakPcm(pcm, 24000);
assert.equal(voice.isSpeaking(), true);
voice.stopPlayback();
assert.ok(sources.every((s) => s.stopped));
assert.equal(voice.isSpeaking(), false);
voice.speakPcm(pcm, 24000);
assert.equal(sources[2].stopped, false);
voice.mute();
assert.equal(sources[2].stopped, true);
assert.equal(track.enabled, false);
console.log('Live playback: interruption clears scheduled audio; mute cannot leak old speech');
