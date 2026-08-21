'use client';

import { LiveRoom, type LiveStatus, StatusPill, meetCode } from '@/components/meetings/LiveRoom';
import {
  type MeetingParticipant,
  speakerInitials,
  speakerTone,
} from '@/components/meetings/speakers';
import { Panel } from '@/components/ui/panel';
import { MessageSquare, PhoneCall, PhoneOff, Radio } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

/**
 * La superficie de «Llamadas»: la lista de reuniones en curso del espacio de
 * trabajo y, debajo, la sala de la que está seleccionada.
 *
 * La lista se refresca cada 2 s: es lo que hace que la pantalla sea la que se
 * deja abierta — si Cortex entra a otra reunión desde el chat, aparece aquí
 * sola, y si una termina, su estado cambia sin tocar nada. La sala tiene su
 * propio pulso más corto (400 ms + SSE) para el transcript.
 *
 * `?session=` selecciona una sala al llegar desde el chat; sin él se abre la
 * primera que esté viva.
 */

interface CallRow {
  sessionId: string;
  status: LiveStatus;
  detail: string | null;
  meetUrl: string;
  botName: string;
  startedAt: number;
  voiceEnabled?: boolean;
  lines: number;
  lastLine: string | null;
  participants?: MeetingParticipant[];
}

interface ArchiveRow {
  id: string;
  sessionId: string;
  meetUrl: string;
  meetCode: string | null;
  title: string | null;
  startedAt: string;
  participants: MeetingParticipant[];
}

type Feed =
  | { state: 'loading' }
  | { state: 'unconfigured' }
  | { state: 'unreachable' }
  | { state: 'ok'; calls: CallRow[] };

const ALIVE = new Set<LiveStatus>(['joining', 'waiting-admit', 'live']);
const EMPTY_CALLS: CallRow[] = [];

function since(startedAt: number): string {
  const mins = Math.max(0, Math.round((Date.now() - startedAt) / 60_000));
  if (mins < 1) return 'recién';
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.floor(mins / 60);
  return `hace ${h} h ${mins % 60} min`;
}

