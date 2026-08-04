'use client';

import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Loader2, Mic, Square, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Record straight into a space.
 *
 * WHY THIS EXISTS NEXT TO THE DROPZONE. The most useful thing a person knows
 * after a client call is in their head for about ten minutes. Asking them to
 * open a recorder app, save a file, find it, and drag it here loses most of it.
 * Two clicks and thirty seconds of talking is a different feature.
 *
 * Nothing is uploaded until they have heard it back. A voice note is the one
 * kind of document you cannot proofread before saving, so the preview step is
 * not politeness — it is the only chance to notice that the mic picked up
 * nothing, or that the wrong thing was said.
 */

type Phase = 'idle' | 'asking' | 'recording' | 'preview' | 'saving';

/**
 * Chrome and Firefox give Opus in WebM; Safari only does MP4/AAC. Both are on
 * the bucket's allowlist, so the first supported one wins rather than forcing
 * a container Safari would refuse to produce.
 */
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

function extensionFor(mime: string): string {
  if (mime.startsWith('audio/mp4')) return 'm4a';
  if (mime.startsWith('audio/ogg')) return 'ogg';
  return 'webm';
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Permission failures, in the words of what the person should do next. */
function describeMicError(err: unknown): string {
  const name = (err as { name?: string })?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'El navegador tiene bloqueado el micrófono en este sitio. No se grabó ni se envió nada: abre el candado de la barra de direcciones, permite el micrófono y vuelve a intentar.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return 'No hay micrófono. Conecta uno o elige otra entrada en la configuración del equipo y vuelve a intentar.';
  }
  if (name === 'NotReadableError') {
    return 'Otra cosa está usando el micrófono: una llamada u otra pestaña. Ciérrala y vuelve a intentar.';
  }
  return 'No se pudo abrir el micrófono. Subir un archivo de audio funciona igual.';
}

