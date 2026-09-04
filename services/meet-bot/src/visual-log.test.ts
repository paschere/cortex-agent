import assert from 'node:assert/strict';
import { looksLikePresenting, rosterDiff, shouldTakeFrame } from './visual-log';

let passed = 0;
let failed = 0;

function check(name: string, actual: unknown, expected: unknown): void {
  try {
    assert.deepEqual(actual, expected);
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    passed++;
  } catch {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
    failed++;
  }
}

check('presentando is sharing', looksLikePresenting('Ana (presentando)'), true);
check('a plain name is not sharing', looksLikePresenting('Ana'), false);
check(
  'a presenting change always wants a frame',
  shouldTakeFrame({
    presentingChanged: true,
    presenting: false,
    secondsSinceFrame: 1,
    framesTaken: 0,
  }),
  true,
);
check(
  'quiet mosaic waits longer',
  shouldTakeFrame({
    presentingChanged: false,
    presenting: false,
    secondsSinceFrame: 20,
    framesTaken: 1,
  }),
  false,
);

const diff = rosterDiff(
  [{ id: 'a', name: 'Ana', presenting: true }],
  [{ id: 'a', name: 'Ana' }, { id: 'j', name: 'Juan', presenting: true }],
  9,
);
check(
  'roster diff reports a new presenter',
  diff.some((e) => e.kind === 'presenting' && e.speaker === 'Juan'),
  true,
);

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
