/**
 * Everything this process needs to know, read once and validated loudly.
 *
 * A bridge that boots with a missing variable and only discovers it forty
 * minutes later, when the first group message fails to post, is the worst
 * possible failure mode for something whose whole job is to be running when
 * nobody is watching. So configuration is read at startup and a missing
 * required value stops the process with a sentence saying which one.
 */

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    // Not thrown as an Error object: this is the last thing anybody will read
    // in the Railway deploy log, and a stack trace above it helps nobody.
    console.error(
      [
        '',
        `[cortex-whatsapp] ${name} is not set, so this service cannot start.`,
        '  CORTEX_BASE_URL          the public https origin of Cortex',
        '  WHATSAPP_BRIDGE_TOKEN    the shared secret, same value as in Cortex',
        '  WHATSAPP_ORGANIZATION_ID the workspace this WhatsApp number belongs to',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface Config {
  cortexBaseUrl: string;
  bridgeToken: string;
  organizationId: string;
  port: number;
  /** Buffer flush: whichever comes first. */
  batchIntervalMs: number;
  batchSize: number;
  /** How often the connection reports in and refreshes its allow-list. */
  heartbeatMs: number;
  /**
   * The same, while NOT connected — idle and waiting for somebody to ask for a
   * pairing, or pairing. Shorter on purpose: the heartbeat reply is how a
   * "Mostrar código QR" press reaches this process, and a person standing there
   * with the phone should not wait half a minute for anything to happen.
   */
  pairingHeartbeatMs: number;
  /** How often Cortex is asked to fold finished conversations into documents. */
  ingestTickMs: number;
  /** Reconnect backoff bounds. */
  minBackoffMs: number;
  maxBackoffMs: number;
  /** Pause before opening the next QR window while a pairing request is alive. */
  pairingRetryMs: number;
  /** Ceiling for unexpected failures while pairing. */
  pairingMaxBackoffMs: number;
  /**
   * How this client identifies itself to WhatsApp. FIXED, and it matters that
   * it is fixed: WhatsApp keeps a list of linked devices, and a client whose
   * name changes between restarts looks like a series of different devices
   * logging into the same account — which is one of the patterns that gets a
   * number flagged. It also means the entry under "Dispositivos vinculados" on
   * the phone says something a person can recognise.
   */
  browser: [string, string, string];
  /** Cap on media pulled out of WhatsApp, in bytes. */
  maxVoiceBytes: number;
  maxDocumentBytes: number;
}

export function loadConfig(): Config {
  return {
    cortexBaseUrl: required('CORTEX_BASE_URL').replace(/\/+$/, ''),
    bridgeToken: required('WHATSAPP_BRIDGE_TOKEN'),
    organizationId: required('WHATSAPP_ORGANIZATION_ID'),
    port: number('PORT', 3200),
    batchIntervalMs: number('WHATSAPP_BATCH_INTERVAL_MS', 30_000),
    batchSize: number('WHATSAPP_BATCH_SIZE', 50),
    heartbeatMs: number('WHATSAPP_HEARTBEAT_MS', 30_000),
    // Capped at 15 s whatever the env says: above that a pairing request feels
    // ignored.
    pairingHeartbeatMs: Math.min(number('WHATSAPP_PAIRING_HEARTBEAT_MS', 10_000), 15_000),
    ingestTickMs: number('WHATSAPP_INGEST_TICK_MS', 5 * 60_000),
    minBackoffMs: number('WHATSAPP_MIN_BACKOFF_MS', 2_000),
    maxBackoffMs: number('WHATSAPP_MAX_BACKOFF_MS', 5 * 60_000),
    pairingRetryMs: number('WHATSAPP_PAIRING_RETRY_MS', 3_000),
    pairingMaxBackoffMs: number('WHATSAPP_PAIRING_MAX_BACKOFF_MS', 30_000),
    browser: ['Cortex', 'Chrome', '1.0.0'],
    maxVoiceBytes: number('WHATSAPP_MAX_VOICE_BYTES', 12 * 1024 * 1024),
    maxDocumentBytes: number('WHATSAPP_MAX_DOCUMENT_BYTES', 20 * 1024 * 1024),
  };
}
