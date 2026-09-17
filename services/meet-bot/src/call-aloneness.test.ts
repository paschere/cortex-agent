import assert from 'node:assert/strict';
import { heardRemoteAudio, shouldLeaveBySilence, shouldLeaveEmptyAndSilent } from './call-aloneness';

assert.equal(heardRemoteAudio(0), false);
assert.equal(heardRemoteAudio(0.02), true);

assert.equal(
  shouldLeaveEmptyAndSilent({
    sawOthers: true,
    othersCount: 0,
    emptyMs: 45_000,
    silentMs: 45_000,
    everyoneLeftTimeoutMs: 45_000,
  }),
  true,
  'empty + silent after others were here',
);

assert.equal(
  shouldLeaveEmptyAndSilent({
    sawOthers: true,
    othersCount: 0,
    emptyMs: 45_000,
    silentMs: 2_000,
    everyoneLeftTimeoutMs: 45_000,
  }),
  false,
  'empty roster during a refresh is not enough if audio is still there',
);

assert.equal(
  shouldLeaveEmptyAndSilent({
    sawOthers: false,
    othersCount: 0,
    emptyMs: 60_000,
    silentMs: 60_000,
    everyoneLeftTimeoutMs: 45_000,
  }),
  false,
  'never saw anyone — still waiting in lobby, do not leave as left_alone',
);

assert.equal(
  shouldLeaveBySilence({
    liveMs: 12 * 60_000,
    silentMs: 10 * 60_000,
    aloneSilenceMs: 10 * 60_000,
  }),
  true,
  'ten minutes of remote silence, like Vexa',
);

assert.equal(
  shouldLeaveBySilence({
    liveMs: 20_000,
    silentMs: 20_000,
    aloneSilenceMs: 10 * 60_000,
  }),
  false,
  'grace: just went live, do not leave',
);

console.log('call-aloneness.test ok');
