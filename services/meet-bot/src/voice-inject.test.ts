import assert from 'node:assert/strict';
import { getJoinBrowserArgs, JOIN_BROWSER_ARGS, silentMicWavBytes } from './join/browser-args';
import {
  extractQuestion,
  HOLD_LINES,
  isBotSpeaker,
  isEchoOfBot,
  joinUtterances,
  looksLikeFloorGrant,
  looksLikeIncompleteQuestion,
  looksLikeVoiceChitchat,
  pickHoldLine,
  questionGatherMs,
  roomHasHumanSpeech,
  samePerson,
  shouldRaiseHand,
  someoneElseSpeakingOnRoster,
} from './voice-brain';
import { VOICE_INJECT_SCRIPT } from './voice-inject';
import { sseBlockToText, takeClauses } from './voice-stream';
import { figuresForTts, integerToSpanish } from './voice-figures';

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
check('a short fragment is not chitchat', looksLikeVoiceChitchat('podrías'), false);
check('podrías averiguar is still incomplete', looksLikeIncompleteQuestion('podrías averiguar'), true);
check(
  'a full CRM ask is complete',
  looksLikeIncompleteQuestion('cuánto le cotizamos a Acme'),
  false,
);
check('hola is a complete greeting', looksLikeIncompleteQuestion('hola'), false);
check('just the name is incomplete', looksLikeIncompleteQuestion(''), true);
check(
  'a greeting does not raise the hand even if someone is talking',
  shouldRaiseHand('hola', { someoneElseSpeaking: true }),
  false,
);
check(
  'a CRM ask in a quiet room does not raise the hand',
  shouldRaiseHand('cuánto le cotizamos a Acme', { someoneElseSpeaking: false }),
  false,
);
check(
  'a CRM ask raises the hand only if someone else is talking',
  shouldRaiseHand('cuánto le cotizamos a Acme', { someoneElseSpeaking: true }),
  true,
);
check('Mateo and Mateo Angel are the same person', samePerson('Mateo', 'Mateo Angel'), true);
check(
  'the asker speaking is not someone else',
  someoneElseSpeakingOnRoster(
    [
      { name: 'Ana', speaking: true },
      { name: 'Juan', speaking: false },
    ],
    'Ana',
  ),
  false,
);
check(
  'Juan talking after Ana asked is someone else',
  someoneElseSpeakingOnRoster(
    [
      { name: 'Ana', speaking: false },
      { name: 'Juan', speaking: true },
    ],
    'Ana',
  ),
  true,
);
check(
  'a silent mosaic is not a busy floor',
  roomHasHumanSpeech([
    { name: 'Ana', speaking: false },
    { name: 'Juan', speaking: false },
  ]),
  false,
);
check('incomplete wait is longer than a greeting', questionGatherMs('podrías averiguar') > questionGatherMs('hola'), true);
check('just the name waits even longer', questionGatherMs('') > questionGatherMs('podrías averiguar'), true);
check(
  'two finals become one question',
  extractQuestion(joinUtterances(['Cortex podrías averiguar', 'cuánto le cotizamos a Acme'])),
  'podrías averiguar cuánto le cotizamos a Acme',
);
check('Cortex is the bot speaker', isBotSpeaker('Cortex', 'Cortex'), true);
check('a person is not the bot speaker', isBotSpeaker('Mateo Angel', 'Cortex'), false);
check('STT echo of a hold line is dropped', isEchoOfBot('dame un minuto', 'Dame un minuto.'), true);
check('a different line is not an echo', isEchoOfBot('cuánto le cotizamos', 'Dame un minuto.'), false);
check('sí adelante Cortex grants the floor', looksLikeFloorGrant('Sí, adelante Cortex'), true);
check('te escuchamos grants the floor', looksLikeFloorGrant('Te escuchamos'), true);
check('go ahead Cortex grants the floor', looksLikeFloorGrant('Go ahead Cortex'), true);
check('ok Cortex grants the floor', looksLikeFloorGrant('Ok Cortex'), true);
check(
  'Sí Cortex grants the floor (prod STT of adelante Cortex)',
  looksLikeFloorGrant('Sí, Cortex.'),
  true,
);
check('a yes alone does not grant the floor', looksLikeFloorGrant('sí'), false);
check('the original question is not a floor grant', looksLikeFloorGrant('cuánto le cotizamos a Acme'), false);
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
  'exposes the TTS track id so the tap does not mix it into STT',
  VOICE_INJECT_SCRIPT.includes('__cortexLocalTrackId'),
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
  'does not split a Colombian TRM at the first digit',
  takeClauses('La TRM está en 4.247,52 pesos. Sobre la DIAN hay plazo.'),
  { clauses: ['La TRM está en 4.247,52 pesos.'], rest: 'Sobre la DIAN hay plazo.' },
);
check(
  'SSE text events become clauses',
  sseBlockToText('event: text\ndata: {"text":"Dame un minuto."}'),
  { text: 'Dame un minuto.', done: false },
);
check('SSE done stops the stream', sseBlockToText('event: done\ndata: {}'), { text: null, done: true });

check('4247 is four thousand in Spanish', integerToSpanish(4247), 'cuatro mil doscientos cuarenta y siete');
check('21 thousand uses veintiún', integerToSpanish(21000, true), 'veintiún mil');
check('one million', integerToSpanish(1_000_000), 'un millón');
check(
  'Colombian TRM becomes words for Aura',
  figuresForTts('La TRM está en 4.247,52 pesos.'),
  'La TRM está en cuatro mil doscientos cuarenta y siete con cincuenta y dos pesos.',
);
check(
  'a dollar amount is spoken as pesos when marked with $',
  figuresForTts('Son $1.250.000.'),
  'Son un millón doscientos cincuenta mil pesos.',
);
check('percentages keep por ciento', figuresForTts('Subió 12,5%.'), 'Subió doce coma cinco por ciento.');
check('a year is dos mil…', figuresForTts('En 2026 cerramos.'), 'En dos mil veintiséis cerramos.');
check('small counts stay as digits', figuresForTts('Hay 3 opciones.'), 'Hay 3 opciones.');
check('versions are left alone', figuresForTts('Usa la 1.2.3.'), 'Usa la 1.2.3.');
check('a NIT is left alone', figuresForTts('NIT 900.123.456-7.'), 'NIT 900.123.456-7.');

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
