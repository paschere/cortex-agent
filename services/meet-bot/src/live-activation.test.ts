import assert from 'node:assert/strict';
import {
  LiveAudioResampler,
  isCortexDismissal,
  isCortexWake,
  liveEngagementExpired,
} from './live-activation';
assert.equal(isCortexWake('Oye Cortex, revisa la cartera'), true);
assert.equal(isCortexWake('revisemos la cartera'), false);
assert.equal(isCortexDismissal('Gracias Cortex, eso es todo'), true);
assert.equal(isCortexDismissal('Cortex, necesito el total'), false);
assert.equal(isCortexDismissal('Gracias Juan'), false);
assert.equal(liveEngagementExpired(30_000, 0, 0), true);
assert.equal(liveEngagementExpired(29_999, 0, 0), false);
assert.equal(liveEngagementExpired(180_000, 0, 179_999), true);
const input = Buffer.alloc(3200);
for (let i = 0; i < 1600; i++) input.writeInt16LE(Math.round(Math.sin(i / 16) * 20000), i * 2);
const all = new LiveAudioResampler().push(input);
const streaming = new LiveAudioResampler();
const chunks = Buffer.concat([
  streaming.push(input.subarray(0, 800)),
  streaming.push(input.subarray(800, 1800)),
  streaming.push(input.subarray(1800)),
]);
assert.equal(Math.abs(all.length - chunks.length) <= 2, true);
for (let i = 0; i + 1 < Math.min(all.length, chunks.length); i += 2)
  assert.ok(Math.abs(all.readInt16LE(i) - chunks.readInt16LE(i)) <= 1);
assert.ok(all.length >= 4796 && all.length <= 4800);
console.log('Live activation: wake, dismissal, idle/hard limits and streaming resampling passed');
