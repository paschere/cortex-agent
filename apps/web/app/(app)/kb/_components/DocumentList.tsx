'use client';

import { Provenance } from '@/components/ui/provenance';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AudioLines, FolderSearch, Loader2, ScanText, Upload, Video } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { describeOutcome } from '../_lib/deletion';
import { deleteDocument, deleteDocuments, moveDocument } from '../actions';
import { clock, num, plural, shortDate } from './format';
import { usePrefersReducedMotion } from './motion';
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
    label: 'Procesando ahora',
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
  pointedAt,
  found,
  onOpenFragments,
}: {
  spaceId: string;
  spaceName: string;
  canWrite: boolean;
  moveTargets: Array<{ id: string; name: string; kind: SpaceKind }>;
  /** Opened from the ring or from a search hit: scrolled to and marked. */
  pointedAt?: string | null;
  /** Documents the current search landed on, marked wherever they appear. */
  found?: Set<string>;
  /**
   * Open the fragments this document was broken into. The row says what was
   * handed over; this is the only way from here to what was understood, and
   * every row that is in memory offers it.
   */
  onOpenFragments?: (documentId: string) => void;
}) {
  const qc = useQueryClient();
  const router = useRouter();
  const reduced = usePrefersReducedMotion();
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);

  // ------------------------------------------------------- modo selección
  // Quién puede borrar cada documento (su dueño, o quien escribe en el
  // espacio) solo lo sabe el servidor: aquí se deja seleccionar todo y el
  // resultado parcial que vuelve dice la verdad — «8 borrados, 2 se
  // quedaron» — en vez de fingir en el cliente un permiso que no consta.
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmingBatch, setConfirmingBatch] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchNote, setBatchNote] = useState<{ text: string; failed: boolean } | null>(null);

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

  // Landing on a space because a document was opened elsewhere should put that
  // document in front of your eyes, not leave you to find it in a list of
  // eighty. Done as the row registers rather than in an effect, because the row
  // does not exist until the list has been fetched and an effect would fire
  // into an empty page. `led` keeps it to once per document.
  const led = useRef<string | null>(null);
  const register = (id: string, el: HTMLLIElement | null) => {
    if (!el || pointedAt !== id || led.current === id) return;
    led.current = id;
    el.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
  };

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

  // Un refetch puede quitar filas debajo de la selección (otro borró, o un
  // documento cambió de espacio). Lo seleccionado se poda a lo que sigue en
  // pantalla, para que «Borrar N» nunca prometa más de lo que se ve.
  useEffect(() => {
    setSelected((prev) => {
      const alive = new Set(docs.map((d) => d.id));
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [docs]);

  function toggleSelected(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function stopSelecting() {
    setSelecting(false);
    setSelected(new Set());
    setConfirmingBatch(false);
  }

  async function removeSelected() {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBatchBusy(true);
    const res = await deleteDocuments(ids);
    setBatchBusy(false);
    setConfirmingBatch(false);
    if (!res.ok) {
      setBatchNote({ text: res.error, failed: true });
      return;
    }
    setBatchNote({
      text: describeOutcome(res.borrados, res.rechazados),
      failed: res.borrados === 0 && res.rechazados.length > 0,
    });
    stopSelecting();
    qc.invalidateQueries({ queryKey: ['kb-docs', spaceId] });
    router.refresh();
  }

  if (isLoading) {
    return (
      <p className="flex items-center gap-1.5 py-2 text-xs text-ink-faint">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Cargando…
      </p>
    );
  }

  if (docs.length === 0) {
    return (
      <p className="max-w-lg py-2 text-xs leading-relaxed text-ink-muted">
        {spaceName} está vacío. Mete una tarifa, un instructivo, la grabación de una llamada — algo
        que si no, te toca explicar dos veces.
      </p>
    );
  }

  const allSelected = selected.size === docs.length && docs.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {selecting ? (
          <>
            <button
              type="button"
              onClick={() => setSelected(allSelected ? new Set() : new Set(docs.map((d) => d.id)))}
              className="rounded-pill border border-border px-2.5 py-1 text-micro font-semibold text-ink-muted transition-colors hover:border-primary/40 hover:text-primary"
            >
              {allSelected ? 'Quitar la selección' : 'Seleccionar todos'}
            </button>
            <span className="tabular text-micro text-ink-faint">
              {num(selected.size)} de {num(docs.length)}
            </span>
            <button
              type="button"
              onClick={stopSelecting}
              className="ml-auto rounded-pill px-2.5 py-1 text-micro font-semibold text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Cancelar
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              setSelecting(true);
              setBatchNote(null);
              // El confirmador individual que hubiera quedado abierto no debe
              // seguir ofreciendo un botón rojo debajo de un checkbox.
              setConfirming(null);
            }}
            className="ml-auto rounded-pill border border-border px-2.5 py-1 text-micro font-semibold text-ink-muted transition-colors hover:border-primary/40 hover:text-primary"
          >
            Seleccionar
          </button>
        )}
      </div>

      {batchNote && (
        <p
          className={clsx(
            'rounded-card border px-3 py-2 text-xs',
            batchNote.failed
              ? 'border-rose/30 bg-rose-soft text-rose'
              : 'border-border bg-surface-2 text-ink-muted',
          )}
        >
          {batchNote.text}
        </p>
      )}

      {GROUPS.map((group) => {
        const members = docs.filter((d) => group.stages.includes(stageOf(d)));
        if (members.length === 0) return null;
        return (
          <section key={group.label}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-border pb-1.5">
              <span className="field-label">{group.label}</span>
              <span className="tabular text-micro text-ink-faint">{num(members.length)}</span>
              <span className="text-micro text-ink-faint">· {group.hint}</span>
            </div>
            <ul className="divide-y divide-border">
              {members.map((d) => (
                <Row
                  key={d.id}
                  doc={d}
                  canWrite={canWrite}
                  moveTargets={moveTargets}
                  working={busy === d.id}
                  fresh={justRemembered.has(d.id)}
                  pointed={pointedAt === d.id}
                  hit={found?.has(d.id) ?? false}
                  register={(el) => register(d.id, el)}
                  {...(onOpenFragments ? { onOpenFragments } : {})}
                  selecting={selecting}
                  selected={selected.has(d.id)}
                  onToggleSelected={toggleSelected}
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

      {selecting && selected.size > 0 && (
        <div className="sticky bottom-2 z-10 rounded-card border border-border bg-surface px-3.5 py-3 shadow-pop">
          {confirmingBatch ? (
            <div>
              <p className="text-xs leading-relaxed text-ink">
                Borrar{' '}
                <b>
                  {selected.size === 1
                    ? 'este documento'
                    : `estos ${num(selected.size)} documentos`}
                </b>{' '}
                también olvida sus fragmentos indexados: las respuestas que los citaban dejan de
                citarlos. No se puede deshacer.
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={removeSelected}
                  disabled={batchBusy}
                  className="inline-flex items-center gap-1.5 rounded-card bg-rose px-3 py-1 text-micro font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                >
                  {batchBusy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  {batchBusy ? 'Borrando…' : 'Borrarlos'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingBatch(false)}
                  disabled={batchBusy}
                  className="rounded-card px-2.5 py-1 text-micro font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-60"
                >
                  Dejarlos
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular text-xs text-ink">
                {plural(selected.size, 'documento seleccionado', 'documentos seleccionados')}
              </span>
              <button
                type="button"
                onClick={() => setConfirmingBatch(true)}
                className="ml-auto rounded-pill bg-rose px-3 py-1 text-micro font-semibold text-white transition-opacity hover:opacity-90"
              >
                Borrar {plural(selected.size, 'documento', 'documentos')}
              </button>
              <button
                type="button"
                onClick={stopSelecting}
                className="rounded-pill px-2.5 py-1 text-micro font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
              >
                Cancelar
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  doc: d,
  canWrite,
  moveTargets,
  working,
  fresh,
  pointed,
  hit,
  register,
  onOpenFragments,
  selecting,
  selected,
  onToggleSelected,
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
  /** The document somebody just opened from the ring or from a search hit. */
  pointed: boolean;
  /** One of the documents the current search found. */
  hit: boolean;
  register: (el: HTMLLIElement | null) => void;
  onOpenFragments?: (documentId: string) => void;
  /** Modo selección: la fila entera es un checkbox y las acciones se guardan. */
  selecting: boolean;
  selected: boolean;
  onToggleSelected: (id: string) => void;
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: en modo selección la tarjeta entera es solo un blanco de click más grande; el camino de teclado ya existe y es el checkbox, que es un control de verdad.
    <li
      ref={register}
      onClick={selecting ? () => onToggleSelected(d.id) : undefined}
      className={clsx(
        '-mx-2 px-2 py-2.5 transition-colors duration-1000',
        selecting && 'cursor-pointer',
        selecting && selected
          ? 'bg-primary-soft'
          : fresh
            ? 'bg-emerald-soft'
            : pointed
              ? 'bg-primary-soft'
              : hit
                ? 'bg-amber-soft'
                : 'bg-transparent',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        {selecting && (
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelected(d.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Seleccionar ${d.title}`}
            className="mt-1 h-4 w-4 shrink-0 accent-primary"
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-ink">{d.title}</span>
            {(pointed || hit) && !fresh && (
              <span
                className={clsx(
                  'shrink-0 rounded-card px-2 py-0.5 text-micro font-semibold',
                  pointed ? 'bg-primary text-white' : 'bg-amber-soft text-amber',
                )}
              >
                {pointed ? 'este' : 'lo encontró la búsqueda'}
              </span>
            )}
            <span
              className={clsx(
                'inline-flex shrink-0 items-center gap-1 rounded-card px-2 py-0.5 text-micro font-semibold',
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

          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-micro text-ink-faint">
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

        <div className={clsx('flex shrink-0 items-center gap-1.5', selecting && 'hidden')}>
          {/* Only what is actually in memory has fragments to look at. A
              document still being read has none, and offering the link would
              lead to an empty screen that looks like a fault. */}
          {onOpenFragments && stage === 'memory' && (
            <button
              type="button"
              onClick={() => onOpenFragments(d.id)}
              className="inline-flex items-center gap-1 rounded-pill border border-border px-2.5 py-1 text-micro font-semibold text-ink-muted transition-colors hover:border-primary/40 hover:text-primary"
            >
              <ScanText className="h-3.5 w-3.5" />
              Ver sus fragmentos
            </button>
          )}
          {canWrite && (
            <>
              {moveTargets.length > 0 && (
                <select
                  value=""
                  disabled={working}
                  onChange={(e) => onMove(d, e.target.value)}
                  className="h-7 rounded-card border border-border bg-surface px-2.5 text-micro font-medium text-ink-muted focus:border-border-strong disabled:opacity-50"
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
                className="rounded-pill px-2.5 py-1 text-micro font-semibold text-ink-faint transition-colors hover:bg-rose-soft hover:text-rose disabled:opacity-50"
              >
                {working ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Quitar'}
              </button>
            </>
          )}
        </div>
      </div>

      {confirming && (
        <div className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-3 py-2.5">
          <p className="text-xs leading-relaxed text-ink">
            Quitar <b>{d.title}</b> lo borra junto con todo lo que Cortex aprendió de él. Las
            respuestas que lo citaban dejan de citarlo. No se puede deshacer.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onRemove(d)}
              className="rounded-card bg-rose px-3 py-1 text-micro font-semibold text-white transition-opacity hover:opacity-90"
            >
              Quitarlo
            </button>
            <button
              type="button"
              onClick={() => onConfirm(null)}
              className="rounded-card px-2.5 py-1 text-micro font-semibold text-ink-muted transition-colors hover:bg-surface hover:text-ink"
            >
              Dejarlo
            </button>
          </div>
        </div>
      )}

      {error && (
        <p className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose">
          {error}
        </p>
      )}
      {note && !error && (
        <p className="mt-2 rounded-card border border-border bg-surface-2 px-3 py-2 text-micro text-ink-muted">
          {note}
        </p>
      )}
    </li>
  );
}
