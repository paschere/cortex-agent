'use client';

import { MonitorUp, UserMinus, UserPlus } from 'lucide-react';
import { useState } from 'react';

export type VisibleEvent = {
  at: number;
  kind: 'joined' | 'left' | 'presenting' | 'presenting-end' | 'frame';
  label: string;
  speaker?: string | null;
  path?: string | null;
  caption?: string | null;
  url?: string | null;
};

function clockAt(at: number): string {
  const sec = at > 1e12 ? Math.floor(at / 1000) : Math.max(0, Math.floor(at));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * La cinta de una llamada: minutos, quién compartió, capturas.
 * Un clic en el minuto lleva al transcript; un clic en la foto la agranda.
 */
export function CallTimeline({
  events,
  onSeek,
}: {
  events: VisibleEvent[];
  onSeek?: (at: number) => void;
}) {
  const [open, setOpen] = useState<VisibleEvent | null>(null);
  if (events.length === 0) return null;

  const frames = events.filter((e) => e.url);
  const marks = events.filter((e) => e.kind !== 'frame' || e.url);

  return (
    <section className="rounded-card border border-border bg-surface">
      <header className="flex items-center justify-between px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
          Línea de tiempo
        </h3>
        <span className="text-[11px] text-ink-faint">
          {frames.length} {frames.length === 1 ? 'captura' : 'capturas'}
          {events.some((e) => e.kind === 'presenting') ? ' · hubo pantalla compartida' : ''}
        </span>
      </header>

      {frames.length > 0 ? (
        <div className="flex gap-2 overflow-x-auto border-t border-border px-4 py-3">
          {frames.map((e) => (
            <button
              key={`${e.at}-${e.path}`}
              type="button"
              onClick={() => setOpen(e)}
              className="group relative w-36 shrink-0 overflow-hidden rounded-card border border-border bg-surface-2 text-left"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={e.url ?? ''}
                alt={e.label}
                className="h-20 w-full object-cover"
              />
              <span className="block truncate px-2 py-1.5 font-mono text-[11px] text-ink-muted">
                {clockAt(e.at)}
                {e.speaker ? ` · ${e.speaker}` : ''}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <ol className="max-h-48 space-y-1 overflow-y-auto border-t border-border px-4 py-3">
        {marks.map((e, i) => (
          <li key={`${e.kind}-${e.at}-${i}`}>
            <button
              type="button"
              onClick={() => onSeek?.(e.at)}
              className="flex w-full items-start gap-2 rounded-lg px-1 py-0.5 text-left text-sm hover:bg-surface-2"
            >
              <span className="mt-0.5 font-mono text-[11px] text-ink-faint">{clockAt(e.at)}</span>
              <KindIcon kind={e.kind} />
              <span className="min-w-0 flex-1 text-ink">
                {e.label}
                {e.caption ? (
                  <span className="mt-0.5 block text-xs text-ink-muted">{e.caption}</span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ol>

      {open?.url ? (
        <button
          type="button"
          className="fixed inset-0 z-40 flex items-center justify-center bg-ink/70 p-6"
          onClick={() => setOpen(null)}
        >
          <figure className="max-h-full max-w-4xl" onClick={(ev) => ev.stopPropagation()}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={open.url} alt={open.label} className="max-h-[80vh] rounded-card object-contain" />
            <figcaption className="mt-2 text-sm text-white">
              {clockAt(open.at)} · {open.caption || open.label}
            </figcaption>
          </figure>
        </button>
      ) : null}
    </section>
  );
}

function KindIcon({ kind }: { kind: VisibleEvent['kind'] }) {
  if (kind === 'presenting' || kind === 'presenting-end' || kind === 'frame') {
    return <MonitorUp className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />;
  }
  if (kind === 'joined') {
    return <UserPlus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald" />;
  }
  return <UserMinus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />;
}
