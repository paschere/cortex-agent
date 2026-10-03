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
        '  WHATSAPP_ORGANIZATION_ID optional: pins the bridge to ONE workspace (single mode)',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }
  return value;
}

function optional(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/**
 * Who this process is, for the lease in Cortex (migration 0189). Stable for the
 * life of the process and different between two containers that overlap during
 * a deploy — which is exactly the moment two of them must not both hold the same
 * WhatsApp session. Railway's replica id when there is one; otherwise host, pid
 * and a random tail.
 */
function instanceId(): string {
  const explicit = optional('WHATSAPP_INSTANCE_ID') ?? optional('RAILWAY_REPLICA_ID');
  const host = process.env.HOSTNAME ?? 'bridge';
  const raw = explicit ?? `${host}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return raw.replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * `single`: WHATSAPP_ORGANIZATION_ID is set and this process serves that one
 * workspace, exactly as before multi-tenancy — one session, started at boot,
 * never stopped by Cortex. `multi`: Cortex says which workspaces need a socket
 * and this process reconciles towards that list (see `reconcile.ts`).
 */
export type BridgeMode = 'single' | 'multi';

export interface Config {
  cortexBaseUrl: string;
  bridgeToken: string;
  /** Set only in single mode. */
  organizationId: string | null;
  mode: BridgeMode;
  /** This process, for the per-workspace lease in Cortex. */
  instanceId: string;
  /**
   * Ceiling on WhatsApp sockets in this process. Each paired session holds a
   * socket, its signal key store and a few buffers in memory — a few MB — so
   * 50 fits comfortably in a small Railway container. Past it, workspaces wait
   * for a second process (the lease lets one take them) instead of this one
   * running out of memory with every number on it.
   */
  maxSessions: number;
  /** How often the list of workspaces is read back from Cortex. */
  reconcileMs: number;
  /** How long a claim on a workspace lasts without being renewed. */
  leaseMs: number;
  /** Pause between two session starts, so a boot does not load 50 key stores at once. */
  startStaggerMs: number;
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
  const organizationId = optional('WHATSAPP_ORGANIZATION_ID');
  const reconcileMs = number('WHATSAPP_RECONCILE_MS', 15_000);
  return {
    cortexBaseUrl: required('CORTEX_BASE_URL').replace(/\/+$/, ''),
    bridgeToken: required('WHATSAPP_BRIDGE_TOKEN'),
    organizationId,
    mode: organizationId ? 'single' : 'multi',
    instanceId: instanceId(),
    maxSessions: Math.floor(number('WHATSAPP_MAX_SESSIONS', 50)),
    reconcileMs,
    // At least three reconcile periods: one missed beat must not lose a lease.
    leaseMs: Math.max(number('WHATSAPP_LEASE_MS', 60_000), reconcileMs * 3),
    startStaggerMs: number('WHATSAPP_START_STAGGER_MS', 750),
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
