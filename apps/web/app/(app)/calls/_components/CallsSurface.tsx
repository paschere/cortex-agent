'use client';

import {
  BrainBadge,
  BrainDecision,
  type BrainStatus,
  CallInsights,
  type Insights,
} from '@/components/meetings/CallInsights';
import {
  type Line,
  LiveRoom,
  type LiveStatus,
  StatusPill,
  meetCode,
} from '@/components/meetings/LiveRoom';
import {
  type MeetingParticipant,
  speakerInitials,
  speakerTone,
} from '@/components/meetings/speakers';
import { Panel } from '@/components/ui/panel';
import {
  Brain,
  Clock,
  ExternalLink,
  Loader2,
  MessageSquare,
  PhoneCall,
  PhoneOff,
  Radio,
  Users,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * LA PANTALLA DE LLAMADAS: LA LISTA A LA IZQUIERDA, LA LLAMADA A LA DERECHA.
 *
 * A la izquierda, todo lo que Cortex ha escuchado: primero lo que está
 * pasando AHORA (con pulso), después lo anterior agrupado por día, cada una
 * con su título (el que Cortex le puso al leerla), quiénes estaban, una línea
 * de resumen y si quedó o no en Brain Knowledge. A la derecha, la llamada
 * elegida: si está viva, la sala en tiempo real; si ya terminó, la lectura de
 * Cortex (resumen, decisiones, compromisos), la decisión del Brain con su
 * razón y un botón para darle la vuelta, y el transcript completo con el
 * chat para preguntarle.
 *
 * La lista de vivas se refresca cada 2 s; el archivo cada 5 s (una llamada
 * recién colgada tarda unos segundos en aparecer con su lectura: primero
 * entra «por decidir», luego Cortex termina de leerla y cambia sola).
 */

interface LiveCall {
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

interface ArchivedCall {
  id: string;
  sessionId: string;
  meetUrl: string;
  meetCode: string | null;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
  status: 'ended' | 'failed';
  participants: MeetingParticipant[];
  documentId: string | null;
  summary: string | null;
  analyzedAt: string | null;
  brainStatus: BrainStatus;
  brainReason: string | null;
  brainDecidedBy: 'cortex' | 'person' | null;
}

interface ArchivedDetail extends ArchivedCall {
  transcript: Line[];
  insights: Insights | null;
  botName: string | null;
}

type Feed =
  | { state: 'loading' }
  | { state: 'unconfigured' }
  | { state: 'unreachable' }
  | { state: 'ok'; calls: LiveCall[] };

const ALIVE = new Set<LiveStatus>(['joining', 'waiting-admit', 'live']);
const EMPTY_LIVE: LiveCall[] = [];

function since(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 1) return 'recién';
  if (mins < 60) return `hace ${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `hace ${h} h`;
  return new Intl.DateTimeFormat('es-CO', { day: 'numeric', month: 'short' }).format(new Date(ms));
}

function duration(startIso: string, endIso: string | null): string | null {
  if (!endIso) return null;
  const mins = Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60_000);
  if (!Number.isFinite(mins) || mins < 1) return '<1 min';
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

function hour(iso: string): string {
  return new Intl.DateTimeFormat('es-CO', { hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return 'Hoy';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Ayer';
  return new Intl.DateTimeFormat('es-CO', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(d);
}

function Avatars({ people, max = 4 }: { people: MeetingParticipant[]; max?: number }) {
  const shown = people.filter((p) => !p.self).slice(0, max);
  const extra = people.filter((p) => !p.self).length - shown.length;
  if (shown.length === 0) return null;
  return (
    <div className="flex items-center -space-x-1">
      {shown.map((p) => {
        const tone = speakerTone(p.name);
        return (
          <span
            key={p.id}
            title={p.name}
            className={`grid h-5 w-5 place-items-center rounded-full border border-surface text-[9px] font-bold ${tone.chip} ${
              p.speaking ? 'ring-2 ring-emerald/50' : ''
            }`}
          >
            {speakerInitials(p.name)}
          </span>
        );
      })}
      {extra > 0 ? <span className="pl-2 text-[10px] text-ink-faint">+{extra}</span> : null}
    </div>
  );
}

export function CallsSurface({ initialSession }: { initialSession: string | null }) {
  const router = useRouter();
  const [feed, setFeed] = useState<Feed>({ state: 'loading' });
  const [archive, setArchive] = useState<ArchivedCall[] | null>(null);
  const [selected, setSelected] = useState<string | null>(initialSession);

  useEffect(() => {
    let stop = false;
    const pull = async () => {
      try {
        const res = await fetch('/api/meetings/live', { cache: 'no-store' });
        if (stop) return;
        if (!res.ok) return setFeed({ state: 'unreachable' });
        const data = (await res.json()) as {
          configured: boolean;
          reachable?: boolean;
          meetings: LiveCall[];
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
        const data = (await res.json()) as { calls?: ArchivedCall[] };
        setArchive(data.calls ?? []);
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

  const live = feed.state === 'ok' ? feed.calls : EMPTY_LIVE;
  const liveIds = useMemo(() => new Set(live.map((c) => c.sessionId)), [live]);
  const past = useMemo(
    () => (archive ?? []).filter((a) => !liveIds.has(a.sessionId)),
    [archive, liveIds],
  );

  // Sin selección, la primera viva; si no hay, la última guardada.
  useEffect(() => {
    if (selected) return;
    const first = live.find((c) => ALIVE.has(c.status)) ?? live[0];
    if (first) setSelected(first.sessionId);
    else if (past[0]) setSelected(past[0].sessionId);
  }, [live, past, selected]);

  const pick = useCallback(
    (id: string) => {
      setSelected(id);
      router.replace(`/calls?session=${encodeURIComponent(id)}`, { scroll: false });
    },
    [router],
  );

  const currentLive = live.find((c) => c.sessionId === selected) ?? null;
  const currentPast = past.find((a) => a.sessionId === selected) ?? null;

  const patchArchived = useCallback((sessionId: string, patch: Partial<ArchivedCall>) => {
    setArchive(
      (rows) => rows?.map((r) => (r.sessionId === sessionId ? { ...r, ...patch } : r)) ?? rows,
    );
  }, []);

  const groups = useMemo(() => {
    const out: { label: string; items: ArchivedCall[] }[] = [];
    for (const c of past) {
      const label = dayLabel(c.startedAt);
      const g = out[out.length - 1];
      if (g && g.label === label) g.items.push(c);
      else out.push({ label, items: [c] });
    }
    return out;
  }, [past]);

  const pendingCount = past.filter((p) => p.brainStatus === 'pending' && p.analyzedAt).length;
  const nothing = feed.state === 'ok' && live.length === 0 && archive !== null && past.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {feed.state === 'unconfigured' ? (
        <Panel className="p-4 text-sm text-ink-muted">
          El bot de reuniones no está conectado en este espacio de trabajo todavía. Alguien de
          operaciones tiene que apuntarlo primero.
        </Panel>
      ) : null}
      {feed.state === 'unreachable' ? (
        <Panel className="p-4 text-sm text-ink-muted">
          No pude comunicarme con el bot de reuniones. Puede estar reiniciándose; esta pantalla
          reintenta sola.
        </Panel>
      ) : null}

      {nothing ? (
        <Panel className="flex flex-col items-center gap-3 p-10 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-surface-2 text-ink-faint">
            <PhoneOff className="h-5 w-5" />
          </div>
          <p className="text-sm font-semibold text-ink">Todavía no hay llamadas</p>
          <p className="max-w-md text-sm text-ink-muted">
            Pégale a Cortex el enlace de Google Meet en el chat y dile «métete a esta reunión». La
            sala aparece aquí en vivo; al terminar, Cortex la lee, saca lo importante y decide si
            vale la pena guardarla en Brain Knowledge.
          </p>
          <Link
            href="/chat"
            className="mt-1 inline-flex items-center gap-1.5 rounded-pill bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-ink"
          >
            <MessageSquare className="h-4 w-4" /> Ir al chat
          </Link>
        </Panel>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* LA LISTA */}
          <aside className="flex max-h-[calc(100vh-14rem)] min-h-0 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card lg:sticky lg:top-4">
            <div className="flex items-center justify-between border-b border-border px-3.5 py-2.5">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                {live.length + past.length}{' '}
                {live.length + past.length === 1 ? 'llamada' : 'llamadas'}
              </span>
              {pendingCount > 0 ? (
                <span className="inline-flex items-center gap-1 rounded-pill bg-amber-soft px-2 py-0.5 text-[11px] font-medium text-amber">
                  <Brain className="h-3 w-3" /> {pendingCount} por decidir
                </span>
              ) : null}
            </div>
            <div className="scroll-slim min-h-0 flex-1 overflow-y-auto p-2">
              {live.length > 0 ? (
                <>
                  <p className="px-1.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-emerald">
                    En curso
                  </p>
                  <ul className="flex flex-col gap-1">
                    {live.map((c) => {
                      const active = c.sessionId === selected;
                      return (
                        <li key={c.sessionId}>
                          <button
                            type="button"
                            onClick={() => pick(c.sessionId)}
                            aria-current={active ? 'true' : undefined}
                            className={`flex w-full flex-col gap-1 rounded-card border px-3 py-2 text-left transition-colors ${
                              active
                                ? 'border-primary bg-primary-soft'
                                : 'border-transparent hover:bg-surface-2'
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <Radio
                                className={`h-3.5 w-3.5 shrink-0 ${c.status === 'live' ? 'text-emerald' : 'text-ink-faint'}`}
                              />
                              <span className="truncate text-sm font-semibold text-ink">
                                {meetCode(c.meetUrl) || 'Reunión'}
                              </span>
                              <StatusPill status={c.status} className="ml-auto" />
                            </div>
                            <p className="truncate text-xs text-ink-muted">
                              {c.lastLine ??
                                (c.status === 'live' ? 'Escuchando…' : (c.detail ?? ''))}
                            </p>
                            <div className="flex items-center gap-2 text-[11px] text-ink-faint">
                              <Avatars people={c.participants ?? []} />
                              <span>
                                {since(c.startedAt)} · {c.lines}{' '}
                                {c.lines === 1 ? 'frase' : 'frases'}
                              </span>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}

              {archive === null ? (
                <p className="flex items-center gap-2 px-2 py-3 text-xs text-ink-faint">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando las anteriores…
                </p>
              ) : null}

              {groups.map((g) => (
                <div key={g.label}>
                  <p className="px-1.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                    {g.label}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {g.items.map((c) => {
                      const active = c.sessionId === selected;
                      const title = c.title ?? c.meetCode ?? meetCode(c.meetUrl) ?? 'Reunión';
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            onClick={() => pick(c.sessionId)}
                            aria-current={active ? 'true' : undefined}
                            className={`flex w-full flex-col gap-1 rounded-card border px-3 py-2 text-left transition-colors ${
                              active
                                ? 'border-primary bg-primary-soft'
                                : 'border-transparent hover:bg-surface-2'
                            }`}
                          >
                            <div className="flex items-start gap-2">
                              <span className="line-clamp-2 min-w-0 flex-1 text-sm font-semibold leading-snug text-ink">
                                {title}
                              </span>
                              <BrainBadge status={c.brainStatus} compact />
                            </div>
                            {c.summary ? (
                              <p className="line-clamp-2 text-xs text-ink-muted">{c.summary}</p>
                            ) : c.analyzedAt ? null : (
                              <p className="flex items-center gap-1 text-xs text-ink-faint">
                                <Loader2 className="h-3 w-3 animate-spin" /> Cortex la está leyendo…
                              </p>
                            )}
                            <div className="flex items-center gap-2 text-[11px] text-ink-faint">
                              <Avatars people={c.participants} />
                              <span>
                                {hour(c.startedAt)}
                                {duration(c.startedAt, c.endedAt)
                                  ? ` · ${duration(c.startedAt, c.endedAt)}`
                                  : ''}
                                {c.status === 'failed' ? ' · no entró' : ''}
                              </span>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </aside>

          {/* LA LLAMADA */}
          <div className="min-w-0">
            {currentLive ? (
              <div className="h-[calc(100vh-14rem)] min-h-[560px]">
                <LiveRoom
                  key={currentLive.sessionId}
                  sessionId={currentLive.sessionId}
                  meetUrl={currentLive.meetUrl}
                  voiceEnabled={currentLive.voiceEnabled === true}
                />
              </div>
            ) : currentPast ? (
              <PastCall
                key={currentPast.id}
                call={currentPast}
                onBrainChange={(next) =>
                  patchArchived(currentPast.sessionId, {
                    brainStatus: next,
                    brainDecidedBy: 'person',
                    brainReason:
                      next === 'kept'
                        ? 'La guardaste tú desde Llamadas.'
                        : 'La sacaste tú desde Llamadas.',
                  })
                }
              />
            ) : selected && feed.state !== 'ok' ? (
              <div className="h-[calc(100vh-14rem)] min-h-[560px]">
                <LiveRoom key={selected} sessionId={selected} voiceEnabled={false} />
              </div>
            ) : (
              <Panel className="flex h-full min-h-[240px] items-center justify-center p-8 text-sm text-ink-faint">
                Elige una llamada de la lista.
              </Panel>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function PastCall({
  call,
  onBrainChange,
}: {
  call: ArchivedCall;
  onBrainChange: (next: BrainStatus) => void;
}) {
  const [detail, setDetail] = useState<ArchivedDetail | null>(null);
  const [failed, setFailed] = useState(false);

  // El detalle trae el transcript y la lectura completa. Se vuelve a pedir
  // mientras la lectura no esté: la llamada recién colgada aparece primero
  // sin ella y unos segundos después con título, resumen y veredicto.
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const pull = async () => {
      try {
        const res = await fetch(`/api/meetings/archive/${encodeURIComponent(call.id)}`, {
          cache: 'no-store',
        });
        if (stop) return;
        if (!res.ok) return setFailed(true);
        const data = (await res.json()) as ArchivedDetail;
        setDetail(data);
        if (data.analyzedAt && timer) clearInterval(timer);
      } catch {
        if (!stop) setFailed(true);
      }
    };
    void pull();
    timer = setInterval(pull, 4_000);
    return () => {
      stop = true;
      if (timer) clearInterval(timer);
    };
  }, [call.id]);

  const title = detail?.title ?? call.title ?? call.meetCode ?? meetCode(call.meetUrl) ?? 'Reunión';
  const people = (detail?.participants ?? call.participants).filter((p) => !p.self);
  const dur = duration(call.startedAt, call.endedAt);
  const brainStatus = detail?.brainStatus ?? call.brainStatus;
  const brainReason = detail?.brainReason ?? call.brainReason;
  const brainDecidedBy = detail?.brainDecidedBy ?? call.brainDecidedBy;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-start gap-2">
          <h2 className="min-w-0 flex-1 text-lg font-semibold leading-snug text-ink">{title}</h2>
          <a
            href={call.meetUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-pill border border-border px-2.5 py-1 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            {call.meetCode ?? meetCode(call.meetUrl)} <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" />
            {dayLabel(call.startedAt)} · {hour(call.startedAt)}
            {dur ? ` · ${dur}` : ''}
          </span>
          {people.length ? (
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-3.5 w-3.5" />
              <Avatars people={people} max={6} />
              <span className="truncate">{people.map((p) => p.name).join(', ')}</span>
            </span>
          ) : null}
          {call.status === 'failed' ? (
            <span className="inline-flex items-center gap-1 text-rose">
              <PhoneOff className="h-3.5 w-3.5" /> Cortex no alcanzó a entrar
            </span>
          ) : null}
        </div>
      </header>

      <BrainDecision
        callId={call.id}
        status={brainStatus}
        reason={brainReason}
        decidedBy={brainDecidedBy}
        onChange={(next) => {
          setDetail((d) => (d ? { ...d, brainStatus: next, brainDecidedBy: 'person' } : d));
          onBrainChange(next);
        }}
      />

      <CallInsights
        insights={detail?.insights ?? null}
        analyzing={!detail?.analyzedAt && !failed}
      />

      <div className="h-[calc(100vh-18rem)] min-h-[480px]">
        {detail ? (
          <LiveRoom
            key={call.sessionId}
            sessionId={call.sessionId}
            meetUrl={call.meetUrl}
            voiceEnabled={false}
            snapshot={{
              lines: detail.transcript ?? [],
              people: detail.participants ?? [],
            }}
          />
        ) : failed ? (
          <Panel className="p-6 text-sm text-ink-muted">No pude cargar esta llamada.</Panel>
        ) : (
          <Panel className="flex items-center gap-2 p-6 text-sm text-ink-faint">
            <Loader2 className="h-4 w-4 animate-spin" /> Cargando el transcript…
          </Panel>
        )}
      </div>

      <p className="flex items-center gap-1.5 text-xs text-ink-faint">
        <PhoneCall className="h-3.5 w-3.5" /> La llamada queda aquí pase lo que pase; el Brain solo
        decide si la memoria de la empresa la encuentra al buscar.
      </p>
    </div>
  );
}
