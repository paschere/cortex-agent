'use client';

import { OfflineUploadError } from '@/components/views/inputs/FileInput';
import { hasPending, resolvePending } from '@/lib/views/offline-files';
import {
  type QueuedSubmission,
  RETRY_EVERY_MS,
  type SendOutcome,
  type SentRecord,
  drainQueue,
  enqueue,
  newClientId,
  pendingOf,
  pushSent,
  queueItem,
} from '@/lib/views/offline-queue';
import { loadQueue, putItem, removeItem } from '@/lib/views/offline-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubmitTarget } from '../ViewCanvas';
import type { SubmitFn } from './form-transport';

/**
 * La cola sin internet de UN formulario (ver lib/views/offline-queue.ts para la
 * lógica). Aquí está lo que toca el navegador: IndexedDB, el evento `online`,
 * el reloj de 30 s y el reintento al abrir la vista. También lleva la lista
 * «Mis últimos envíos» (localStorage, por vista y bloque).
 */

/** Un id estable por vista + bloque. Null en vista previa (no hay cola). */
export function queueKeyFor(target: SubmitTarget, blockId: string): string | null {
  if (target.kind === 'app') return `app:${target.viewId}:${blockId}`;
  if (target.kind === 'custom_app') return `capp:${target.appId}:${target.screen}:${blockId}`;
  if (target.kind === 'public') return `pub:${target.token.slice(0, 20)}:${blockId}`;
  return null;
}

const SENT_PREFIX = 'cortex-view-sent:';

function readSent(key: string): SentRecord[] {
  try {
    const raw = localStorage.getItem(SENT_PREFIX + key);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? (list as SentRecord[]) : [];
  } catch {
    return [];
  }
}

function writeSent(key: string, list: SentRecord[]) {
  try {
    localStorage.setItem(SENT_PREFIX + key, JSON.stringify(list));
  } catch {}
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    setOnline(navigator.onLine !== false);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function useFormQueue({
  queueKey,
  blockId,
  submit,
  uploader,
  summarize,
  editWindow,
}: {
  queueKey: string | null;
  blockId: string;
  submit: SubmitFn | undefined;
  uploader: (file: File, field: string) => Promise<import('@/lib/views/upload-rules').UploadedFile>;
  /** Una frase corta para reconocer un envío en «Mis últimos envíos». */
  summarize: (values: Record<string, string>) => string;
  /** Minutos para corregir lo enviado (0 = no se corrige). */
  editWindow: number;
}) {
  const [items, setItems] = useState<QueuedSubmission[]>([]);
  const [sent, setSent] = useState<SentRecord[]>([]);
  const busy = useRef(false);
  // Siempre la versión más nueva, para que el reloj no use una vieja.
  const live = useRef({ submit, uploader, summarize, editWindow, queueKey });
  live.current = { submit, uploader, summarize, editWindow, queueKey };

  const refresh = useCallback(async () => {
    const key = live.current.queueKey;
    if (!key) return [] as QueuedSubmission[];
    const all = (await loadQueue()).filter((q) => q.key === key);
    setItems(all);
    return all;
  }, []);

  /** Un envío que sí llegó: va a «Mis últimos envíos» con su token de edición. */
  const recordSent = useCallback(
    (
      key: string,
      values: Record<string, string>,
      res: { rowId?: string; editToken?: string | null },
    ) => {
      if (!res.rowId) return;
      const { summarize: sum, editWindow: minutes } = live.current;
      const now = Date.now();
      const rec: SentRecord = {
        rowId: res.rowId,
        at: now,
        summary: sum(values),
        values,
        editToken: res.editToken ?? null,
        editUntil: minutes > 0 ? now + minutes * 60_000 : null,
      };
      setSent((cur) => {
        const next = pushSent(cur, rec);
        writeSent(key, next);
        return next;
      });
      return rec;
    },
    [],
  );

  const drain = useCallback(
    async (force: boolean) => {
      const { queueKey: key, submit: send } = live.current;
      if (!key || !send || busy.current) return;
      busy.current = true;
      try {
        const all = await refresh();
        if (!pendingOf(all, key).length) return;
        const result = await drainQueue(
          all,
          async (item): Promise<SendOutcome> => {
            let values = item.values;
            if (hasPending(values)) {
              try {
                values = await resolvePending(values, live.current.uploader);
                await putItem({ ...item, values });
              } catch (e) {
                return e instanceof OfflineUploadError || !(e instanceof Error)
                  ? { kind: 'retry' }
                  : { kind: 'rejected', error: e.message };
              }
            }
            const res = await send(item.blockId, values, item.clientId);
            if (res.ok) {
              if (res.rowId) recordSent(key, values, res);
              return { kind: 'ok' };
            }
            return res.offline ? { kind: 'retry' } : { kind: 'rejected', error: res.error };
          },
          { now: Date.now(), force, key },
        );
        // Lo que cambió (intentos, rechazos) y lo que salió.
        for (const q of result.queue) if (q.key === key) await putItem(q);
        for (const id of result.sent) await removeItem(id);
        setItems(result.queue.filter((q) => q.key === key));
      } finally {
        busy.current = false;
      }
    },
    [refresh, recordSent],
  );

  // Al abrir la vista y al volver la señal; y cada 30 s mientras haya algo.
  useEffect(() => {
    if (!queueKey) return;
    void drain(true);
    const on = () => void drain(true);
    window.addEventListener('online', on);
    const timer = window.setInterval(() => void drain(false), RETRY_EVERY_MS);
    return () => {
      window.removeEventListener('online', on);
      window.clearInterval(timer);
    };
  }, [queueKey, drain]);

  useEffect(() => {
    if (queueKey) setSent(readSent(queueKey));
  }, [queueKey]);

  /** Guarda un registro en el teléfono. Devuelve su id de cliente. */
  const add = useCallback(
    async (values: Record<string, string>, clientId = newClientId()) => {
      const key = live.current.queueKey;
      if (!key) return clientId;
      const item = queueItem({ clientId, key, blockId, values, now: Date.now() });
      await putItem(item);
      setItems((cur) => enqueue(cur, item));
      return clientId;
    },
    [blockId],
  );

  const discard = useCallback(async (clientId: string) => {
    await removeItem(clientId);
    setItems((cur) => cur.filter((q) => q.clientId !== clientId));
  }, []);

  /** Corregir un envío: se guardan los valores nuevos conservando token y plazo. */
  const update = useCallback((rowId: string, values: Record<string, string>) => {
    const key = live.current.queueKey;
    if (!key) return;
    setSent((cur) => {
      const next = cur.map((r) =>
        r.rowId === rowId ? { ...r, values, summary: live.current.summarize(values) } : r,
      );
      writeSent(key, next);
      return next;
    });
  }, []);

  return {
    items,
    pending: pendingOf(items, queueKey ?? undefined),
    rejected: items.filter((q) => q.rejected),
    sent,
    add,
    drain,
    discard,
    recordSent: (
      values: Record<string, string>,
      res: { rowId?: string; editToken?: string | null },
    ) => {
      const key = live.current.queueKey;
      return key ? recordSent(key, values, res) : undefined;
    },
    update,
  };
}
