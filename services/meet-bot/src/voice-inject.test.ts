import assert from 'node:assert/strict';
import { getJoinBrowserArgs, JOIN_BROWSER_ARGS, silentMicWavBytes } from './join/browser-args';
import { extractQuestion, HOLD_LINES, looksLikeVoiceChitchat, pickHoldLine } from './voice-brain';
import { VOICE_INJECT_SCRIPT } from './voice-inject';
import { sseBlockToText, takeClauses } from './voice-stream';

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

check('hola Cortex is a trigger', extractQuestion('Hola, Cortex.') !== null, true);
check('oye Cortex with a question', extractQuestion('Oye Cortex, ¿puedes hablar?'), 'puedes hablar?');
check('name at the start', extractQuestion('Cortex, ¿puedes hablar?'), 'puedes hablar?');
check('a line without the name is not a trigger', extractQuestion('¿quién toma notas?'), null);
check('cómo estás is chitchat', looksLikeVoiceChitchat('cómo estás?'), true);
check('puedes hablar is chitchat', looksLikeVoiceChitchat('puedes hablar?'), true);
check('a CRM question is not chitchat', looksLikeVoiceChitchat('cuánto le cotizamos a Acme'), false);
check('hold lines are short spoken asides', HOLD_LINES.every((l) => l.length >= 8 && l.length <= 40), true);
check('pickHoldLine stays in the set', HOLD_LINES.includes(pickHoldLine(() => 0) as (typeof HOLD_LINES)[number]), true);

check(
  'patches the MediaDevices prototype so Meet cannot bypass the wrapper',
  VOICE_INJECT_SCRIPT.includes('MediaDevices.prototype.getUserMedia'),
  true,
);
check(
  'replaceTrack puts the TTS track on Meet senders even when gumAudio is 0',
  VOICE_INJECT_SCRIPT.includes('replaceTrack'),
  true,
);
check(
  'keeps the destination track alive so WebRTC does not freeze a muted mic',
  VOICE_INJECT_SCRIPT.includes('createConstantSource'),
  true,
);
check(
  'enumerates a virtual mic when Chrome sees no hardware',
  VOICE_INJECT_SCRIPT.includes('enumerateDevices') && VOICE_INJECT_SCRIPT.includes('audioinput'),
  true,
);
check(
  'Chrome is launched with a fake audio device so Meet sees a microphone',
  JOIN_BROWSER_ARGS.includes('--use-fake-device-for-media-stream'),
  true,
);
check('silent wav is a RIFF file', silentMicWavBytes().subarray(0, 4).toString(), 'RIFF');
check(
  'fake capture file is passed to Chrome',
  getJoinBrowserArgs().some((a) => a.startsWith('--use-file-for-fake-audio-capture=')),
  true,
);
check(
  'streams PCM into the mic instead of waiting for a full WAV',
  VOICE_INJECT_SCRIPT.includes('speakPcm') && VOICE_INJECT_SCRIPT.includes('beginSpeak'),
  true,
);

check(
  'splits the model into speakable clauses',
  takeClauses('Hola. Qué tal. más'),
  { clauses: ['Hola.', 'Qué tal.'], rest: 'más' },
);
check(
  'SSE text events become clauses',
  sseBlockToText('event: text\ndata: {"text":"Dame un minuto."}'),
  { text: 'Dame un minuto.', done: false },
);
check('SSE done stops the stream', sseBlockToText('event: done\ndata: {}'), { text: null, done: true });

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
