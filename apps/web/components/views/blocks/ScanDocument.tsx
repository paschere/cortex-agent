'use client';

import { compressImage } from '@/lib/views/compress-image';
import { isPendingUrl, previewUrl } from '@/lib/views/offline-files';
import { parseFileValue } from '@/lib/views/upload-rules';
import { mergeScan, scanMessage } from '@cortex/agent-tools/src/trackers/scan-shape';
import type { Suggestion } from '@cortex/agent-tools/src/trackers/autofill-shape';
import { clsx } from 'clsx';
import { Camera, FileScan, ImageIcon, Loader2, Sparkles, WifiOff } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { type ScanResponse, useFormDataSource } from './form-data-source';
import { reportNetworkFailure } from './useConnection';

/**
 * «TOMAR FOTO DEL DOCUMENTO»: la persona fotografía la guía aérea, el manifiesto
 * o la factura y Cortex lee el papel y propone valores para los campos del
 * formulario. Las propuestas se mezclan con lo escrito por el MISMO camino del
 * autofill (`mergeScan` → `mergeSuggestions`): jamás pisan lo que ya escribiste,
 * y lo que se llena queda marcado «Leído del documento» hasta que lo tocas.
 *
 * También lee una foto que ya está adjunta en un campo de foto del formulario.
 * Sin señal no hay lectura (necesita al servidor): se dice y el formulario se
 * llena a mano o se adjunta la foto para después.
 */

export interface ScanFieldLike {
  key: string;
  label: string;
  type: string;
  options?: string[];
  formula?: string;
  lookup?: { via: string; field: string; editable?: boolean };
}

const PDF_MAX_BYTES = 4 * 1024 * 1024; // lo que deja pasar la plataforma en una petición

export type ScanPhase = 'idle' | 'reading' | 'done' | 'error';

export function useDocumentScan(opts: {
  blockId: string;
  fields: ScanFieldLike[];
  values: Record<string, string>;
  setValues: (patch: Record<string, string>) => void;
  /** null = este formulario no puede leer documentos. */
  url: string | null;
  enabled: boolean;
  /** Lo que se hizo con las sugerencias: el formulario las marca como sugeridas. */
  onApplied: (applied: Record<string, string>, source: string) => void;
  previous: () => Record<string, string>;
  /** Los renglones que el documento trajo para la tabla hija (ver `documentRows`). */
  onRows?: (body: ScanResponse) => void;
  /** El archivo elegido o fotografiado, para guardarlo con el registro. */
  onFile?: (file: File) => void;
}) {
  const { blockId, fields, setValues, url, enabled, onApplied, previous, onRows, onFile } = opts;
  const demo = useFormDataSource();
  const valuesRef = useRef(opts.values);
  valuesRef.current = opts.values;
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [thumb, setThumb] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const available = enabled && Boolean(url || demo?.scan);

  const scan = useCallback(
    async (original: Blob, how: { keep?: boolean } = {}) => {
      if (!available) return;
      if (original.type === 'application/pdf' && original.size > PDF_MAX_BYTES) {
        setPhase('error');
        setMessage('Ese PDF pesa más de 4 MB. Envía las páginas como fotos o llena a mano.');
        return;
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setPhase('error');
        setMessage(
          'Sin conexión: leer el documento necesita internet. Llena a mano; la foto puedes adjuntarla en el campo de foto.',
        );
        return;
      }
      abort.current?.abort();
      const ctl = new AbortController();
      abort.current = ctl;
      setPhase('reading');
      setMessage(null);
      try {
        // Se baja a 1920 px y JPEG antes de subir: en datos móviles pesa ~300 KB.
        const file =
          original instanceof File
            ? await compressImage(original)
            : await compressImage(
                new File(
                  [original],
                  original.type === 'application/pdf' ? 'documento.pdf' : 'documento.jpg',
                  { type: original.type },
                ),
              );
        setThumb((old) => {
          if (old) URL.revokeObjectURL(old);
          return file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
        });
        if (how.keep) onFile?.(file);
        let body: ScanResponse | null = null;
        if (demo?.scan) body = await demo.scan(file);
        else if (url) {
          const form = new FormData();
          form.set('blockId', blockId);
          form.set('image', file, file.name);
          const res = await fetch(url, { method: 'POST', body: form, signal: ctl.signal });
          const json = (await res.json().catch(() => null)) as
            | (ScanResponse & { error?: string })
            | null;
          if (!res.ok || !json?.suggestions) {
            setPhase('error');
            setMessage(json?.error ?? 'Cortex no pudo leer la foto ahora. Llena a mano.');
            return;
          }
          body = json;
        }
        if (!body) return;
        const merged = mergeScan(
          fields,
          valuesRef.current,
          body.suggestions as Record<string, Suggestion>,
          previous(),
        );
        if (Object.keys(merged.applied).length) {
          setValues(merged.applied);
          onApplied(merged.applied, 'documento');
        }
        if (body.rows?.length) onRows?.(body);
        setPhase('done');
        setMessage(
          scanMessage(merged, body.read) +
            (body.rows?.length ? ` ${body.rowsTitle}: ${body.rows.length} leídas, revísalas.` : '') +
            (body.note ? ` ${body.note}` : ''),
        );
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        reportNetworkFailure();
        setPhase('error');
        setMessage('Se cortó la conexión mientras se leía la foto. Inténtalo otra vez.');
      }
    },
    [available, blockId, demo, fields, onApplied, onFile, onRows, previous, setValues, url],
  );

  /** Lee una foto que ya está adjunta (una dirección real o una guardada en el teléfono). */
  const scanUrl = useCallback(
    async (src: string) => {
      try {
        const blob = await (await fetch(src)).blob();
        await scan(blob);
      } catch {
        reportNetworkFailure();
        setPhase('error');
        setMessage('No pude abrir esa foto. Toma otra o llena a mano.');
      }
    },
    [scan],
  );

  const dismiss = useCallback(() => {
    setPhase('idle');
    setMessage(null);
  }, []);

  return { available, phase, message, thumb, scan, scanUrl, dismiss };
}

