'use client';

import { CallTimeline, type VisibleEvent } from '@/components/meetings/CallTimeline';
import { ParticipantStrip } from '@/components/meetings/ParticipantStrip';
import { type MeetingParticipant, speakerTone } from '@/components/meetings/speakers';
import { Loader2, Mic, MicOff, Radio, Send, Sparkles, Users, Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * LA SALA DE UNA REUNIÓN EN VIVO — la pantalla de «Llamadas».
 *
 * ===========================================================================
 * QUÉ ES
 * ===========================================================================
 * Cuando Cortex entra a un Meet (meetings.join_live), esta es la sala: a la
 * izquierda el transcript que va cayendo en tiempo real, con quién habla y a
 * qué hora; a la derecha un chat PROPIO donde la persona le pregunta a Cortex
 * sobre la llamada MIENTRAS PASA — «¿qué dijo Mateo del presupuesto?»,
 * «resúmeme lo que va». Ese chat no es el chat normal: su única fuente es el
 * transcript vivo (api/meetings/live/[id]/ask).
 *
 * Antes vivía como tarjeta dentro del río del chat. Se mudó a su propia
 * pestaña porque una reunión dura una hora y el chat sigue andando: la sala
 * se perdía scroll arriba. Ahora el chat solo deja una tarjeta corta que
 * apunta aquí (components/chat/results/MeetingLive.tsx).
 *
 * ===========================================================================
 * EL TRANSCRIPT: FINALES SE FIJAN, PARCIALES PARPADEAN
 * ===========================================================================
 * Deepgram manda resultados parciales (mientras alguien habla) y finales
 * (cuando cerró la frase). Los finales se acumulan como líneas; el parcial
 * vive en una sola línea al fondo que se reescribe hasta que se fija.
 *
 * Dos fuentes a propósito: el SSE pinta parciales al instante; el poll corto
 * es la fuente de verdad de las finales, porque el SSE proxied por Vercel se
 * bufferiza y llega tarde.
 */

export interface Line {
  text: string;
  isFinal: boolean;
  speaker: string | null;
  at: number;
}
interface ChatMsg {
  role: 'you' | 'cortex';
  text: string;
}
export type LiveStatus = 'joining' | 'waiting-admit' | 'live' | 'ended' | 'failed';

export const STATUS_LABEL: Record<LiveStatus, string> = {
  joining: 'Entrando…',
  'waiting-admit': 'Esperando que me admitan…',
  live: 'En vivo',
  ended: 'Reunión terminada',
  failed: 'No pude entrar',
};

export function StatusPill({ status, className = '' }: { status: LiveStatus; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-xs font-medium ${
        status === 'live'
          ? 'bg-emerald-soft text-emerald'
          : status === 'failed'
            ? 'bg-rose-soft text-rose'
            : 'bg-surface-2 text-ink-muted'
      } ${className}`}
    >
      {status === 'live' ? (
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald" />
      ) : status !== 'ended' && status !== 'failed' ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : null}
      {STATUS_LABEL[status]}
    </span>
  );
}

export function meetCode(meetUrl?: string | null): string {
  try {
    return meetUrl ? new URL(meetUrl).pathname.replace('/', '') : '';
  } catch {
    return '';
  }
}

function clock(at: number): string {
  const sec = at > 1e12 ? Math.floor(at / 1000) : Math.max(0, Math.floor(at));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function LiveRoom({
  sessionId,
  meetUrl,
  voiceEnabled,
  onGone,
  snapshot,
}: {
  sessionId: string;
  meetUrl?: string | null;
  /** Si el plan incluye voz: muestra el control «Voz activa/silencio». */
  voiceEnabled: boolean;
  /** La sesión ya no existe en el bot (terminó hace rato) y no hay archivo. */
  onGone?: () => void;
  /** Una llamada ya guardada: se pinta sin pulso ni SSE. */
  snapshot?: {
    lines: Line[];
    people: MeetingParticipant[];
    timeline?: VisibleEvent[];
    recordingUrl?: string | null;
  };
}) {
  const [status, setStatus] = useState<LiveStatus>(snapshot ? 'ended' : 'joining');
  const [detail, setDetail] = useState<string | null>(null);
  const [lines, setLines] = useState<Line[]>(snapshot?.lines ?? []);
  const [partial, setPartial] = useState<Line | null>(null);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [people, setPeople] = useState<MeetingParticipant[]>(snapshot?.people ?? []);
  const transcriptEnd = useRef<HTMLDivElement | null>(null);
  const chatEnd = useRef<HTMLDivElement | null>(null);
  const lineRefs = useRef<Map<number, HTMLParagraphElement>>(new Map());
  const [timeline, setTimeline] = useState<VisibleEvent[]>(snapshot?.timeline ?? []);
  const frozen = Boolean(snapshot);

  const seek = useCallback((at: number) => {
    const keys = [...lineRefs.current.keys()].sort((a, b) => a - b);
    const hit = keys.reduce((best, k) => (k <= at ? k : best), keys[0] ?? 0);
    lineRefs.current.get(hit)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  useEffect(() => {
    if (snapshot?.timeline) setTimeline(snapshot.timeline);
  }, [snapshot?.timeline]);

  useEffect(() => {
    if (frozen) return;
    let stop = false;
    let misses = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const pull = async () => {
      try {
        const res = await fetch(`/api/meetings/live/${encodeURIComponent(sessionId)}`, {
          cache: 'no-store',
        });
        if (stop) return;
        if (res.status === 410) {
          const archived = await fetch(`/api/meetings/archive/${encodeURIComponent(sessionId)}`, {
            cache: 'no-store',
          });
          if (stop) return;
          if (archived.ok) {
            const data = (await archived.json()) as {
              transcript?: Line[];
              participants?: MeetingParticipant[];
              timeline?: VisibleEvent[];
            };
            setStatus('ended');
            setLines((data.transcript ?? []).filter((t) => t.isFinal !== false));
            if (Array.isArray(data.participants)) setPeople(data.participants);
            if (Array.isArray(data.timeline)) setTimeline(data.timeline);
            setPartial(null);
            if (timer) clearInterval(timer);
            return;
          }
          misses += 1;
          if (misses >= 20) onGone?.();
          return;
        }
        if (!res.ok) return;
        misses = 0;
        const data = (await res.json()) as {
          status?: LiveStatus;
          detail?: string | null;
          transcript?: Line[];
          participants?: MeetingParticipant[];
          timeline?: VisibleEvent[];
        };
        if (data.status) setStatus(data.status);
        if (data.detail !== undefined) setDetail(data.detail ?? null);
        setLines((data.transcript ?? []).filter((t) => t.isFinal !== false));
        if (Array.isArray(data.participants)) setPeople(data.participants);
        if (Array.isArray(data.timeline)) setTimeline(data.timeline);
      } catch {
        // Un poll fallido no tumba la sala; el siguiente lo reintenta.
      }
    };
    void pull();
    timer = setInterval(pull, 400);
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId, onGone, frozen]);

  useEffect(() => {
    if (frozen) return;
    const es = new EventSource(`/api/meetings/live/${encodeURIComponent(sessionId)}/stream`);
    es.addEventListener('status', (e) => {
      const d = JSON.parse((e as MessageEvent).data) as {
        status: LiveStatus;
        detail: string | null;
      };
      setStatus(d.status);
      setDetail(d.detail);
    });
    es.addEventListener('roster', (e) => {
      setPeople(JSON.parse((e as MessageEvent).data) as MeetingParticipant[]);
    });
    es.addEventListener('visual', (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as VisibleEvent;
      setTimeline((prev) =>
        prev.some((p) => p.at === ev.at && p.kind === ev.kind && p.label === ev.label)
          ? prev
          : [...prev, ev],
      );
    });
    es.addEventListener('transcript', (e) => {
      const t = JSON.parse((e as MessageEvent).data) as Line;
      if (t.isFinal) {
        setLines((prev) =>
          prev.some((p) => p.at === t.at && p.text === t.text) ? prev : [...prev, t],
        );
        setPartial(null);
      } else {
        setPartial(t);
      }
    });
    es.onerror = () => {
      // El stream se corta cuando la reunión muere; el estado ya lo dijo.
    };
    return () => es.close();
  }, [sessionId, frozen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: lines/partial son el disparador del autoscroll.
  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [lines, partial]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: chat/asking son el disparador del autoscroll.
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
  const code = meetCode(meetUrl);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card">
      {/* Barra de estado */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 text-sm">
        <Radio className={`h-4 w-4 ${status === 'live' ? 'text-emerald' : 'text-ink-faint'}`} />
        <span className="font-semibold text-ink">Reunión</span>
        {code ? (
          <a
            href={meetUrl ?? '#'}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-ink-faint hover:text-ink hover:underline"
          >
            · {code}
          </a>
        ) : null}
        <StatusPill status={status} className="ml-1" />
        {!dead ? (
          <div className="ml-auto flex items-center gap-1">
            {voiceEnabled ? (
              <button
                type="button"
                onClick={toggleMute}
                title={
                  muted
                    ? 'Cortex está en silencio — activar voz'
                    : 'Si te nombran en la llamada («Cortex, …») responde en voz alta — toca para silenciar'
                }
                className={`inline-flex items-center gap-1 rounded-pill px-2 py-1 text-xs font-medium ${
                  muted ? 'text-ink-faint hover:bg-surface-2' : 'bg-primary-soft text-primary'
                }`}
              >
                {muted ? <MicOff className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                {muted ? 'Voz en silencio' : 'Voz activa'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={leave}
              className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" /> Salir de la reunión
            </button>
          </div>
        ) : null}
      </div>

      {detail && (status === 'failed' || status === 'waiting-admit') ? (
        <div className="border-b border-border bg-surface-2 px-4 py-2 text-xs text-ink-muted">
          {detail}
        </div>
      ) : null}

      {snapshot?.recordingUrl ? (
        <div className="border-b border-border px-4 py-2.5">
          <audio controls src={snapshot.recordingUrl} className="w-full" preload="metadata" />
        </div>
      ) : null}

      {timeline.length > 0 ? (
        <div className="border-b border-border">
          <CallTimeline events={timeline} onSeek={seek} />
        </div>
      ) : null}

      {status === 'live' || people.length > 0 ? (
        <div className="border-b border-border px-4 py-2.5">
          <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            <Users className="h-3.5 w-3.5" /> En la llamada
            {people.length > 0 ? (
              <span className="font-medium normal-case tracking-normal text-ink-muted">
                · {people.length}
              </span>
            ) : null}
          </div>
          <ParticipantStrip people={people} />
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 md:grid-cols-[1.3fr_1fr]">
        {/* Transcript en vivo */}
        <div className="flex min-h-[40vh] min-w-0 flex-col overflow-y-auto border-b border-border p-4 md:min-h-0 md:border-b-0 md:border-r">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            <Mic className="h-3.5 w-3.5" /> {dead ? 'Lo que se dijo' : 'Lo que se dice'}
            {lines.length > 0 ? (
              <span className="ml-auto font-normal normal-case tracking-normal">
                {lines.length} {lines.length === 1 ? 'frase' : 'frases'}
              </span>
            ) : null}
          </div>
          {lines.length === 0 && !partial ? (
            <p className="mt-2 text-sm text-ink-faint">
              {status === 'live'
                ? 'Escuchando… en cuanto alguien hable, aparece aquí.'
                : dead
                  ? 'No quedó nada transcrito.'
                  : 'Aún no hay nada transcrito.'}
            </p>
          ) : null}
          <div className="flex flex-col gap-2">
            {lines.map((l, i) => {
              const tone = l.speaker ? speakerTone(l.speaker) : null;
              return (
                <p
                  key={`${l.at}-${i}`}
                  ref={(el) => {
                    if (el) lineRefs.current.set(l.at, el);
                    else lineRefs.current.delete(l.at);
                  }}
                  className="text-sm leading-snug text-ink"
                >
                  <button
                    type="button"
                    onClick={() => seek(l.at)}
                    className="mr-2 font-mono text-[11px] text-ink-faint hover:text-ink"
                  >
                    {clock(l.at)}
                  </button>
                  <span className={`font-semibold ${tone?.text ?? 'text-ink-faint'}`}>
                    {l.speaker ?? 'Alguien'}:{' '}
                  </span>
                  {l.text}
                </p>
              );
            })}
            {partial ? (
              <p className="text-sm leading-snug text-ink-faint">
                <span className="mr-2 font-mono text-[11px]">{clock(partial.at)}</span>
                <span
                  className={`font-semibold ${partial.speaker ? speakerTone(partial.speaker).text : ''}`}
                >
                  {partial.speaker ?? 'Alguien'}:{' '}
                </span>
                {partial.text}
              </p>
            ) : null}
          </div>
          <div ref={transcriptEnd} />
        </div>

        {/* Chat de la reunión */}
        <div className="flex min-h-[40vh] min-w-0 flex-col md:min-h-0">
          <div className="flex items-center gap-1.5 px-4 pb-2 pt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            <Sparkles className="h-3.5 w-3.5 text-primary" /> Pregúntame sobre la llamada
          </div>
          <div className="flex flex-1 flex-col gap-2 overflow-y-auto px-4 py-2">
            {chat.length === 0 ? (
              <p className="text-sm text-ink-faint">
                Pregúntame lo que quieras: «resúmeme», «¿qué se decidió?», «¿qué mostraron
                cuando compartieron?», «¿a qué minuto hablaron del precio?».
              </p>
            ) : null}
            {chat.map((m, i) => (
              <div
                key={`${m.role}-${i}`}
                className={`max-w-[85%] rounded-card px-3 py-2 text-sm ${
                  m.role === 'you'
                    ? 'self-end bg-primary text-white'
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
          <div className="flex items-center gap-2 border-t border-border p-3">
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void ask();
              }}
              placeholder={dead ? 'Pregunta sobre lo que se dijo…' : 'Pregunta sobre la reunión…'}
              className="h-9 flex-1 rounded-pill border border-border bg-surface px-3.5 text-sm outline-none focus:border-primary"
            />
            <button
              type="button"
              disabled={asking || !question.trim()}
              onClick={() => void ask()}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-primary text-white disabled:opacity-50"
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
