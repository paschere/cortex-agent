import assert from 'node:assert/strict';
import { looksLikeMicLabel, micCurrentlyOn, tileLooksLikeSelf, scoreMicButton } from './microphone';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    passed++;
  } catch {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    failed++;
  }
}

check('English turn-on means currently off', micCurrentlyOn('Turn on microphone', null, null), false);
check('English turn-off means currently on', micCurrentlyOn('Turn off microphone (ctrl + d)', null, null), true);
check('Spanish activar means currently off', micCurrentlyOn('Activar micrófono', null, null), false);
check('Spanish desactivar means currently on', micCurrentlyOn('Desactivar micrófono', null, null), true);
check('data-is-muted wins over a vague label', micCurrentlyOn('Microphone', 'true', null), false);
check('data-is-muted false is on', micCurrentlyOn('Microphone', 'false', null), true);
check('camera is not a mic', looksLikeMicLabel('Turn on camera'), false);
check('mic label matches', looksLikeMicLabel('Turn on microphone'), true);
check('Spanish mic label matches', looksLikeMicLabel('Activar micrófono'), true);
check('self-name attr is the local tile', tileLooksLikeSelf('Mateo Angel', true, 'Cortex'), true);
check('You tile is local', tileLooksLikeSelf('You', false, 'Cortex'), true);
check('bot name in aria is local', tileLooksLikeSelf('Cortex', false, 'Cortex'), true);
check('other participant is not local', tileLooksLikeSelf('Mateo Angel', false, 'Cortex'), false);
check(
  'a participant tile is not the mic button',
  scoreMicButton({
    label: '',
    mutedAttr: 'true',
    area: 640 * 360,
    yRatio: 0.4,
    tag: 'DIV',
  }),
  null,
);
check(
  'toolbar mic button scores',
  (scoreMicButton({
    label: 'Turn on microphone',
    mutedAttr: 'true',
    area: 48 * 48,
    yRatio: 0.92,
    tag: 'BUTTON',
  }) ?? 0) > 15,
  true,
);
check(
  'camera button is not scored as mic',
  scoreMicButton({
    label: 'Turn on camera',
    mutedAttr: null,
    area: 48 * 48,
    yRatio: 0.92,
    tag: 'BUTTON',
  }),
  null,
);

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
