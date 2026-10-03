'use client';

import { FEED_ACCEPT, FEED_MAX_BYTES, FEED_MAX_TEXT, type FeedEntry } from '@/lib/feed/shared';
import { clsx } from 'clsx';
import { FileText, Link2, Loader2, Plug, Plus, Upload, X } from 'lucide-react';
import { useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { type ApiWizardClient, ConnectApiWizard } from './ConnectApiWizard';
import { classifyPaste } from './inbox-model';

export type IntakeMode = 'file' | 'url' | 'text' | 'api';

const MODES: Array<{ id: IntakeMode; label: string; icon: typeof Upload }> = [
  { id: 'file', label: 'Subir archivos', icon: Upload },
  { id: 'url', label: 'Pegar enlace', icon: Link2 },
  { id: 'text', label: 'Escribir texto', icon: FileText },
  { id: 'api', label: 'Conectar API', icon: Plug },
];

const input =
  'w-full rounded-sm border border-border-strong bg-surface px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60';
const primary =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-pill bg-primary px-5 text-sm font-bold text-white transition-colors hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50';

/**
 * LA PUERTA DE ENTRADA: un lugar grande donde soltar archivos, y al lado lo
 * demás que se puede traer —un enlace, un texto, una API—. Los cuatro modos
 * de siempre (`?mode=file|url|text|api`) siguen aquí; el campo rápido debajo
 * de la zona de arrastre decide solo si lo pegado es un enlace o un texto.
 */
export function FeedIntake({
  mode,
  onMode,
  busy,
  versionTarget,
  onCancelVersion,
  onFiles,
  onRejected,
  onSubmit,
  apiClient,
  onApiAdded,
}: {
  mode: IntakeMode;
  onMode: (mode: IntakeMode) => void;
  busy: boolean;
  versionTarget: { id: string; kind: 'file' | 'text'; name: string } | null;
  onCancelVersion: () => void;
  onFiles: (files: File[]) => void;
  onRejected: () => void;
  onSubmit: (input: {
    kind: 'url' | 'text';
    url?: string;
    title?: string;
    text?: string;
  }) => Promise<boolean>;
  apiClient: ApiWizardClient;
  onApiAdded: (entry: FeedEntry) => void;
}) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [quick, setQuick] = useState('');

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: FEED_ACCEPT,
    maxSize: FEED_MAX_BYTES,
    disabled: busy,
    onDropAccepted: (files) => onFiles(files),
    onDropRejected: () => onRejected(),
  });

  async function submitQuick(e: React.FormEvent) {
    e.preventDefault();
    const pasted = classifyPaste(quick);
    if (!pasted) return;
    if (pasted.kind === 'url') {
      if (await onSubmit({ kind: 'url', url: pasted.url })) setQuick('');
      return;
    }
    // Un texto largo merece título: se pasa al modo texto con lo pegado.
    setText(pasted.text);
    setQuick('');
    onMode('text');
  }

  return (
    <section
      aria-label="Añadir a la bandeja"
      className="rounded-card border border-border bg-surface p-4 shadow-card sm:p-5"
    >
      <div className="mb-4 flex flex-wrap gap-1" aria-label="Qué quieres traer">
        {MODES.map((m) => (
          <button
            key={m.id}
            type="button"
            disabled={busy}
            aria-pressed={mode === m.id}
            onClick={() => onMode(m.id)}
            className={clsx(
              'inline-flex min-h-9 items-center gap-2 rounded-pill px-3.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50',
              mode === m.id
                ? 'bg-ink text-surface'
                : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
            )}
          >
            <m.icon className="h-4 w-4" aria-hidden />
            {m.label}
          </button>
        ))}
      </div>

      {versionTarget && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-sm bg-primary-soft px-3 py-2 text-sm text-ink">
          <span>
            Nueva versión de <strong>{versionTarget.name}</strong>
          </span>
          <button
            type="button"
            onClick={onCancelVersion}
            className="inline-flex items-center gap-1 font-semibold text-primary"
          >
            <X className="h-3.5 w-3.5" aria-hidden /> Cancelar
          </button>
        </div>
      )}

      {mode === 'api' ? (
        <ConnectApiWizard client={apiClient} onAdded={onApiAdded} />
      ) : mode === 'file' ? (
        <div className="flex flex-col gap-3">
          <div
            {...getRootProps()}
            className={clsx(
              'flex min-h-48 cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed px-4 py-8 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
              isDragActive
                ? 'border-primary bg-primary-soft'
                : 'border-border-strong bg-surface-2/60 hover:border-primary/50 hover:bg-primary-soft/40',
            )}
          >
            <input {...getInputProps({ 'aria-label': 'Subir archivos a la bandeja' })} />
            <span className="mb-3 grid h-14 w-14 place-items-center rounded-card bg-surface text-primary shadow-card">
              {busy ? (
                <Loader2 className="h-6 w-6 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Upload className="h-6 w-6" aria-hidden />
              )}
            </span>
            <p className="text-base font-extrabold text-ink">
              {busy
                ? 'Leyendo el contenido…'
                : isDragActive
                  ? 'Suelta los archivos aquí'
                  : 'Arrastra archivos aquí'}
            </p>
            <p className="mt-1 text-sm text-ink-muted">
              o{' '}
              <span className="font-semibold text-primary underline">haz clic para elegirlos</span>
            </p>
            <p className="mt-3 text-micro text-ink-faint">
              PDF, Word, Excel, CSV, texto y Markdown · hasta <span className="tabular">10 MB</span>{' '}
              por archivo
            </p>
          </div>
          <form onSubmit={submitQuick} className="flex flex-col gap-2 sm:flex-row">
            <label htmlFor="feed-quick" className="sr-only">
              Pega un enlace o un texto
            </label>
            <input
              id="feed-quick"
              value={quick}
              onChange={(e) => setQuick(e.target.value)}
              disabled={busy}
              placeholder="…o pega aquí un enlace (Google Sheets, una página) o un texto"
              className={input}
            />
            <button type="submit" disabled={busy || !quick.trim()} className={primary}>
              <Plus className="h-4 w-4" aria-hidden /> Añadir
            </button>
          </form>
        </div>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const ok = await onSubmit(
              mode === 'url' ? { kind: 'url', url } : { kind: 'text', title, text },
            );
            if (ok) {
              setUrl('');
              setTitle('');
              setText('');
            }
          }}
          className="flex flex-col gap-3"
        >
          {mode === 'url' ? (
            <>
              <label htmlFor="feed-url" className="text-sm font-bold text-ink">
                Google Sheets o página pública
              </label>
              <input
                id="feed-url"
                type="url"
                required
                maxLength={2048}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/…"
                className={clsx(input, 'font-mono')}
                disabled={busy}
              />
              <p className="text-xs leading-relaxed text-ink-muted">
                Sheets usa tu conexión de Google de esta empresa y se guarda una captura que puedes
                actualizar. Otras direcciones deben ser públicas. ¿Quieres que la hoja llene una
                tabla sola? Hazlo desde Datos y conexiones → Hojas de cálculo.
              </p>
            </>
          ) : (
            <>
              <label htmlFor="feed-title" className="text-sm font-bold text-ink">
                Título
              </label>
              <input
                id="feed-title"
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Por ejemplo: contexto para la reunión"
                className={input}
                disabled={busy}
              />
              <label htmlFor="feed-text" className="text-sm font-bold text-ink">
                Contenido
              </label>
              <textarea
                id="feed-text"
                required
                value={text}
                maxLength={FEED_MAX_TEXT}
                onChange={(e) => setText(e.target.value)}
                rows={6}
                placeholder="Pega tus notas, un correo o la información que quieres consultar…"
                className={input}
                disabled={busy}
              />
            </>
          )}
          <div>
            <button disabled={busy} type="submit" className={primary}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Plus className="h-4 w-4" aria-hidden />
              )}
              Añadir a la bandeja
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
