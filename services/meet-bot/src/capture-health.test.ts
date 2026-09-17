import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIO_TAP_SCRIPT } from './audio-tap';
import {
  chunksStalled,
  shouldRestartCapture,
  shouldRewireTracks,
  silentWhileLive,
} from './capture-health';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    passed++;
  } catch {
    console.log(
      `  \x1b[31mFAIL\x1b[0m  ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
    );
    failed++;
  }
}

check('chunks moving is not a stall', chunksStalled(100, 140), false);
check('same chunk count is a stall', chunksStalled(323, 323), true);
check('counter going backwards is a stall', chunksStalled(50, 10), true);

check('live tracks with peak 0 are silent', silentWhileLive({ live: 1, recentPeak: 0 }), true);
check('live tracks with audio are fine', silentWhileLive({ live: 1, recentPeak: 0.02 }), false);
check('no live tracks is not a wiring failure', silentWhileLive({ live: 0, recentPeak: 0 }), false);

check('one stall round does not restart', shouldRestartCapture(1), false);
check('two stall rounds restart the graph', shouldRestartCapture(2), true);

check(
  'DOM speaking + silence rewires after 1 round',
  shouldRewireTracks({ silentRounds: 1, speaker: 'Mateo Angel', live: 1, recentPeak: 0 }),
  true,
);
check(
  'DOM speaking + silence does not rewire on round 0',
  shouldRewireTracks({ silentRounds: 0, speaker: 'Mateo Angel', live: 1, recentPeak: 0 }),
  false,
);
check(
  'quiet room waits 3 rounds before rewire',
  shouldRewireTracks({ silentRounds: 2, speaker: null, live: 1, recentPeak: 0 }),
  false,
);
check(
  'quiet room rewires after 3 silent rounds',
  shouldRewireTracks({ silentRounds: 3, speaker: null, live: 1, recentPeak: 0 }),
  true,
);
check(
  'audio flowing never rewires',
  shouldRewireTracks({ silentRounds: 9, speaker: 'Ana', live: 2, recentPeak: 0.04 }),
  false,
);
check(
  'no wired tracks rewires after 1 silent round',
  shouldRewireTracks({ silentRounds: 1, speaker: 'Mateo Angel', live: 0, recentPeak: 0 }),
  true,
);
check(
  'no wired tracks wait one round',
  shouldRewireTracks({ silentRounds: 0, speaker: 'Mateo Angel', live: 0, recentPeak: 0 }),
  false,
);

check(
  'AudioWorklet is the capture processor',
  AUDIO_TAP_SCRIPT.includes('AudioWorkletProcessor'),
  true,
);
check(
  'sink elements are not display:none (Chrome stops decoding)',
  AUDIO_TAP_SCRIPT.includes("el.style.display = 'none'"),
  false,
);
check(
  'taps paused Meet elements that still have a live audio stream',
  AUDIO_TAP_SCRIPT.includes("el.paused) el.play()") &&
    AUDIO_TAP_SCRIPT.includes('createMediaStreamSource') &&
    !AUDIO_TAP_SCRIPT.includes('!el.paused &&'),
  true,
);
check(
  'wraps RTCPeerConnection so remote tracks are queued before the mixer exists',
  AUDIO_TAP_SCRIPT.includes('__cortexTapWrapped') && AUDIO_TAP_SCRIPT.includes('pendingStreams'),
  true,
);
check(
  'does not steal Meet elements with createMediaElementSource',
  AUDIO_TAP_SCRIPT.includes('createMediaElementSource'),
  false,
);
check(
  'AudioContext is 16 kHz like Vexa gmeet-capture',
  AUDIO_TAP_SCRIPT.includes('AudioContext)({ sampleRate: 16000 })'),
  true,
);
check(
  'local TTS mic is not mixed into STT',
  AUDIO_TAP_SCRIPT.includes('__cortexLocalTrackId'),
  true,
);
check(
  'ended tracks are forgotten so Meet can recycle them',
  AUDIO_TAP_SCRIPT.includes('connectedStreamIds.delete') && AUDIO_TAP_SCRIPT.includes("addEventListener('ended'"),
  true,
);
check('watchdog can rewire and restart the graph', AUDIO_TAP_SCRIPT.includes('rewire') && AUDIO_TAP_SCRIPT.includes('restart'), true);
check(
  'scene() reports who is presenting so the visual log can fire',
  AUDIO_TAP_SCRIPT.includes('scene:') && AUDIO_TAP_SCRIPT.includes('presenting'),
  true,
);
check(
  'roster names a lone remote even without a speaking class',
  AUDIO_TAP_SCRIPT.includes('function pickSpeaker') && AUDIO_TAP_SCRIPT.includes('unique.length === 1'),
  true,
);

const entry = readFileSync(join(process.cwd(), 'docker-entrypoint.sh'), 'utf8');
const docker = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
check(
  'container starts a PulseAudio dummy sink so Chrome decodes WebRTC',
  entry.includes('module-null-sink') && docker.includes('pulseaudio'),
  true,
);

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
