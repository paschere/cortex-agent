import assert from 'node:assert/strict';
import { cleanMeetName, resolveHeardSpeaker, usableSpeakerName } from './meet-speaker';

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

check(
  'English Meet aria keeps the person, not the chrome',
  cleanMeetName('Mateo Angel, camera on, microphone on'),
  'Mateo Angel',
);
check(
  'English Meet aria with devices off',
  cleanMeetName('Ana García, microphone is off, camera is off'),
  'Ana García',
);
check(
  'Spanish Meet aria',
  cleanMeetName('Ana García, micrófono desactivado, cámara desactivada'),
  'Ana García',
);
check('is speaking suffix', cleanMeetName('Juan Restrepo is speaking'), 'Juan Restrepo');
check('está hablando suffix', cleanMeetName('Juan Restrepo está hablando'), 'Juan Restrepo');
check('presenting in parentheses', cleanMeetName('Mateo (presenting)'), 'Mateo');
check('You is not a name', cleanMeetName('You'), null);
check('Tú is not a name', cleanMeetName('Tú'), null);
check('Participant placeholder is not a name', cleanMeetName('Participant 2'), null);
check('effects tile is skipped', cleanMeetName('Backgrounds and effects'), null);
check('already-clean names pass through', cleanMeetName('Mateo Angel'), 'Mateo Angel');

check('Participante placeholder is not usable', usableSpeakerName('Participante'), null);
check('bot name is not a human speaker', usableSpeakerName('Cortex', 'Cortex'), null);

check(
  'GPT-Live with no hint uses the only other person',
  resolveHeardSpeaker({
    hinted: null,
    roster: [
      { name: 'Cortex', self: true },
      { name: 'Ana García', speaking: false, self: false },
    ],
    botName: 'Cortex',
  }),
  'Ana García',
);
check(
  'speaking remote wins over a leftover last speaker',
  resolveHeardSpeaker({
    hinted: null,
    roster: [
      { name: 'Ana', speaking: false, self: false },
      { name: 'Juan', speaking: true, self: false },
    ],
    lastSpeaker: 'Ana',
    botName: 'Cortex',
  }),
  'Juan',
);
check(
  'keeps the last speaker when Meet drops the speaking flag',
  resolveHeardSpeaker({
    hinted: null,
    roster: [
      { name: 'Ana', speaking: false, self: false },
      { name: 'Juan', speaking: false, self: false },
    ],
    lastSpeaker: 'Ana',
    botName: 'Cortex',
  }),
  'Ana',
);
check(
  'hinted name from the tap wins',
  resolveHeardSpeaker({
    hinted: 'Mateo Angel, camera off',
    roster: [{ name: 'Ana', speaking: true, self: false }],
    botName: 'Cortex',
  }),
  'Mateo Angel',
);
check(
  'does not label the bot as the human',
  resolveHeardSpeaker({
    hinted: null,
    roster: [
      { name: 'Cortex', speaking: true, self: true },
      { name: 'Ana', speaking: false, self: false },
    ],
    botName: 'Cortex',
  }),
  'Ana',
);
check(
  'stays unnamed when several people could have spoken',
  resolveHeardSpeaker({
    hinted: null,
    roster: [
      { name: 'Ana', speaking: false, self: false },
      { name: 'Juan', speaking: false, self: false },
    ],
    botName: 'Cortex',
  }),
  null,
);

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
