import assert from 'node:assert/strict';
import { callEndedFromSnapshot, callLostInCallChrome, type CallEndSnapshot } from './call-end';

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

const inCall: CallEndSnapshot = {
  url: 'https://meet.google.com/abc-defg-hij',
  headings: ['Team standup'],
  buttons: ['Turn off microphone', 'Leave call', 'Chat'],
  dialogs: [],
  hasParticipantTile: true,
  hasLeaveButton: true,
};

check('in-call is not ended', callEndedFromSnapshot(inCall).ended, false);
check('in-call still has chrome', callLostInCallChrome(inCall), false);

const endedEn: CallEndSnapshot = {
  url: 'https://meet.google.com/abc-defg-hij',
  headings: ['You left the meeting'],
  buttons: ['Rejoin', 'Return to home screen'],
  dialogs: [],
  hasParticipantTile: false,
  hasLeaveButton: false,
};
check('post-call rejoin ends it', callEndedFromSnapshot(endedEn).ended, true);

const hostEnded: CallEndSnapshot = {
  url: 'https://meet.google.com/abc-defg-hij',
  headings: ['This meeting has ended'],
  buttons: ['Return to home screen'],
  dialogs: [],
  hasParticipantTile: false,
  hasLeaveButton: false,
};
check('host ended the meeting', callEndedFromSnapshot(hostEnded).ended, true);

const endedEs: CallEndSnapshot = {
  url: 'https://meet.google.com/abc-defg-hij',
  headings: ['Saliste de la reunión'],
  buttons: ['Volver a unirse', 'Volver a la pantalla de inicio'],
  dialogs: [],
  hasParticipantTile: false,
  hasLeaveButton: false,
};
check('Spanish post-call ends it', callEndedFromSnapshot(endedEs).ended, true);

const landing: CallEndSnapshot = {
  url: 'https://meet.google.com/',
  headings: ['New meeting'],
  buttons: ['Start a meeting'],
  dialogs: [],
  hasParticipantTile: false,
  hasLeaveButton: false,
};
check('landing without a code is ended', callEndedFromSnapshot(landing).ended, true);

const chatNoise: CallEndSnapshot = {
  url: 'https://meet.google.com/abc-defg-hij',
  headings: ['Team standup'],
  buttons: ['Leave call'],
  dialogs: [],
  hasParticipantTile: true,
  hasLeaveButton: true,
};
check('chat talking about ending is not an end screen', callEndedFromSnapshot(chatNoise).ended, false);

const lostChrome: CallEndSnapshot = {
  url: 'https://meet.google.com/abc-defg-hij',
  headings: [],
  buttons: [],
  dialogs: [],
  hasParticipantTile: false,
  hasLeaveButton: false,
};
check('lost in-call chrome is detectable', callLostInCallChrome(lostChrome), true);
check('lost chrome alone is not instant end (roster/url decide)', callEndedFromSnapshot(lostChrome).ended, false);

if (failed) {
  console.error(`\n${failed} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`\n${passed} passed`);