/** Las fotos que ya están adjuntas en los campos de foto del formulario. */
export function attachedImages(
  fields: Array<{ key: string; label: string; type: string }>,
  values: Record<string, string>,
): Array<{ field: string; label: string; name: string; src: string }> {
  const out: Array<{ field: string; label: string; name: string; src: string }> = [];
  for (const f of fields) {
    if (f.type !== 'file') continue;
    for (const file of parseFileValue(values[f.key])) {
      if (!file.mime.startsWith('image/') && file.mime !== 'application/pdf') continue;
      const src = isPendingUrl(file.url) ? previewUrl(file.url) : file.url;
      if (src) out.push({ field: f.key, label: f.label, name: file.name, src });
    }
  }
  return out;
}

export function ScanDocument({
  scan,
  attached,
  large,
  online,
  className,
  compact,
}: {
  scan: ReturnType<typeof useDocumentScan>;
  attached: ReturnType<typeof attachedImages>;
  large?: boolean;
  online: boolean;
  className?: string;
  /** Formulario corto: una sola fila (ícono, título y botones) en vez de una tarjeta con explicación. */
  compact?: boolean;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const id = useId();
  const reading = scan.phase === 'reading';
  const BTN = clsx(
    'inline-flex items-center justify-center gap-2 rounded-pill border font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
    large ? 'h-14 px-5 text-base' : 'h-11 px-4 text-sm',
  );
  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void scan.scan(file, { keep: true });
  };

  if (compact)
    return (
      <section
        aria-labelledby={`${id}-t`}
        className={clsx(
          'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-sm border border-primary/25 bg-primary-soft/50 px-3 py-2',
          className,
        )}
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-pill bg-primary-soft text-primary ring-1 ring-primary/20">
          <FileScan className="h-4 w-4" aria-hidden />
        </span>
        <h3
          id={`${id}-t`}
          title="Guía aérea, manifiesto o factura: Cortex lo lee y llena lo que pueda. Tú revisas."
          className="min-w-0 grow basis-[55%] text-sm font-semibold leading-tight text-ink"
        >
          Tomar foto del documento
        </h3>
        {scan.thumb && (
          <img
            src={scan.thumb}
            alt="Foto del documento que se leyó"
            className="h-9 w-9 shrink-0 rounded-sm border border-border object-cover"
            onError={(e) => {
              e.currentTarget.hidden = true;
            }}
          />
        )}
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          tabIndex={-1}
          aria-label="Tomar foto del documento con la cámara"
          onChange={pick}
        />
        <input
          ref={gallery}
          type="file"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="sr-only"
          tabIndex={-1}
          aria-label="Elegir la foto del documento de la galería"
          onChange={pick}
        />
        <button
          type="button"
          disabled={reading || !online}
          onClick={() => camera.current?.click()}
          className={clsx(
            'inline-flex min-h-11 items-center justify-center gap-2 rounded-pill border border-primary bg-primary px-4 text-xs font-semibold text-white transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50',
            large && 'min-h-12 text-sm',
          )}
        >
          {reading ? (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <Camera className="h-4 w-4" aria-hidden />
          )}
          {reading ? 'Leyendo…' : 'Tomar foto'}
        </button>
        <button
          type="button"
          disabled={reading || !online}
          onClick={() => gallery.current?.click()}
          aria-label="Elegir de la galería"
          title="Elegir de la galería"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-pill border border-border-strong bg-surface text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <ImageIcon className="h-4 w-4" aria-hidden />
        </button>
        {attached.length > 0 && (
          <ul className="flex basis-full flex-wrap gap-2">
            {attached.slice(0, 4).map((a) => (
              <li key={`${a.field}:${a.src}`}>
                <button
                  type="button"
                  disabled={reading || !online}
                  onClick={() => void scan.scanUrl(a.src)}
                  className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-pill border border-border-strong bg-surface px-3 text-xs font-semibold text-ink hover:bg-surface-2 disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                  <span className="truncate">Leer «{a.name}» ({a.label})</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div aria-live="polite" className="basis-full empty:hidden">
          {!online && (
            <p className="flex items-center gap-2 text-xs font-semibold text-amber">
              <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
              Sin conexión: llena a mano.
            </p>
          )}
          {reading && <p className="text-xs font-semibold text-primary-ink">Leyendo el documento…</p>}
          {scan.message && scan.phase !== 'reading' && (
            <p
              role={scan.phase === 'error' ? 'alert' : 'status'}
              className={clsx(
                'rounded-sm px-3 py-2 text-xs leading-relaxed',
                scan.phase === 'error' ? 'bg-amber-soft font-semibold text-amber' : 'bg-surface text-ink-muted',
              )}
            >
              {scan.message}
            </p>
          )}
        </div>
      </section>
    );

  return (
    <section
      aria-labelledby={`${id}-t`}
      className={clsx('rounded-card border border-primary/25 bg-primary-soft/50 p-4', className)}
    >
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-pill bg-primary-soft text-primary ring-1 ring-primary/20">
          <FileScan className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={`${id}-t`} className="text-base font-extrabold leading-tight text-ink">
            Tomar foto del documento
          </h3>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
            Guía aérea, manifiesto o factura: Cortex lo lee y llena lo que pueda. Tú revisas.
          </p>
        </div>
        {scan.thumb && (
          <img
            src={scan.thumb}
            alt="Foto del documento que se leyó"
            className="h-12 w-12 shrink-0 rounded-sm border border-border object-cover"
            onError={(e) => {
              e.currentTarget.hidden = true;
            }}
          />
        )}
      </div>
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-label="Tomar foto del documento con la cámara"
        onChange={pick}
      />
      <input
        ref={gallery}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="sr-only"
        tabIndex={-1}
        aria-label="Elegir la foto del documento de la galería"
        onChange={pick}
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={reading || !online}
          onClick={() => camera.current?.click()}
          className={clsx(BTN, 'border-primary bg-primary text-white hover:bg-primary-strong')}
        >
          {reading ? (
            <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <Camera className="h-5 w-5" aria-hidden />
          )}
          {reading ? 'Leyendo…' : 'Tomar foto'}
        </button>
        <button
          type="button"
          disabled={reading || !online}
          onClick={() => gallery.current?.click()}
          className={clsx(BTN, 'border-border-strong bg-surface text-ink hover:bg-surface-2')}
        >
          <ImageIcon className="h-5 w-5" aria-hidden />
          Elegir de la galería
        </button>
      </div>
      {attached.length > 0 && (
        <ul className="mt-2 flex flex-wrap gap-2">
          {attached.slice(0, 4).map((a) => (
            <li key={`${a.field}:${a.src}`}>
              <button
                type="button"
                disabled={reading || !online}
                onClick={() => void scan.scanUrl(a.src)}
                className="inline-flex min-h-10 max-w-full items-center gap-2 rounded-pill border border-border-strong bg-surface px-3 text-xs font-semibold text-ink hover:bg-surface-2 disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                <span className="truncate">Leer «{a.name}» ({a.label})</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {!online && (
        <p className="mt-3 flex items-center gap-2 text-xs font-semibold text-amber">
          <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
          Sin conexión: leer documentos necesita internet. Llena a mano.
        </p>
      )}
      <div aria-live="polite">
        {reading && (
          <p className="mt-3 text-xs font-semibold text-primary-ink">
            Cortex está leyendo el documento… puede tardar unos segundos.
          </p>
        )}
        {scan.message && scan.phase !== 'reading' && (
          <p
            role={scan.phase === 'error' ? 'alert' : 'status'}
            className={clsx(
              'mt-3 rounded-sm px-3 py-2 text-xs leading-relaxed',
              scan.phase === 'error' ? 'bg-amber-soft font-semibold text-amber' : 'bg-surface text-ink-muted',
            )}
          >
            {scan.message}
          </p>
        )}
      </div>
    </section>
  );
}
