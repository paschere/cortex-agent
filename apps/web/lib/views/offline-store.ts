/**
 * Almacén de la cola sin internet: IndexedDB con respaldo en memoria. Todo va
 * en try/catch — en una ventana privada o con los datos del sitio bloqueados
 * IndexedDB falla, y entonces la cola vive sólo mientras la pestaña siga abierta.
 * Los Blob de las fotos que no se pudieron subir van en su propio almacén.
 */

import type { QueuedOp } from '@/lib/apps/op-queue';
import type { QueuedSubmission } from './offline-queue';

const DB_NAME = 'cortex-views-offline';
const QUEUE = 'queue';
const BLOBS = 'blobs';
// v2 (captura de campo): las operaciones de una app (editar, pasar de estado, botones)
// y la última copia de cada pantalla para verla sin señal.
const OPS = 'ops';
const SCREENS = 'screens';

/** Una operación guardada: lleva de quién es, para no enviar nunca lo de otra persona. */
export type StoredOp = QueuedOp & { userKey: string };

/** La última copia de una pantalla de app (lo que se ve sin señal). */
export interface StoredScreen {
  /** `${appKey}|${userKey}|${screen}` */
  key: string;
  appKey: string;
  userKey: string;
  screen: string;
  title: string;
  savedAt: number;
  /** El cálculo de la vista tal como llegó (JSON). */
  computed: unknown;
}

const memoryQueue = new Map<string, QueuedSubmission>();
const memoryBlobs = new Map<string, Blob>();
const memoryOps = new Map<string, StoredOp>();
const memoryScreens = new Map<string, StoredScreen>();

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(QUEUE))
          db.createObjectStore(QUEUE, { keyPath: 'clientId' });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
        if (!db.objectStoreNames.contains(OPS)) db.createObjectStore(OPS, { keyPath: 'clientId' });
        if (!db.objectStoreNames.contains(SCREENS))
          db.createObjectStore(SCREENS, { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function run<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export async function loadQueue(): Promise<QueuedSubmission[]> {
  const db = await open();
  if (!db) return [...memoryQueue.values()];
  const all = await run<QueuedSubmission[]>(db, QUEUE, 'readonly', (s) => s.getAll());
  db.close();
  return all ?? [...memoryQueue.values()];
}

export async function putItem(item: QueuedSubmission): Promise<void> {
  memoryQueue.set(item.clientId, item);
  const db = await open();
  if (!db) return;
  await run(db, QUEUE, 'readwrite', (s) => s.put(item));
  db.close();
}

export async function removeItem(clientId: string): Promise<void> {
  memoryQueue.delete(clientId);
  const db = await open();
  if (!db) return;
  await run(db, QUEUE, 'readwrite', (s) => s.delete(clientId));
  db.close();
}

export async function putBlob(id: string, blob: Blob): Promise<void> {
  memoryBlobs.set(id, blob);
  const db = await open();
  if (!db) return;
  await run(db, BLOBS, 'readwrite', (s) => s.put(blob, id));
  db.close();
}

export async function getBlob(id: string): Promise<Blob | null> {
  const mem = memoryBlobs.get(id);
  if (mem) return mem;
  const db = await open();
  if (!db) return null;
  const blob = await run<Blob>(db, BLOBS, 'readonly', (s) => s.get(id));
  db.close();
  return blob ?? null;
}

export async function removeBlob(id: string): Promise<void> {
  memoryBlobs.delete(id);
  const db = await open();
  if (!db) return;
  await run(db, BLOBS, 'readwrite', (s) => s.delete(id));
  db.close();
}

// ---------------------------------------------------------------------------
// Operaciones de una app y copias de pantallas (captura de campo)
// ---------------------------------------------------------------------------

export async function loadOps(): Promise<StoredOp[]> {
  const db = await open();
  if (!db) return [...memoryOps.values()];
  const all = await run<StoredOp[]>(db, OPS, 'readonly', (s) => s.getAll());
  db.close();
  return all ?? [...memoryOps.values()];
}

export async function putOp(op: StoredOp): Promise<void> {
  memoryOps.set(op.clientId, op);
  const db = await open();
  if (!db) return;
  await run(db, OPS, 'readwrite', (s) => s.put(op));
  db.close();
}

export async function removeOp(clientId: string): Promise<void> {
  memoryOps.delete(clientId);
  const db = await open();
  if (!db) return;
  await run(db, OPS, 'readwrite', (s) => s.delete(clientId));
  db.close();
}

export async function loadScreens(): Promise<StoredScreen[]> {
  const db = await open();
  if (!db) return [...memoryScreens.values()];
  const all = await run<StoredScreen[]>(db, SCREENS, 'readonly', (s) => s.getAll());
  db.close();
  return all ?? [...memoryScreens.values()];
}

export async function putScreen(screen: StoredScreen): Promise<void> {
  memoryScreens.set(screen.key, screen);
  const db = await open();
  if (!db) return;
  await run(db, SCREENS, 'readwrite', (s) => s.put(screen));
  db.close();
}

export async function removeScreen(key: string): Promise<void> {
  memoryScreens.delete(key);
  const db = await open();
  if (!db) return;
  await run(db, SCREENS, 'readwrite', (s) => s.delete(key));
  db.close();
}

/**
 * Borra TODO lo guardado en este teléfono: cola de formularios, operaciones,
 * fotos pendientes y copias de pantallas. Es lo que se hace al cerrar sesión:
 * nada de una persona sobrevive para la siguiente.
 */
export async function clearEverything(): Promise<void> {
  memoryQueue.clear();
  memoryBlobs.clear();
  memoryOps.clear();
  memoryScreens.clear();
  const db = await open();
  if (!db) return;
  for (const store of [QUEUE, BLOBS, OPS, SCREENS])
    if (db.objectStoreNames.contains(store)) await run(db, store, 'readwrite', (s) => s.clear());
  db.close();
}
