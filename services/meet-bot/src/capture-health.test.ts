import assert from 'node:assert/strict';
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
  'AudioWorklet replaces ScriptProcessor as the primary path',
  AUDIO_TAP_SCRIPT.includes('AudioWorkletProcessor') &&
    AUDIO_TAP_SCRIPT.includes('createMediaStreamSource'),
  true,
);
check(
  'sink elements are not display:none (Chrome stops decoding)',
  AUDIO_TAP_SCRIPT.includes("el.style.display = 'none'"),
  false,
);
check(
  'MediaElementSource is not the primary tap (muted/paused element = silence)',
  AUDIO_TAP_SCRIPT.includes('createMediaElementSource'),
  false,
);
check(
  'ended tracks are forgotten so Meet can recycle them',
  AUDIO_TAP_SCRIPT.includes('seenTrack.delete') && AUDIO_TAP_SCRIPT.includes("t.addEventListener('ended'"),
  true,
);
check('watchdog can rewire and restart the graph', AUDIO_TAP_SCRIPT.includes('rewire') && AUDIO_TAP_SCRIPT.includes('restart'), true);

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
