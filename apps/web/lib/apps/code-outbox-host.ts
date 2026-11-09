import { callSdk } from '@/lib/apps/code-sdk-call';
import { type CodeOp, CodeOutbox, type CodeOutboxState } from '@/lib/apps/code-outbox';
import {
  loadCodeOps,
  putCodeOp,
  putBlob,
  getBlob,
  removeBlob,
  removeCodeOp,
} from '@/lib/views/offline-store';

/**
 * El motor real de la cola sin señal de las pantallas con código: pone el almacén (IndexedDB,
 * por persona y app), el envío (la misma puerta `/sdk`) y la señal del navegador. Un buzón por
 * (app, persona); lo comparten todos los marcos de esa app.
 */

export interface HostedOutbox {
  box: CodeOutbox;
  /** La dirección del `/sdk` de una pantalla de la app (cualquiera con código sirve para enviar). */
  urlRef: { current: string };
  stateListeners: Set<(s: CodeOutboxState) => void>;
  sentListeners: Set<(table: string) => void>;
  stop(): void;
}

const registry = new Map<string, HostedOutbox>();

const store = {
  load: () => loadCodeOps(),
  put: (op: CodeOp) => putCodeOp(op),
  remove: (id: string) => removeCodeOp(id),
  putBlob: (id: string, blob: Blob) => putBlob(id, blob),
  getBlob: (id: string) => getBlob(id),
  removeBlob: (id: string) => removeBlob(id),
};

export function hostedOutbox(appKey: string, userKey: string, sdkUrl: string): HostedOutbox {
  const key = `${appKey}\u0000${userKey}`;
  const hit = registry.get(key);
  if (hit) {
    hit.urlRef.current = sdkUrl;
    return hit;
  }
  const urlRef = { current: sdkUrl };
  const stateListeners = new Set<(s: CodeOutboxState) => void>();
  const sentListeners = new Set<(table: string) => void>();
  const box = new CodeOutbox({
    appKey,
    userKey,
    store,
    isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
    send: (op, args, file) => callSdk(urlRef.current, op, args, file),
    onState: (s) => {
      for (const fn of [...stateListeners]) fn(s);
    },
    onSent: (table) => {
      for (const fn of [...sentListeners]) fn(table);
    },
  });
  const onOnline = () => void box.drain(true);
  const onOffline = () => box.notify();
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  const hosted: HostedOutbox = {
    box,
    urlRef,
    stateListeners,
    sentListeners,
    stop() {
      box.stop();
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      registry.delete(key);
    },
  };
  registry.set(key, hosted);
  void box.start();
  return hosted;
}
