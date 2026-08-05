import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  type SignalDataTypeMap,
  initAuthCreds,
  proto,
} from '@whiskeysockets/baileys';
import type { CortexClient } from './cortex';
import { logger } from './logger';

/**
 * Baileys' session, kept in Postgres instead of on the container's disk.
 *
 * ── THE PROBLEM, BECAUSE IT IS THE ONE THAT KILLS THESE PROJECTS ─────────────
 *
 * Baileys ships `useMultiFileAuthState`, which writes a directory of JSON
 * files. Railway's filesystem is ephemeral: a deploy, a crash or a restart and
 * the directory is gone with it. With a disk-backed session that means somebody
 * walks to the dedicated phone and scans a QR code every single time the
 * service ships. It is the single most common reason a self-hosted WhatsApp
 * bridge is abandoned after three weeks, and it is a solved problem, so it is
 * solved here rather than written up as a known issue.
 *
 * A Railway volume would also survive a deploy, and is the wrong answer: it
 * pins the service to one instance in one region, it is invisible to anything
 * that can read the database, it is a second thing to back up, and it does
 * nothing for a rebuild from scratch. The session is a credential. Credentials
 * live where the rest of them live.
 *
 * ── THE SERIALISATION TRAP ──────────────────────────────────────────────────
 *
 * The session is full of `Buffer`s — key pairs, identity keys, signed pre-keys
 * — and `JSON.stringify` turns a Buffer into `{"type":"Buffer","data":[…]}`,
 * which parses back as a plain object. Baileys then calls a curve function on
 * something that is not a Buffer and the failure surfaces as a decryption error
 * on the first message, hours later, with nothing pointing at the cause.
 * `BufferJSON.replacer` / `.reviver` are Baileys' own answer to exactly this,
 * so every value in and out of storage goes through them, with no exceptions.
 *
 * `app-state-sync-key` needs one more step: Baileys expects protobuf instances
 * rather than plain objects, so those are rehydrated with `fromObject` on the
 * way out — the same thing `useMultiFileAuthState` does, for the same reason.
 *
 * ── WHY IT IS CACHED IN MEMORY ──────────────────────────────────────────────
 *
 * `SignalKeyStore.get` is on the hot path: Baileys calls it inline while
 * decrypting each message, several times, for several keys. An HTTP round trip
 * per call would make every message cost hundreds of milliseconds and would
 * turn a Cortex hiccup into a decryption failure. So the whole store is read
 * once at boot and held in memory; writes go to memory immediately and to
 * Cortex on a short debounce. If the process dies between a write and its
 * flush, the worst case is Baileys re-requesting a pre-key — a normal,
 * self-healing condition — rather than a lost session.
 */

/** How long writes are gathered before one request carries them all. */
const FLUSH_DEBOUNCE_MS = 400;

type KeyStore = Record<string, Record<string, unknown>>;

export interface RemoteAuthState {
  state: AuthenticationState;
  /** Persist `creds` after Baileys signals `creds.update`. */
  saveCreds: () => Promise<void>;
  /** Push anything still buffered. Called on shutdown. */
  flush: () => Promise<void>;
  /** True when this boot started from a stored session rather than from zero. */
  restored: boolean;
}

function encode(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function decode<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver) as T;
}

export async function usePostgresAuthState(cortex: CortexClient): Promise<RemoteAuthState> {
  const remote = await cortex.loadState();
  if (!remote) {
    // Starting from zero here would silently discard a perfectly good session
    // because Cortex was briefly unreachable — and the next thing the operator
    // sees is a QR code for a number that was already paired.
    throw new Error(
      'Could not read the stored WhatsApp session from Cortex. Refusing to start with an empty one, because that would discard a working pairing. Check CORTEX_BASE_URL and WHATSAPP_BRIDGE_TOKEN.',
    );
  }

  const creds: AuthenticationCreds = remote.creds
    ? decode<AuthenticationCreds>(remote.creds)
    : initAuthCreds();
  const restored = Boolean(remote.creds);

  const cache: KeyStore = {};
  for (const [type, entries] of Object.entries(remote.keys ?? {})) {
    cache[type] = {};
    for (const [id, value] of Object.entries(entries)) {
      (cache[type] as Record<string, unknown>)[id] = value;
    }
  }

  logger.info(
    {
      restored,
      keyTypes: Object.keys(cache).length,
      keys: Object.values(cache).reduce((n, entries) => n + Object.keys(entries).length, 0),
    },
    restored
      ? 'restored the WhatsApp session from Cortex — no re-pairing needed'
      : 'no stored session; this boot will need a QR scan',
  );

  // What has changed since the last push. `null` means "delete this key", which
  // is Baileys' own convention and is passed straight through.
  let pending: Record<string, Record<string, unknown | null>> = {};
  let credsDirty = false;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  async function push(): Promise<void> {
    const set = pending;
    const sendCreds = credsDirty;
    pending = {};
    credsDirty = false;
    if (!sendCreds && Object.keys(set).length === 0) return;

    await cortex.saveState({
      ...(sendCreds ? { creds: encode(creds) } : {}),
      ...(Object.keys(set).length > 0 ? { set } : {}),
    });
  }

  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      // Serialised: two overlapping writes could otherwise land out of order
      // and leave the stored store one revision behind memory.
      inFlight = inFlight.then(push).catch((err: unknown) => {
        logger.error({ err: (err as Error).message }, 'could not persist session state');
      });
    }, FLUSH_DEBOUNCE_MS);
  }

  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[],
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> {
        const bucket = cache[type as string] ?? {};
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        for (const id of ids) {
          const raw = bucket[id];
          if (raw === undefined) continue;
          let value = decode<SignalDataTypeMap[T]>(raw);
          if (type === 'app-state-sync-key' && value) {
            // Baileys wants the protobuf instance, not the shape of one.
            value = proto.Message.AppStateSyncKeyData.fromObject(
              value as object,
              // `SignalDataTypeMap` is an intersection across every key type,
              // so no single concrete value satisfies it; `useMultiFileAuthState`
              // does the identical cast for the identical reason.
            ) as unknown as SignalDataTypeMap[T];
          }
          out[id] = value;
        }
        return out;
      },

      async set(data): Promise<void> {
        for (const [type, entries] of Object.entries(data)) {
          cache[type] ??= {};
          pending[type] ??= {};
          for (const [id, value] of Object.entries(entries ?? {})) {
            if (value === null || value === undefined) {
              delete (cache[type] as Record<string, unknown>)[id];
              (pending[type] as Record<string, unknown | null>)[id] = null;
            } else {
              const encoded = encode(value);
              (cache[type] as Record<string, unknown>)[id] = encoded;
              (pending[type] as Record<string, unknown | null>)[id] = encoded;
            }
          }
        }
        schedule();
      },
    },
  };

  return {
    state,
    restored,
    async saveCreds(): Promise<void> {
      credsDirty = true;
      schedule();
    },
    async flush(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await inFlight;
      await push();
    },
  };
}
