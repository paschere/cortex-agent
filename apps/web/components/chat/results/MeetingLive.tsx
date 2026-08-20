'use client';

import { Loader2, Mic, MicOff, Radio, Send, Sparkles, Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResultViewProps } from './registry';

/**
 * LA SALA DE UNA REUNIÓN EN VIVO, DENTRO DEL CHAT.
 *
 * ===========================================================================
 * QUÉ ES
 * ===========================================================================
 * Cuando Cortex entra a un Meet (meetings.join_live), esta tarjeta es la sala:
 * a la izquierda el transcript que va cayendo en tiempo real, con quién habla;
 * a la derecha un chat PROPIO donde la persona le pregunta a Cortex sobre la
 * llamada MIENTRAS PASA — «¿qué dijo Mateo del presupuesto?», «resúmeme lo que
 * va». Ese chat no es el chat normal: su única fuente es el transcript vivo, y
 * vive aquí, pegado a lo que está oyendo (api/meetings/live/[id]/ask).
 *
 * ===========================================================================
 * EL TRANSCRIPT: FINALES SE FIJAN, PARCIALES PARPADEAN
 * ===========================================================================
 * Deepgram manda resultados parciales (mientras alguien habla) y finales
 * (cuando cerró la frase). Los finales se acumulan como líneas; el parcial
 * vive en una sola línea al fondo que se reescribe hasta que se fija. Es la
 * misma sensación de un dictado bueno, y es lo que hace que se sienta VIVO y
 * no un log que aparece a tirones.
 */

interface Line {
  text: string;
  isFinal: boolean;
  speaker: string | null;
  at: number;
}
interface ChatMsg {
  role: 'you' | 'cortex';
  text: string;
}
type Status = 'joining' | 'waiting-admit' | 'live' | 'ended' | 'failed';

const STATUS_LABEL: Record<Status, string> = {
  joining: 'Entrando…',
  'waiting-admit': 'Esperando que me admitan…',
  live: 'En vivo',
  ended: 'Reunión terminada',
  failed: 'No pude entrar',
};

export function MeetingLive({ result }: ResultViewProps) {
  const r = result as { sessionId?: string; meetUrl?: string; ok?: boolean };
  if (!r?.ok || !r.sessionId) return null;
  return <Room sessionId={r.sessionId} meetUrl={r.meetUrl} />;
}