export function AudioRecorder({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; blob: Blob; mime: string } | null>(null);

  const qc = useQueryClient();
  const router = useRouter();

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  const chunksRef = useRef<BlobPart[]>([]);

  /** Everything that holds the microphone open, released in one place. */
  const releaseHardware = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = null;
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    setLevel(0);
  }, []);

  // A recorder left running because someone navigated away keeps the browser's
  // "recording" indicator lit, which is alarming and entirely our fault.
  useEffect(() => releaseHardware, [releaseHardware]);
  useEffect(() => {
    return () => {
      if (preview) URL.revokeObjectURL(preview.url);
    };
  }, [preview]);

  async function start() {
    setError(null);
    const mimeType = pickMimeType();
    if (!mimeType) {
      setError(
        'Este navegador no graba audio. Funciona en un Chrome, Firefox, Edge o Safari reciente — o sube el archivo de audio.',
      );
      return;
    }

    setPhase('asking');
    let stream: MediaStream;
    try {
      // Echo cancellation and noise suppression are on because this is speech
      // for a transcript, not music: cleaner input transcribes better.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      setPhase('idle');
      setError(describeMicError(err));
      return;
    }

    streamRef.current = stream;
    chunksRef.current = [];

    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      releaseHardware();
      if (blob.size === 0) {
        setPhase('idle');
        setError('No se capturó nada. Revisa que esté seleccionado el micrófono correcto.');
        return;
      }
      setPreview({ url: URL.createObjectURL(blob), blob, mime: mimeType });
      setPhase('preview');
    };
    // A timeslice means partial data survives a tab that gets suspended
    // mid-recording instead of the whole take being lost.
    recorder.start(1000);

    startedAtRef.current = Date.now();
    setElapsedMs(0);
    tickRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);

    // The level meter is the only proof that the mic is actually hearing
    // something. Without it a muted input looks exactly like a silent room,
    // and you find out after the call.
    try {
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const loop = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) {
          const centred = (v - 128) / 128;
          sum += centred * centred;
        }
        // RMS, scaled so ordinary speech lands around two thirds of the bar.
        setLevel(Math.min(1, Math.sqrt(sum / data.length) * 3));
        rafRef.current = requestAnimationFrame(loop);
      };
      rafRef.current = requestAnimationFrame(loop);
    } catch {
      // A missing AudioContext costs the meter, not the recording.
    }

    setPhase('recording');
  }

  function stop() {
    recorderRef.current?.stop();
    recorderRef.current = null;
  }

  function discard() {
    if (preview) URL.revokeObjectURL(preview.url);
    setPreview(null);
    setElapsedMs(0);
    setPhase('idle');
  }

  async function save() {
    if (!preview) return;
    setPhase('saving');
    setError(null);

    const startedAt = new Date(startedAtRef.current || Date.now());
    const stamp = startedAt.toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
    const file = new File([preview.blob], `Grabación — ${stamp}.${extensionFor(preview.mime)}`, {
      type: preview.mime,
    });

    const form = new FormData();
    form.append('file', file);
    form.append('space_id', spaceId);
    // Provenance: this was said here, just now, not exported from somewhere.
    form.append('captured', 'recording');
    form.append('recorded_at', startedAt.toISOString());

    const res = await fetch('/api/kb/documents', { method: 'POST', body: form });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? 'No se pudo guardar la grabación. No se perdió nada: vuelve a darle.');
      setPhase('preview');
      return;
    }

    discard();
    qc.invalidateQueries({ queryKey: ['kb-docs', spaceId] });
    router.refresh();
  }

  const recording = phase === 'recording';

  return (
    <div className="rounded-card border border-border bg-surface-2 px-4 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-ink">
            {recording
              ? 'Grabando…'
              : phase === 'asking'
                ? 'Esperando el micrófono…'
                : phase === 'preview' || phase === 'saving'
                  ? 'Escúchalo antes de guardarlo'
                  : 'Graba desde aquí'}
          </p>
          <p className="mt-0.5 text-[11.5px] leading-relaxed text-ink-faint">
            {recording
              ? 'Si son varios, digan su nombre: Cortex cita al hablante y el minuto.'
              : phase === 'preview' || phase === 'saving'
                ? `Todavía no se ha subido nada. Al guardarlo entra en ${spaceName}.`
                : 'Una nota de voz, una llamada, algo que se decidió en voz alta.'}
          </p>
        </div>

        {/* The recorder is used standing up in a warehouse, so the controls
            take the full width of a phone before they sit inline. */}
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
          {recording && (
            <>
              <span className="stat-num text-[15px] text-ink">{formatElapsed(elapsedMs)}</span>
              <LevelMeter level={level} />
            </>
          )}

          {phase === 'idle' && (
            <button
              type="button"
              onClick={start}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-card border border-border-strong bg-surface px-4 py-2.5 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2 sm:w-auto sm:py-2"
            >
              <Mic className="h-4 w-4 text-primary" />
              Grabar
            </button>
          )}

          {phase === 'asking' && (
            <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Permite el micrófono
            </span>
          )}

          {recording && (
            <button
              type="button"
              onClick={stop}
              className="ml-auto inline-flex items-center justify-center gap-1.5 rounded-card bg-rose px-4 py-2.5 text-[13px] font-semibold text-white transition-opacity hover:opacity-90 sm:py-2"
            >
              <Square className="h-3 w-3 fill-current" />
              Parar
            </button>
          )}
        </div>
      </div>

      {preview && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {/* biome-ignore lint/a11y/useMediaCaption: this IS the audio being captioned — the transcript is what the next step produces. */}
          <audio src={preview.url} controls className="h-9 w-full min-w-[200px] flex-1" />
          <button
            type="button"
            onClick={save}
            disabled={phase === 'saving'}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-card bg-primary px-4 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-primary-strong disabled:opacity-50 sm:flex-none"
          >
            {phase === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {phase === 'saving' ? 'Guardando…' : `Guardar en ${spaceName}`}
          </button>
          <button
            type="button"
            onClick={discard}
            disabled={phase === 'saving'}
            className="inline-flex items-center gap-1.5 rounded-card px-3 py-2 text-[12.5px] font-semibold text-ink-faint transition-colors hover:bg-surface hover:text-rose disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Descartar
          </button>
        </div>
      )}

      {error && (
        <p className="mt-2.5 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] leading-relaxed text-rose">
          {error}
        </p>
      )}
    </div>
  );
}

/** Five bars that light up with the input level. */
function LevelMeter({ level }: { level: number }) {
  return (
    <span className="flex items-end gap-0.5" aria-hidden="true">
      {[0.1, 0.3, 0.5, 0.7, 0.85].map((threshold, i) => (
        <span
          key={threshold}
          className={clsx(
            'w-1 rounded-sm transition-colors',
            level >= threshold ? 'bg-primary' : 'bg-border-strong',
          )}
          style={{ height: `${6 + i * 3}px` }}
        />
      ))}
    </span>
  );
}
