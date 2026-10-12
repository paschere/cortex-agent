'use client';

import {
  type TaskBanner,
  messagesSignature,
  taskIsLive,
  taskIsRunning,
  toBanner,
} from '@/lib/background-tasks/banner';
import { useQueryClient } from '@tanstack/react-query';
import type { Message } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * LA TAREA EN SEGUNDO PLANO DE ESTA CONVERSACIÓN, VISTA DESDE EL CHAT.
 *
 * La tarea corre en el servidor y escribe su avance en la fila del asistente de
 * la conversación (paso a paso). Este hook lo trae: mientras la tarea sigue
 * viva consulta su estado y, si está trabajando, vuelve a leer el hilo y lo
 * reemplaza sólo cuando algo cambió. Así se ve avanzar a Cortex —y se abre
 * «la computadora de Cortex» del panel— desde cualquier aparato, sin que haya
 * una conexión abierta con el servidor. No hace nada si no hay tarea viva.
 */

const POLL_MS = 4000;

export interface BackgroundTaskApi {
  task: TaskBanner | null;
  /** Hay una tarea que no ha terminado (en cola, trabajando o esperándote). */
  live: boolean;
  /** Cortex está haciendo algo ahora (el compositor se bloquea). */
  running: boolean;
  starting: boolean;
  error: string | null;
  start: (prompt: string, mode: 'new' | 'continue') => Promise<void>;
  cancel: () => Promise<void>;
  dismiss: () => void;
  /** Vuelve a leer ya (p. ej. tras aprobar una acción parada). */
  refresh: () => Promise<void>;
}

export function useBackgroundTask(opts: {
  conversationId: string | undefined;
  initialTask?: TaskBanner | null;
  /** Hay un turno del chat en vuelo: no se pisa el hilo que el chat está escribiendo. */
  chatBusy: boolean;
  messages: Message[];
  setMessages: (updater: (previous: Message[]) => Message[]) => void;
  onConversation: (id: string) => void;
}): BackgroundTaskApi {
  const { conversationId, chatBusy, setMessages, onConversation } = opts;
  const [task, setTask] = useState<TaskBanner | null>(opts.initialTask ?? null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const messagesRef = useRef(opts.messages);
  messagesRef.current = opts.messages;
  const lastStatus = useRef(task?.status);

  const refreshMessages = useCallback(
    async (cid: string) => {
      try {
        const res = await fetch(`/api/conversations/${cid}/messages`, { cache: 'no-store' });
        if (!res.ok) return;
        const body = (await res.json()) as { messages?: Message[] };
        const next = (body.messages ?? []).map((m) =>
          m.createdAt ? { ...m, createdAt: new Date(m.createdAt) } : m,
        );
        if (messagesSignature(next as never) === messagesSignature(messagesRef.current as never))
          return;
        setMessages(() => next);
      } catch {
        // Una consulta perdida se repone en la siguiente.
      }
    },
    [setMessages],
  );

  const live = taskIsLive(task);
  const taskId = task?.id;
  const taskConversation = task?.conversationId ?? conversationId;

  const refresh = useCallback(async () => {
    if (!taskId) return;
    try {
      const res = await fetch(`/api/tasks/${taskId}`, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { task?: Record<string, unknown> };
      if (body.task) setTask(toBanner(body.task));
    } catch {
      // idem
    }
  }, [taskId]);

  useEffect(() => {
    if (!taskId || !live) return;
    let alive = true;
    const tick = async () => {
      try {
        const res = await fetch(`/api/tasks/${taskId}`, { cache: 'no-store' });
        if (!res.ok || !alive) return;
        const body = (await res.json()) as { task?: Record<string, unknown> };
        if (!body.task || !alive) return;
        const next = toBanner(body.task);
        setTask(next);
        if (taskConversation && !chatBusy) await refreshMessages(taskConversation);
        if (lastStatus.current !== next.status) {
          lastStatus.current = next.status;
          if (!taskIsLive(next))
            void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        }
      } catch {
        // idem
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [taskId, live, taskConversation, chatBusy, refreshMessages, queryClient]);

  const start = useCallback(
    async (prompt: string, mode: 'new' | 'continue') => {
      setStarting(true);
      setError(null);
      try {
        const res = await fetch('/api/tasks', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, mode, ...(conversationId ? { conversationId } : {}) }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          task?: Record<string, unknown>;
          conversationId?: string;
          error?: string;
        };
        if (!res.ok || !body.task) {
          setError(typeof body.error === 'string' ? body.error : 'No se pudo iniciar la tarea.');
          return;
        }
        const banner = toBanner(body.task);
        lastStatus.current = banner.status;
        setTask(banner);
        const cid = body.conversationId ?? banner.conversationId ?? undefined;
        if (cid && cid !== conversationId) {
          onConversation(cid);
          window.history.replaceState(null, '', `/chat/${cid}${window.location.search}`);
        }
        if (cid) await refreshMessages(cid);
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      } finally {
        setStarting(false);
      }
    },
    [conversationId, onConversation, refreshMessages, queryClient],
  );

  const cancel = useCallback(async () => {
    if (!taskId) return;
    const res = await fetch(`/api/tasks/${taskId}/cancel`, { method: 'POST' });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'No se pudo cancelar.');
      return;
    }
    setTask((t) => (t ? { ...t, status: t.status === 'working' ? t.status : 'cancelled' } : t));
  }, [taskId]);

  const dismiss = useCallback(() => setTask((t) => (t && !taskIsLive(t) ? null : t)), []);

  return {
    task,
    live,
    running: taskIsRunning(task),
    starting,
    error,
    start,
    cancel,
    dismiss,
    refresh,
  };
}
