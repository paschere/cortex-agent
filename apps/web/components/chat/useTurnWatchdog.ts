'use client';

import { messagesSignature } from '@/lib/background-tasks/banner';
import {
  RECOVER_MS,
  activitySignature,
  endsWithoutAnswer,
  isStalled,
  toolIsRunning,
} from '@/lib/turn-watchdog';
import type { Message } from 'ai';
import { useCallback, useEffect, useRef, useState } from 'react';

const TICK_MS = 4000;

/**
 * Vigila que un turno no se quede mudo. Ver lib/turn-watchdog.ts.
 *
 *  - `stalled`: el stream lleva demasiado sin traer datos.
 *  - `onEmptyEnd`: el stream cerró y, tras releer la base, sigue sin respuesta.
 *  - recarga a medias: si el hilo termina en una pregunta sin respuesta, relee
 *    la base hasta que aparezca la respuesta (o se agote la espera).
 */
export function useTurnWatchdog(opts: {
  isLoading: boolean;
  messages: Message[];
  conversationId: string | undefined;
  setMessages: (messages: Message[]) => void;
  stop: () => void;
  /** El turno cerró sin respuesta aun después de releer. */
  onEmptyEnd: () => void;
}) {
  const { isLoading, conversationId } = opts;
  const messagesRef = useRef(opts.messages);
  messagesRef.current = opts.messages;
  // En refs para que cambiar de función entre renders no reinicie los temporizadores.
  const setMessagesRef = useRef(opts.setMessages);
  setMessagesRef.current = opts.setMessages;
  const stopRef = useRef(opts.stop);
  stopRef.current = opts.stop;
  const onEmptyEndRef = useRef(opts.onEmptyEnd);
  onEmptyEndRef.current = opts.onEmptyEnd;
  const [stalled, setStalled] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const stoppedByPerson = useRef(false);
  const wasLoading = useRef(false);

  /** Relee la conversación de la base; devuelve si ya termina con respuesta. */
  const reconcile = useCallback(async (): Promise<boolean> => {
    if (!conversationId) return false;
    try {
      const res = await fetch(`/api/conversations/${conversationId}/messages`, {
        cache: 'no-store',
      });
      if (!res.ok) return !endsWithoutAnswer(messagesRef.current);
      const body = (await res.json()) as { messages?: Message[] };
      const next = (body.messages ?? []).map((m) =>
        m.createdAt ? { ...m, createdAt: new Date(m.createdAt) } : m,
      );
      if (next.length === 0) return !endsWithoutAnswer(messagesRef.current);
      if (messagesSignature(next as never) !== messagesSignature(messagesRef.current as never))
        setMessagesRef.current(next);
      return !endsWithoutAnswer(next);
    } catch {
      return !endsWithoutAnswer(messagesRef.current);
    }
  }, [conversationId]);

  // 1. Sin datos mientras el turno está en vuelo.
  useEffect(() => {
    if (!isLoading) {
      setStalled(false);
      return;
    }
    let lastActivityAt = Date.now();
    let signature = activitySignature(messagesRef.current);
    const timer = setInterval(() => {
      const now = Date.now();
      const current = activitySignature(messagesRef.current);
      if (current !== signature) {
        signature = current;
        lastActivityAt = now;
        setStalled(false);
        return;
      }
      setStalled(
        isStalled({
          now,
          lastActivityAt,
          toolRunning: toolIsRunning(messagesRef.current[messagesRef.current.length - 1]),
        }),
      );
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [isLoading]);

  // 2. El stream cerró: si no hay respuesta, releer y, si sigue sin haberla, avisar.
  useEffect(() => {
    const ended = wasLoading.current && !isLoading;
    wasLoading.current = isLoading;
    if (isLoading) {
      stoppedByPerson.current = false;
      return;
    }
    if (!ended || stoppedByPerson.current) return;
    if (!endsWithoutAnswer(messagesRef.current)) return;
    let alive = true;
    void reconcile().then((answered) => {
      if (alive && !answered) onEmptyEndRef.current();
    });
    return () => {
      alive = false;
    };
  }, [isLoading, reconcile]);

  // 3. Recarga a medias: la conversación abre terminando en una pregunta.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    if (!conversationId || !endsWithoutAnswer(messagesRef.current)) return;
    let alive = true;
    const startedAt = Date.now();
    setRecovering(true);
    const tick = async () => {
      const answered = await reconcile();
      if (!alive) return;
      if (answered) {
        setRecovering(false);
        clearInterval(timer);
      } else if (Date.now() - startedAt > RECOVER_MS) {
        setRecovering(false);
        clearInterval(timer);
        onEmptyEndRef.current();
      }
    };
    const timer = setInterval(() => void tick(), TICK_MS);
    void tick();
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [conversationId, reconcile]);

  const stopTurn = useCallback(() => {
    stoppedByPerson.current = true;
    stopRef.current();
  }, []);

  return { stalled: stalled && isLoading, recovering, stopTurn };
}
