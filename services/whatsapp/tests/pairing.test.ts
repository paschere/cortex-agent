import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isPaired } from '../src/auth-state';
import {
  CLOSE_CODES,
  NO_REQUEST,
  type PairingRequest,
  type ReconnectPolicy,
  backoffFor,
  decideOnClose,
  decideOnHeartbeat,
  idleStatus,
} from '../src/pairing';

const policy: ReconnectPolicy = {
  minBackoffMs: 2_000,
  maxBackoffMs: 5 * 60_000,
  pairingRetryMs: 3_000,
  pairingMaxBackoffMs: 30_000,
};

const qr: PairingRequest = { requested: true, phone: null };
const code: PairingRequest = { requested: true, phone: '573001112233' };
const top = () => 1; // worst case of the jitter: the ceiling itself

test('idle → requested → QR refresh loop → request lapses → idle', () => {
  // Unpaired and nobody asking: no socket, nothing to do on a heartbeat.
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: false,
      reconnectPending: false,
      socketPhone: null,
      request: NO_REQUEST,
    }),
    { kind: 'none' },
  );

  // An admin pressed «Mostrar código QR»: the next heartbeat opens a socket.
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: false,
      reconnectPending: false,
      socketPhone: null,
      request: qr,
    }),
    { kind: 'connect' },
  );

  // Six QRs later WhatsApp closes with "QR refs attempts ended" (408). While the
  // request is alive the next window opens after the fixed pause, every time,
  // with no growth and without counting attempts.
  let attempt = 0;
  for (let window = 0; window < 50; window++) {
    const decision = decideOnClose(
      { paired: false, statusCode: CLOSE_CODES.timedOut, request: qr, attempt, stopping: false },
      policy,
      top,
    );
    assert.deepEqual(decision, { kind: 'reconnect', delayMs: 3_000, attempt: 0 });
    attempt = decision.kind === 'reconnect' ? decision.attempt : attempt;
  }

  // While a socket is up and the request is alive, the heartbeat leaves it be.
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: true,
      reconnectPending: false,
      socketPhone: null,
      request: qr,
    }),
    { kind: 'none' },
  );

  // Nobody has looked for three minutes: the heartbeat closes the socket...
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: true,
      reconnectPending: false,
      socketPhone: null,
      request: NO_REQUEST,
    }),
    { kind: 'close' },
  );
  // ...or cancels a reconnect that was waiting to open the next window...
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: false,
      reconnectPending: true,
      socketPhone: null,
      request: NO_REQUEST,
    }),
    { kind: 'close' },
  );
  // ...and a QR window that runs out after that does not reopen anything.
  assert.deepEqual(
    decideOnClose(
      {
        paired: false,
        statusCode: CLOSE_CODES.timedOut,
        request: NO_REQUEST,
        attempt: 0,
        stopping: false,
      },
      policy,
    ),
    { kind: 'idle' },
  );
});

test('a scheduled reconnect is not raced by a second socket', () => {
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: false,
      reconnectPending: true,
      socketPhone: null,
      request: qr,
    }),
    { kind: 'none' },
  );
});

test('code mode: switching between QR and code, or the number, reopens the socket', () => {
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: false,
      reconnectPending: false,
      socketPhone: null,
      request: code,
    }),
    { kind: 'connect' },
  );
  // Same number as the open socket: keep it, the code on screen stays valid.
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: true,
      reconnectPending: false,
      socketPhone: '573001112233',
      request: code,
    }),
    { kind: 'none' },
  );
  // QR socket, code requested.
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: true,
      reconnectPending: false,
      socketPhone: null,
      request: code,
    }),
    { kind: 'restart' },
  );
  // Another number typed.
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: true,
      reconnectPending: false,
      socketPhone: '573009998877',
      request: code,
    }),
    { kind: 'restart' },
  );
  // Code socket, back to QR.
  assert.deepEqual(
    decideOnHeartbeat({
      paired: false,
      socketActive: true,
      reconnectPending: false,
      socketPhone: '573001112233',
      request: qr,
    }),
    { kind: 'restart' },
  );
  // A code that ran out with its socket is replaced by the next one quickly.
  assert.deepEqual(
    decideOnClose(
      {
        paired: false,
        statusCode: CLOSE_CODES.timedOut,
        request: code,
        attempt: 0,
        stopping: false,
      },
      policy,
    ),
    { kind: 'reconnect', delayMs: 3_000, attempt: 0 },
  );
});