export function CallsSurface({ initialSession }: { initialSession: string | null }) {
  const router = useRouter();
  const [feed, setFeed] = useState<Feed>({ state: 'loading' });
  const [selected, setSelected] = useState<string | null>(initialSession);
  const [archives, setArchives] = useState<ArchiveRow[]>([]);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const res = await fetch('/api/meetings/live', { cache: 'no-store' });
        if (stop) return;
        if (!res.ok) {
          setFeed({ state: 'unreachable' });
          return;
        }
        const data = (await res.json()) as {
          configured: boolean;
          reachable?: boolean;
          meetings: CallRow[];
        };
        if (!data.configured) setFeed({ state: 'unconfigured' });
        else if (data.reachable === false) setFeed({ state: 'unreachable' });
        else setFeed({ state: 'ok', calls: data.meetings });
      } catch {
        if (!stop) setFeed({ state: 'unreachable' });
      }
    };
    void pull();
    const timer = setInterval(pull, 2_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const res = await fetch('/api/meetings/archive', { cache: 'no-store' });
        if (stop || !res.ok) return;
        const data = (await res.json()) as { calls?: ArchiveRow[] };
        setArchives(data.calls ?? []);
      } catch {
        // El archivo no tumba la pantalla de las vivas.
      }
    };
    void pull();
    const timer = setInterval(pull, 5_000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, []);

  const calls = feed.state === 'ok' ? feed.calls : EMPTY_CALLS;
  const liveIds = new Set(calls.map((c) => c.sessionId));
  const past = archives.filter((a) => !liveIds.has(a.sessionId));

  useEffect(() => {
    if (
      selected &&
      (calls.some((c) => c.sessionId === selected) || archives.some((a) => a.sessionId === selected))
    ) {
      return;
    }
    if (initialSession) return;
    const first =
      calls.find((c) => ALIVE.has(c.status)) ??
      calls[0] ??
      archives.find((a) => !calls.some((c) => c.sessionId === a.sessionId));
    if (first) setSelected(first.sessionId);
  }, [calls, archives, selected, initialSession]);

  const pick = useCallback(
    (id: string) => {
      setSelected(id);
      router.replace(`/calls?session=${encodeURIComponent(id)}`, { scroll: false });
    },
    [router],
  );

  const onGone = useCallback(() => {
    setSelected((id) => {
      if (id && archives.some((a) => a.sessionId === id)) return id;
      router.replace('/calls', { scroll: false });
      return null;
    });
  }, [archives, router]);

  const current = calls.find((c) => c.sessionId === selected) ?? null;
  const archived = past.find((a) => a.sessionId === selected) ?? null;
  const roomId = current?.sessionId ?? archived?.sessionId ?? selected;

  return (
    <div className="flex flex-col gap-4">
      {feed.state === 'unconfigured' ? (
        <Panel className="p-6 text-sm text-ink-muted">
          El bot de reuniones no está conectado en este espacio de trabajo todavía. Alguien de
          operaciones tiene que apuntarlo primero.
        </Panel>
      ) : null}

      {feed.state === 'unreachable' ? (
        <Panel className="p-6 text-sm text-ink-muted">
          No pude comunicarme con el bot de reuniones. Puede estar reiniciándose; esta pantalla
          reintenta sola.
        </Panel>
      ) : null}

      {feed.state === 'ok' && calls.length === 0 && past.length === 0 && !roomId ? (
        <Panel className="flex flex-col items-center gap-3 p-10 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-ink-faint">
            <PhoneOff className="h-5 w-5" />
          </div>
          <p className="text-sm font-semibold text-ink">Ahora mismo no hay ninguna llamada</p>
          <p className="max-w-md text-sm text-ink-muted">
            Para que Cortex entre a una reunión, pégale el enlace de Google Meet en el chat y dile
            «métete a esta reunión». La sala aparece aquí sola, en vivo, y al terminar queda
            guardada para consultarla.
          </p>
          <Link
            href="/chat"
            className="mt-1 inline-flex items-center gap-1.5 rounded-pill bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-ink"
          >
            <MessageSquare className="h-4 w-4" /> Ir al chat
          </Link>
        </Panel>
      ) : null}

      {calls.length > 0 ? (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Llamadas en curso">
          {calls.map((c) => {
            const active = c.sessionId === selected;
            return (
              <button
                key={c.sessionId}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => pick(c.sessionId)}
                className={`flex min-w-[220px] max-w-xs flex-1 flex-col gap-1 rounded-card border px-3.5 py-2.5 text-left transition-colors ${
                  active
                    ? 'border-primary bg-primary-soft'
                    : 'border-border bg-surface hover:bg-surface-2'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Radio
                    className={`h-4 w-4 shrink-0 ${c.status === 'live' ? 'text-emerald' : 'text-ink-faint'}`}
                  />
                  <span className="truncate text-sm font-semibold text-ink">
                    {meetCode(c.meetUrl) || 'Reunión'}
                  </span>
                  <StatusPill status={c.status} className="ml-auto" />
                </div>
                <div className="truncate text-xs text-ink-muted">
                  {c.lastLine ?? (c.status === 'live' ? 'Escuchando…' : (c.detail ?? ''))}
                </div>
                {(c.participants ?? []).length > 0 ? (
                  <div className="flex items-center gap-1">
                    {(c.participants ?? []).slice(0, 5).map((p) => {
                      const tone = speakerTone(p.name);
                      return (
                        <span
                          key={p.id}
                          title={p.name}
                          className={`grid h-5 w-5 place-items-center rounded-full text-[9px] font-bold ${tone.chip} ${
                            p.speaking ? 'ring-2 ring-emerald/50' : ''
                          }`}
                        >
                          {speakerInitials(p.name)}
                        </span>
                      );
                    })}
                    {(c.participants ?? []).length > 5 ? (
                      <span className="text-[10px] text-ink-faint">
                        +{(c.participants ?? []).length - 5}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <div className="text-[11px] text-ink-faint">
                  {c.botName} · {since(c.startedAt)} · {c.lines}{' '}
                  {c.lines === 1 ? 'frase' : 'frases'}
                </div>
              </button>
            );
          })}
        </div>
      ) : null}

      {past.length > 0 ? (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Anteriores
          </p>
          <div className="flex flex-wrap gap-2" role="list" aria-label="Llamadas guardadas">
            {past.map((c) => {
              const active = c.sessionId === selected;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pick(c.sessionId)}
                  className={`flex min-w-[220px] max-w-xs flex-1 flex-col gap-1 rounded-card border px-3.5 py-2.5 text-left transition-colors ${
                    active
                      ? 'border-primary bg-primary-soft'
                      : 'border-border bg-surface hover:bg-surface-2'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <PhoneCall className="h-4 w-4 shrink-0 text-ink-faint" />
                    <span className="truncate text-sm font-semibold text-ink">
                      {c.title ?? c.meetCode ?? meetCode(c.meetUrl) ?? 'Reunión'}
                    </span>
                  </div>
                  {(c.participants ?? []).length > 0 ? (
                    <div className="flex items-center gap-1">
                      {(c.participants ?? []).slice(0, 5).map((p) => {
                        const tone = speakerTone(p.name);
                        return (
                          <span
                            key={p.id}
                            title={p.name}
                            className={`grid h-5 w-5 place-items-center rounded-full text-[9px] font-bold ${tone.chip}`}
                          >
                            {speakerInitials(p.name)}
                          </span>
                        );
                      })}
                    </div>
                  ) : null}
                  <div className="text-[11px] text-ink-faint">
                    {since(Date.parse(c.startedAt))}
                    {c.participants.length > 0 ? ` · ${c.participants.length} en la sala` : ''}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {roomId ? (
        <div className="h-[calc(100vh-20rem)] min-h-[520px]">
          <LiveRoom
            key={roomId}
            sessionId={roomId}
            meetUrl={current?.meetUrl ?? archived?.meetUrl ?? null}
            voiceEnabled={current?.voiceEnabled === true}
            onGone={onGone}
          />
        </div>
      ) : null}

      {feed.state === 'ok' && calls.length > 0 ? (
        <p className="flex items-center gap-1.5 text-xs text-ink-faint">
          <PhoneCall className="h-3.5 w-3.5" /> Cuando una reunión termina, el transcript se guarda
          solo y lo puedes pedir en el chat.
        </p>
      ) : null}
    </div>
  );
}