function Room({ sessionId, meetUrl }: { sessionId: string; meetUrl?: string }) {
  const [status, setStatus] = useState<Status>('joining');
  const [detail, setDetail] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState<Line | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [muted, setMuted] = useState(false);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);
  const chatEnd = useRef<HTMLDivElement | null>(null);

  // El stream SSE del transcript + estado.
  useEffect(() => {
    const es = new EventSource(`/api/meetings/live/${encodeURIComponent(sessionId)}/stream`);
    es.addEventListener('status', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as { status: Status; detail: string | null };
      setStatus(d.status);
      setDetail(d.detail);
    });
    es.addEventListener('transcript', (e) => {
      const t = JSON.parse((e as MessageEvent).data) as Line;
      if (t.isFinal) {
        setLines((prev) => [...prev, t]);
        setPartial(null);
      } else {
        setPartial(t);
      }
    });
    es.onerror = () => {
      // El stream se corta cuando la reunión muere; el estado ya lo dijo.
    };
    return () => es.close();
  }, [sessionId]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lines, partial]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chat, asking]);

  const ask = useCallback(async () => {
    const q = question.trim();
    if (!q || asking) return;
    setQuestion('');
    setChat((prev) => [...prev, { role: 'you', text: q }]);
    setAsking(true);
    try {
      const res = await fetch(`/api/meetings/live/${encodeURIComponent(sessionId)}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = (await res.json().catch(() => ({}))) as { answer?: string; error?: string };
      setChat((prev) => [
        ...prev,
        { role: 'cortex', text: data.answer ?? data.error ?? 'No pude responder.' },
      ]);
    } finally {
      setAsking(false);
    }
  }, [question, asking, sessionId]);

  const leave = useCallback(() => {
    void fetch(`/api/meetings/live/${encodeURIComponent(sessionId)}/leave`, { method: 'POST' });
  }, [sessionId]);

  const toggleMute = useCallback(() => {
    const next = !muted;
    setMuted(next);
    void fetch(`/api/meetings/live/${encodeURIComponent(sessionId)}/voice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ muted: next }),
    });
  }, [muted, sessionId]);

  const dead = status === 'ended' || status === 'failed';
  const host = (() => {
    try {
      return meetUrl ? new URL(meetUrl).pathname.replace('/', '') : '';
    } catch {
      return '';
    }
  })();

  return (
    <div className="mt-2 w-full max-w-3xl overflow-hidden rounded-card border border-border bg-surface shadow-card">
      {/* Barra de estado */}
      <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5 text-sm">
        <Radio className={`h-4 w-4 ${status === 'live' ? 'text-emerald' : 'text-ink-faint'}`} />
        <span className="font-semibold text-ink">Reunión</span>
        {host ? <span className="text-xs text-ink-faint">· {host}</span> : null}
        <span
          className={`ml-2 inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-xs font-medium ${
            status === 'live'
              ? 'bg-emerald-soft text-emerald'
              : status === 'failed'
                ? 'bg-rose-soft text-rose'
                : 'bg-surface-2 text-ink-muted'
          }`}
        >
          {status === 'live' ? (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald" />
          ) : status !== 'ended' && status !== 'failed' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : null}
          {STATUS_LABEL[status]}
        </span>
        {!dead ? (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={toggleMute}
              title={muted ? 'Cortex está en silencio — activar voz' : 'Cortex puede hablar si lo nombran — silenciar'}
              className={`inline-flex items-center gap-1 rounded-pill px-2 py-1 text-xs font-medium ${
                muted ? 'text-ink-faint hover:bg-surface-2' : 'bg-primary-soft text-primary'
              }`}
            >
              {muted ? <MicOff className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
              {muted ? 'Voz en silencio' : 'Voz activa'}
            </button>
            <button
              type="button"
              onClick={leave}
              className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" /> Salir
            </button>
          </div>
        ) : null}
      </div>

      {detail && (status === 'failed' || status === 'waiting-admit') ? (
        <div className="border-b border-border bg-surface-2 px-3.5 py-2 text-xs text-ink-muted">
          {detail}
        </div>
      ) : null}

      <div className="grid gap-0 md:grid-cols-[1.15fr_1fr]">
        {/* Transcript en vivo */}
        <div className="flex max-h-96 min-h-64 flex-col overflow-y-auto border-b border-border p-3.5 md:border-b-0 md:border-r">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            <Mic className="h-3.5 w-3.5" /> Lo que se dice
          </div>
          {lines.length === 0 && !partial ? (
            <p className="mt-2 text-sm text-ink-faint">
              {status === 'live'
                ? 'Escuchando… habla alguien en la reunión.'
                : 'Aún no hay nada transcrito.'}
            </p>
          ) : null}
          <div className="flex flex-col gap-1.5">
            {lines.map((l, i) => (
              <p key={`${l.at}-${i}`} className="text-sm leading-snug text-ink">
                {l.speaker ? (
                  <span className="font-semibold text-ink-muted">{l.speaker}: </span>
                ) : null}
                {l.text}
              </p>
            ))}
            {partial ? (
              <p className="text-sm leading-snug text-ink-faint">
                {partial.speaker ? (
                  <span className="font-semibold">{partial.speaker}: </span>
                ) : null}
                {partial.text}
              </p>
            ) : null}
          </div>
          <div ref={transcriptEnd} />
        </div>

        {/* Chat de la reunión */}
        <div className="flex max-h-96 min-h-64 flex-col">
          <div className="flex items-center gap-1.5 px-3.5 pb-1.5 pt-3.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            <Sparkles className="h-3.5 w-3.5 text-primary" /> Pregúntame sobre la llamada
          </div>
          <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-3.5 py-2">
            {chat.length === 0 ? (
              <p className="text-sm text-ink-faint">
                Mientras la reunión pasa, pregúntame lo que quieras: «resúmeme lo que va», «¿quedó
                algún compromiso?», «¿qué dijo del precio?».
              </p>
            ) : null}
            {chat.map((m, i) => (
              <div
                key={i}
                className={`max-w-[85%] rounded-card px-3 py-2 text-sm ${
                  m.role === 'you'
                    ? 'self-end bg-primary text-primary-ink'
                    : 'self-start bg-surface-2 text-ink'
                }`}
              >
                {m.text}
              </div>
            ))}
            {asking ? (
              <div className="self-start rounded-card bg-surface-2 px-3 py-2 text-sm text-ink-muted">
                <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> pensando…
              </div>
            ) : null}
            <div ref={chatEnd} />
          </div>
          <div className="flex items-center gap-2 border-t border-border p-2.5">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void ask();
              }}
              placeholder="Pregunta sobre la reunión…"
              className="h-9 flex-1 rounded-pill border border-border bg-surface px-3.5 text-sm outline-none focus:border-primary"
            />
            <button
              type="button"
              disabled={asking || !question.trim()}
              onClick={() => void ask()}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-primary-ink disabled:opacity-50"
              aria-label="Preguntar"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