test('an unexpected failure while pairing backs off, but never into minutes', () => {
  let attempt = 0;
  for (let i = 0; i < 30; i++) {
    const decision = decideOnClose(
      { paired: false, statusCode: 500, request: qr, attempt, stopping: false },
      policy,
      top,
    );
    assert.equal(decision.kind, 'reconnect');
    if (decision.kind !== 'reconnect') return;
    assert.ok(decision.delayMs >= policy.pairingRetryMs);
    assert.ok(decision.delayMs <= policy.pairingMaxBackoffMs);
    attempt = decision.attempt;
  }
  assert.equal(attempt, 30);
});

test('paired: real disconnects keep the exponential backoff', () => {
  const first = decideOnClose(
    { paired: true, statusCode: 428, request: NO_REQUEST, attempt: 0, stopping: false },
    policy,
    top,
  );
  assert.deepEqual(first, { kind: 'reconnect', delayMs: 4_000, attempt: 1 });

  const later = decideOnClose(
    { paired: true, statusCode: 428, request: NO_REQUEST, attempt: 9, stopping: false },
    policy,
    top,
  );
  assert.deepEqual(later, { kind: 'reconnect', delayMs: policy.maxBackoffMs, attempt: 10 });

  // A pairing request is irrelevant once paired: same answer with or without.
  assert.deepEqual(
    decideOnClose(
      { paired: true, statusCode: 428, request: qr, attempt: 0, stopping: false },
      policy,
      top,
    ),
    first,
  );
  assert.deepEqual(
    decideOnHeartbeat({
      paired: true,
      socketActive: false,
      reconnectPending: true,
      socketPhone: null,
      request: NO_REQUEST,
    }),
    { kind: 'none' },
  );
});

test('paired: the restart right after pairing reconnects like any paired close', () => {
  assert.deepEqual(
    decideOnClose(
      {
        paired: true,
        statusCode: CLOSE_CODES.restartRequired,
        request: qr,
        attempt: 0,
        stopping: false,
      },
      policy,
      () => 0,
    ),
    { kind: 'reconnect', delayMs: policy.minBackoffMs, attempt: 1 },
  );
});

test('paired: loggedOut is never retried', () => {
  assert.deepEqual(
    decideOnClose(
      {
        paired: true,
        statusCode: CLOSE_CODES.loggedOut,
        request: NO_REQUEST,
        attempt: 3,
        stopping: false,
      },
      policy,
    ),
    { kind: 'logged_out' },
  );
});

test('shutting down wins over everything', () => {
  assert.deepEqual(
    decideOnClose(
      { paired: true, statusCode: 428, request: qr, attempt: 0, stopping: true },
      policy,
    ),
    { kind: 'stop' },
  );
});

test('idle status keeps "logged out" until somebody re-pairs', () => {
  assert.equal(idleStatus('logged_out'), 'logged_out');
  assert.equal(idleStatus('pairing'), 'waiting');
  assert.equal(idleStatus('disconnected'), 'waiting');
});

test('backoff stays inside its bounds', () => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const low = backoffFor(attempt, policy, () => 0);
    const high = backoffFor(attempt, policy, () => 1);
    assert.equal(low, policy.minBackoffMs);
    assert.ok(high <= policy.maxBackoffMs);
  }
});

test('half-finished code pairings do not count as paired', () => {
  assert.equal(isPaired(null), false);
  assert.equal(isPaired({}), false);
  // What requestPairingCode leaves behind before anybody types the code.
  assert.equal(isPaired({ me: { id: '573001112233@s.whatsapp.net' } } as never), false);
  assert.equal(isPaired({ account: { details: new Uint8Array([1]) } }), true);
});
