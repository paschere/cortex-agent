import assert from 'node:assert/strict';
import type { Transcript } from './deepgram';
import { LiveCaptions, retainTranscript } from './live-captions';
const captions = new LiveCaptions('meeting:wake', 10);
const rows: Transcript[] = [];
const first = captions.append({ role: 'user', text: 'Mira', startMs: 100, endMs: 300 }, 0);
retainTranscript(rows, first);
const assistant = captions.append(
  { role: 'assistant', text: 'Claro', startMs: 200, endMs: 400 },
  0,
);
retainTranscript(rows, assistant);
retainTranscript(
  rows,
  captions.append({ role: 'user', text: ' mi pantalla', startMs: 400, endMs: 700 }, 0),
);
assert.equal(rows.length, 2);
assert.equal(rows[0].id, first.id);
assert.equal(rows[0].text, 'Mira mi pantalla');
assert.equal(rows[0].at, 10.1);
assert.equal(rows[0].isFinal, false);
assert.equal(rows[0].fragments?.length, 2);
const later = captions.append(
  { role: 'user', text: 'Otra pregunta', startMs: 5000, endMs: 5300 },
  0,
);
retainTranscript(rows, later);
assert.notEqual(later.id, first.id);
retainTranscript(
  rows,
  captions.append({ role: 'user', text: ' ahora', startMs: 710, endMs: 900 }, 0),
);
assert.equal(rows[0].text, 'Mira mi pantalla ahora', 'late text updates earlier row');
assert.equal(rows.length, 3);
retainTranscript(rows, { text: 'partial', speaker: null, at: 20, isFinal: false });
assert.equal(rows.length, 3);
console.log(
  'Live captions: exact fragments, overlapping speakers, stable updates, late text and snapshots pass',
);
