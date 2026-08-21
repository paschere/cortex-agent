'use client';

import { type LiveStatus, StatusPill, meetCode } from '@/components/meetings/LiveRoom';
import type { MeetingParticipant } from '@/components/meetings/speakers';
import { ArrowUpRight, Radio } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ResultViewProps } from './registry';

/**
 * EL AVISO DE UNA REUNIÓN EN VIVO, DENTRO DEL CHAT.
 *
 * La sala completa (transcript en tiempo real + chat de la reunión + voz +
 * salir) vive en la pestaña «Llamadas» (components/meetings/LiveRoom.tsx).
 * Aquí solo queda lo que el chat necesita: que la persona vea que Cortex está
 * entrando, cómo va, y un botón para abrir la sala. Antes la sala entera vivía
 * en este lugar y se perdía scroll arriba a los cinco minutos de una reunión
 * de una hora.
 *
 * El estado se refresca en un pulso suave (2 s): la tarjeta no es la sala, no
 * necesita el pulso de 400 ms del transcript.
 */
export function MeetingLive({ result }: ResultViewProps) {
  const r = result as {
    sessionId?: string;
    meetUrl?: string;
    ok?: boolean;
  };
  if (!r?.ok || !r.sessionId) return null;
  return <Notice sessionId={r.sessionId} meetUrl={r.meetUrl} />;
}

function Notice({ sessionId, meetUrl }: { sessionId: string; meetUrl?: string }) {
  const [status, setStatus] = useState<LiveStatus>('joining');
  const [lastLine, setLastLine] = useState<string | null>(null);
  const [lastSpeaker, setLastSpeaker] = useState<string | null>(null);
  const [lines, setLines] = useState(0);
  const [people, setPeople] = useState<MeetingParticipant[]>([]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const pull = async () => {
      try {
        const res = await fetch(`/api/meetings/live/${encodeURIComponent(sessionId)}`, {
          cache: 'no-store',
        });
        if (stop) return;
        if (res.status === 410) {
          // Ya no está en el bot: terminó hace rato. Dejar de preguntar.
          setStatus((s) => (s === 'failed' ? s : 'ended'));
          if (timer) clearInterval(timer);
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as {
          status?: LiveStatus;
          transcript?: { text: string; isFinal?: boolean; speaker?: string | null }[];
          participants?: MeetingParticipant[];
        };
        if (data.status) setStatus(data.status);
        const finals = (data.transcript ?? []).filter((t) => t.isFinal !== false);
        setLines(finals.length);
        setLastLine(finals.at(-1)?.text ?? null);
        setLastSpeaker(finals.at(-1)?.speaker ?? null);
        if (Array.isArray(data.participants)) setPeople(data.participants);
        if ((data.status === 'ended' || data.status === 'failed') && timer) clearInterval(timer);
      } catch {
        // El siguiente pulso reintenta.
      }
    };
    void pull();
    timer = setInterval(pull, 2_000);
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [sessionId]);

  const code = meetCode(meetUrl);
  const dead = status === 'ended' || status === 'failed';

  return (
    <div className="mt-2 flex w-full max-w-xl flex-col gap-2 rounded-card border border-border bg-surface px-3.5 py-3 shadow-card">
      <div className="flex items-center gap-2 text-sm">
        <Radio className={`h-4 w-4 ${status === 'live' ? 'text-emerald' : 'text-ink-faint'}`} />
        <span className="font-semibold text-ink">Reunión</span>
        {code ? <span className="text-xs text-ink-faint">· {code}</span> : null}
        <StatusPill status={status} className="ml-1" />
      </div>
      {lastLine ? (
        <p className="truncate text-xs text-ink-muted">
          <span className="text-ink-faint">
            {lastSpeaker ? `${lastSpeaker} · ` : 'Última frase · '}
          </span>
          {lastLine}
        </p>
      ) : status === 'live' ? (
        <p className="text-xs text-ink-faint">
          Escuchando… en cuanto alguien hable, lo verás en Llamadas.
        </p>
      ) : null}
      {people.length > 0 ? (
        <p className="truncate text-[11px] text-ink-faint">
          {people.map((p) => (p.speaking ? `${p.name} (habla)` : p.name)).join(' · ')}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Link
          href={`/calls?session=${encodeURIComponent(sessionId)}`}
          className="inline-flex items-center gap-1 rounded-pill bg-primary px-3 py-1.5 text-xs font-medium text-white"
        >
          {dead ? 'Ver en Llamadas' : 'Abrir en Llamadas'} <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
        {lines > 0 ? (
          <span className="text-[11px] text-ink-faint">
            {lines} {lines === 1 ? 'frase' : 'frases'} transcritas
          </span>
        ) : null}
      </div>
    </div>
  );
}
