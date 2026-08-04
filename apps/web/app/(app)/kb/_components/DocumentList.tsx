'use client';

import { Provenance } from '@/components/ui/provenance';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AudioLines, FolderSearch, Loader2, Upload, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { deleteDocument, moveDocument } from '../actions';
import { clock, num, plural, shortDate } from './format';
import type { DigestStage, SpaceKind } from './types';

interface Doc {
  id: string;
  title: string;
  mime: string;
  status: string;
  error_message: string | null;
  source: 'upload' | 'gdrive' | 'url' | 'audio' | 'recording' | 'meeting';
  created_at: string;
  media_kind?: 'text' | 'audio' | 'meeting' | null;
  duration_seconds?: number | null;
  transcript_status?: string | null;
  transcript_error?: string | null;
  speakers?: string[] | null;
  recorded_at?: string | null;
}

/**
 * The same collapse `_lib/brain.ts` does on the server, kept in step by hand
 * because this list reads the raw rows straight from the documents route.
 */
function stageOf(d: Doc): DigestStage {
  if (d.status === 'failed' || d.transcript_status === 'failed') return 'stuck';
  if (d.status === 'ready') return 'memory';
  if (d.status === 'ingesting' || d.transcript_status === 'transcribing') return 'digesting';
  return 'waiting';
}

const STAGE_TEXT: Record<DigestStage, { text: string; dot: string; tone: string }> = {
  memory: { text: 'Ya lo recuerda', dot: 'bg-emerald', tone: 'text-emerald' },
  digesting: { text: 'Leyendo y troceando…', dot: 'bg-primary', tone: 'text-primary' },
  waiting: { text: 'En cola', dot: 'bg-amber', tone: 'text-amber' },
  stuck: { text: 'No se pudo leer', dot: 'bg-rose', tone: 'text-rose' },
};

/** How many voices the diarization separated, said in Spanish. */
function voices(speakers?: string[] | null): string | null {
  if (!speakers?.length) return null;
  return plural(speakers.length, 'voz', 'voces');
}

/**
 * What a document can honestly say about its own origin.
 *
 * Returns null when there is nothing to attest to — an upload's provenance is
 * the filename the person chose, which the row already shows.
 */
function provenanceOf(d: Doc): { source: string; readAt?: string; detail?: string } | null {
  if (d.media_kind === 'meeting') {
    const parts = [
      d.duration_seconds ? clock(d.duration_seconds) : null,
      voices(d.speakers),
    ].filter(Boolean);
    return {
      source: 'Google Meet',
      readAt: d.recorded_at ? shortDate(d.recorded_at) : undefined,
      detail: parts.length ? parts.join(' · ') : undefined,
    };
  }
  if (d.media_kind === 'audio' && d.duration_seconds) {
    const spoken = voices(d.speakers);
    return {
      source: d.source === 'recording' ? 'Grabado aquí' : 'Audio',
      readAt: d.recorded_at ? shortDate(d.recorded_at) : undefined,
      detail: `${clock(d.duration_seconds)}${spoken ? ` · ${spoken}` : ''}`,
    };
  }
  if (d.source === 'gdrive') {
    return { source: 'Google Drive', readAt: shortDate(d.created_at), detail: 'sincronizado' };
  }
  return null;
}

async function fetchDocs(spaceId: string): Promise<Doc[]> {
  const r = await fetch(`/api/kb/documents?spaceId=${spaceId}`);
  const j = await r.json();
  return (j.documents as Doc[]) ?? [];
}

const DONE_STATUSES = new Set(['ready', 'failed']);

/** The order the belt runs in: in flight first, then jams, then memory. */
const GROUPS: Array<{ stages: DigestStage[]; label: string; hint: string }> = [
  {
    stages: ['digesting', 'waiting'],
    label: 'Digiriendo ahora',
    hint: 'todavía no se puede citar',
  },
  { stages: ['stuck'], label: 'Atascados', hint: 'no entraron a la memoria' },
  { stages: ['memory'], label: 'En memoria', hint: 'Cortex ya responde con esto' },
];

