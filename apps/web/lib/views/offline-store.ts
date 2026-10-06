/**
 * Almacén de la cola sin internet: IndexedDB con respaldo en memoria. Todo va
 * en try/catch — en una ventana privada o con los datos del sitio bloqueados
 * IndexedDB falla, y entonces la cola vive sólo mientras la pestaña siga abierta.
 * Los Blob de las fotos que no se pudieron subir van en su propio almacén.
 */

import type { QueuedSubmission } from './offline-queue';

const DB_NAME = 'cortex-views-offline';
const QUEUE = 'queue';
const BLOBS = 'blobs';

const memoryQueue = new Map<string, QueuedSubmission>();
const memoryBlobs = new Map<string, Blob>();

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(QUEUE))
          db.createObjectStore(QUEUE, { keyPath: 'clientId' });
        if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
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
