import assert from 'node:assert/strict';
import {
  normalizeAccent,
  parseCameraSpec,
  resolveVirtualCamera,
  virtualCamY4mBytes,
  virtualCameraScript,
} from './virtual-camera';

assert.equal(parseCameraSpec(undefined).mode, 'card');
assert.equal(parseCameraSpec('card').mode, 'card');
assert.equal(parseCameraSpec('OFF').mode, 'off');
assert.equal(parseCameraSpec('https://cdn.example/logo.png').mode, 'image');
assert.equal(parseCameraSpec('/app/intro.webm').mode, 'video');

assert.equal(normalizeAccent('#00AAFF'), '#00AAFF');
assert.equal(normalizeAccent('blue'), '#7C6AF7');

const y4m = virtualCamY4mBytes();
assert.equal(y4m.subarray(0, 10).toString(), 'YUV4MPEG2 ');
assert.ok(y4m.includes(Buffer.from('FRAME\n')));

const script = virtualCameraScript({
  mode: 'card',
  name: 'Nora',
  subtitle: 'tomando notas',
  accent: '#7C6AF7',
});
assert.ok(script.includes('captureStream'));
assert.ok(script.includes('getUserMedia'));
assert.ok(script.includes('replaceTrack'));
assert.ok(script.includes('Nora'));
assert.ok(script.includes('__cortexLocalVideoTrackId'));

async function main(): Promise<void> {
  const off = await resolveVirtualCamera({ spec: 'off', name: 'Cortex' });
  assert.equal(off.enabled, false);
  assert.equal(off.script, null);

  const card = await resolveVirtualCamera({ spec: 'card', name: 'Cortex' });
  assert.equal(card.enabled, true);
  assert.equal(card.mode, 'card');
  assert.ok(card.script?.includes('CORTEX'));

  console.log('virtual-camera.test ok');
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