export function DocumentList({
  spaceId,
  spaceName,
  canWrite,
  moveTargets,
}: {
  spaceId: string;
  spaceName: string;
  canWrite: boolean;
  moveTargets: Array<{ id: string; name: string; kind: SpaceKind }>;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);

  const { data: docs = [], isLoading } = useQuery({
    queryKey: ['kb-docs', spaceId],
    queryFn: () => fetchDocs(spaceId),
    // Keep polling while anything is still being indexed — a document is not
    // an answer until its text has been read.
    refetchInterval: (query) => {
      const rows = query.state.data ?? [];
      return rows.every((d) => DONE_STATUSES.has(d.status)) ? false : 3000;
    },
  });

  // The one moment worth marking: a document that was being read a second ago
  // is now something Cortex can quote. The row says so, once, and settles.
  const [justRemembered, setJustRemembered] = useState<Set<string>>(new Set());
  const seen = useRef(new Map<string, DigestStage>());
  useEffect(() => {
    const arrived: string[] = [];
    for (const d of docs) {
      const stage = stageOf(d);
      const before = seen.current.get(d.id);
      if (before && before !== 'memory' && stage === 'memory') arrived.push(d.id);
      seen.current.set(d.id, stage);
    }
    if (arrived.length === 0) return;
    setJustRemembered((prev) => new Set([...prev, ...arrived]));
    const t = setTimeout(() => {
      setJustRemembered((prev) => {
        const next = new Set(prev);
        for (const id of arrived) next.delete(id);
        return next;
      });
    }, 4000);
    return () => clearTimeout(t);
  }, [docs]);

  function clearError(id: string) {
    setErrors(({ [id]: _gone, ...rest }) => rest);
  }

  async function move(doc: Doc, targetId: string) {
    if (!targetId) return;
    clearError(doc.id);
    setBusy(doc.id);
    const res = await moveDocument(doc.id, targetId);
    setBusy(null);
    if (!res.ok) {
      setErrors((e) => ({ ...e, [doc.id]: res.error }));
      return;
    }
    setNotes((n) => ({ ...n, [doc.id]: `Se movió a ${res.space}.` }));
    qc.invalidateQueries({ queryKey: ['kb-docs', spaceId] });
    router.refresh();
  }

  async function remove(doc: Doc) {
    clearError(doc.id);
    setBusy(doc.id);
    const res = await deleteDocument(doc.id);
    setBusy(null);
    setConfirming(null);
    if (!res.ok) {
      setErrors((e) => ({ ...e, [doc.id]: res.error }));
      return;
    }
    qc.invalidateQueries({ queryKey: ['kb-docs', spaceId] });
    router.refresh();
  }

  if (isLoading) {
    return (
      <p className="flex items-center gap-1.5 py-2 text-[12.5px] text-ink-faint">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Cargando…
      </p>
    );
  }

  if (docs.length === 0) {
    return (
      <p className="max-w-lg py-2 text-[12.5px] leading-relaxed text-ink-muted">
        {spaceName} está vacío. Mete una tarifa, un instructivo, la grabación de una llamada — algo
        que si no, te toca explicar dos veces.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {GROUPS.map((group) => {
        const rows = docs.filter((d) => group.stages.includes(stageOf(d)));
        if (rows.length === 0) return null;
        return (
          <section key={group.label}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border pb-1.5">
              <span className="field-label">{group.label}</span>
              <span className="tabular text-[11px] text-ink-faint">{num(rows.length)}</span>
              <span className="text-[11px] text-ink-faint">· {group.hint}</span>
            </div>
            <ul className="divide-y divide-border">
              {rows.map((d) => (
                <Row
                  key={d.id}
                  doc={d}
                  canWrite={canWrite}
                  moveTargets={moveTargets}
                  working={busy === d.id}
                  fresh={justRemembered.has(d.id)}
                  confirming={confirming === d.id}
                  onConfirm={(id) => setConfirming(id)}
                  onMove={move}
                  onRemove={remove}
                  error={errors[d.id]}
                  note={notes[d.id]}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Row({
  doc: d,
  canWrite,
  moveTargets,
  working,
  fresh,
  confirming,
  onConfirm,
  onMove,
  onRemove,
  error,
  note,
}: {
  doc: Doc;
  canWrite: boolean;
  moveTargets: Array<{ id: string; name: string; kind: SpaceKind }>;
  working: boolean;
  fresh: boolean;
  confirming: boolean;
  onConfirm: (id: string | null) => void;
  onMove: (doc: Doc, targetId: string) => void;
  onRemove: (doc: Doc) => void;
  error?: string;
  note?: string;
}) {
  const isDrive = d.source === 'gdrive';
  const isAudio = d.media_kind === 'audio';
  // A meeting is spoken material like audio, but it arrived already
  // transcribed from Google Meet — there is no recording to play back, so it
  // gets its own badge rather than being called "Audio".
  const isMeeting = d.media_kind === 'meeting';
  const stage = stageOf(d);
  const status = STAGE_TEXT[stage];
  const provenance = provenanceOf(d);

  return (
    <li
      className={clsx(
        '-mx-2 px-2 py-2.5 transition-colors duration-1000',
        fresh ? 'bg-emerald-soft' : 'bg-transparent',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-[13px] font-medium text-ink">{d.title}</span>
            <span
              className={clsx(
                'inline-flex shrink-0 items-center gap-1 rounded-card px-2 py-0.5 text-[10.5px] font-semibold',
                isDrive
                  ? 'bg-sky-soft text-sky'
                  : isMeeting
                    ? 'bg-primary-soft text-primary'
                    : 'bg-surface-2 text-ink-muted',
              )}
            >
              {isDrive ? (
                <FolderSearch className="h-3 w-3" />
              ) : isMeeting ? (
                <Video className="h-3 w-3" />
              ) : isAudio ? (
                <AudioLines className="h-3 w-3" />
              ) : (
                <Upload className="h-3 w-3" />
              )}
              {isDrive
                ? 'Drive'
                : isMeeting
                  ? 'Reunión'
                  : d.source === 'recording'
                    ? 'Grabado'
                    : isAudio
                      ? 'Audio'
                      : 'Archivo'}
            </span>
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-faint">
            <span className="inline-flex items-center gap-1.5">
              <span
                className={clsx(
                  'h-1.5 w-1.5 rounded-full',
                  status.dot,
                  stage === 'digesting' && 'animate-pulse',
                )}
              />
              <span className={clsx('font-medium', status.tone)}>
                {fresh ? 'Acaba de entrar en memoria' : status.text}
              </span>
            </span>
            {isAudio && (
              <>
                <span>&middot;</span>
                {/* Transcription is the slow half and fails for its own reasons,
                    so it says so in its own words rather than hiding behind
                    "leyendo…". */}
                <span>
                  {d.transcript_status === 'transcribing'
                    ? 'Transcribiendo…'
                    : d.transcript_status === 'failed'
                      ? 'No se pudo transcribir'
                      : d.duration_seconds
                        ? `${clock(d.duration_seconds)}${
                            voices(d.speakers) ? ` · ${voices(d.speakers)}` : ''
                          }`
                        : 'Esperando la transcripción'}
                </span>
              </>
            )}
            {(d.transcript_error ?? d.error_message) && (
              <>
                <span>&middot;</span>
                <span className="text-rose">{d.transcript_error ?? d.error_message}</span>
              </>
            )}
          </div>

          {/*
            The stamp earns its place only where the document really came from
            somewhere: a call that happened on a date, a folder that syncs. An
            upload has no provenance beyond the filename already shown, so it
            gets none — an empty stamp would make every real one mean less.
          */}
          {provenance && (
            <div className="mt-2">
              <Provenance
                source={provenance.source}
                readAt={provenance.readAt}
                detail={provenance.detail}
              />
            </div>
          )}
        </div>

        {canWrite && (
          <div className="flex shrink-0 items-center gap-1.5">
            {moveTargets.length > 0 && (
              <select
                value=""
                disabled={working}
                onChange={(e) => onMove(d, e.target.value)}
                className="h-7 rounded-card border border-border bg-surface px-2.5 text-[11.5px] font-medium text-ink-muted focus:border-border-strong focus:outline-none disabled:opacity-50"
                aria-label={`Mover ${d.title} a otro espacio`}
              >
                <option value="">Mover a…</option>
                {moveTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                    {t.kind === 'global' ? ' (todos)' : ''}
                  </option>
                ))}
              </select>
            )}
            <button
              type="button"
              disabled={working}
              onClick={() => onConfirm(confirming ? null : d.id)}
              className="rounded-card px-2.5 py-1 text-[11.5px] font-semibold text-ink-faint transition-colors hover:bg-rose-soft hover:text-rose disabled:opacity-50"
            >
              {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Quitar'}
            </button>
          </div>
        )}
      </div>

      {confirming && (
        <div className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-3 py-2.5">
          <p className="text-[12px] leading-relaxed text-ink">
            Quitar <b>{d.title}</b> lo borra junto con todo lo que Cortex aprendió de él. Las
            respuestas que lo citaban dejan de citarlo. No se puede deshacer.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onRemove(d)}
              className="rounded-card bg-rose px-3 py-1 text-[11.5px] font-semibold text-white transition-opacity hover:opacity-90"
            >
              Quitarlo
            </button>
            <button
              type="button"
              onClick={() => onConfirm(null)}
              className="rounded-card px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted transition-colors hover:bg-surface hover:text-ink"
            >
              Dejarlo
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
          {error}
        </p>
      )}
      {note && !error && (
        <p className="mt-2 rounded-card border border-border bg-surface-2 px-3 py-2 text-[11.5px] text-ink-muted">
          {note}
        </p>
      )}
    </li>
  );
}
