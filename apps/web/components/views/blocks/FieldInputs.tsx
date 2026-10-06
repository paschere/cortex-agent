'use client';

import type { ComputedFormField } from '@cortex/agent-tools';
import { formatLocation, mapsUrl } from '@cortex/agent-tools/src/trackers/schema';
import { clsx } from 'clsx';
import { Loader2, LocateFixed, Search, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SubmitTarget } from '../ViewCanvas';

/**
 * Los inputs de los campos «grandes» de un formulario: ubicación, relación,
 * archivo y texto con escáner. Todos hablan el mismo contrato, para que el
 * formulario los trate igual y quien los reemplace sólo toque UNO:
 *
 *   props:  field, id, value (SIEMPRE string), onChange(next: string), onBlur,
 *           invalid, describedBy, className (estilo de input del formulario),
 *           target, blockId.
 *   valor:  el que `coerceValue` guarda — ver `schema.ts`:
 *     - location → «lat,lng» con 6 decimales ("4.710989,-74.072092").
 *     - relation → JSON `{"id":"<uuid>","label":"<nombre>"}`; vacío = "".
 *     - file     → JSON `{"url","name","mime","size"}` (un archivo) o un
 *                  arreglo de ellos si `field.multiple` (máx. 5). `url` es
 *                  `https://…` o una ruta «/…»; `mime` tipo `image/jpeg`;
 *                  `size` en bytes. Con `field.accept === 'image'` todos los
 *                  `mime` empiezan por `image/`. Vacío = "".
 *     - text + `field.scan` → el texto del código leído, tal cual.
 */

export interface FieldInputProps {
  field: ComputedFormField;
  id: string;
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  invalid?: boolean;
  describedBy?: string;
  className: string;
  target: SubmitTarget;
  blockId: string;
}

const SECONDARY_BTN =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-pill border border-border px-3 text-xs font-semibold text-ink transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50';

// ---------------------------------------------------------------------------
// Ubicación
// ---------------------------------------------------------------------------

export function LocationInput({
  field,
  id,
  value,
  onChange,
  onBlur,
  invalid,
  describedBy,
  className,
}: FieldInputProps) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const href = mapsUrl(value);

  function locate() {
    if (!('geolocation' in navigator)) {
      setNote('Este dispositivo no da su ubicación; escríbela como «lat,lng».');
      return;
    }
    setBusy(true);
    setNote(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        onChange(formatLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }));
      },
      (err) => {
        setBusy(false);
        setNote(
          err.code === err.PERMISSION_DENIED
            ? 'No diste permiso de ubicación; escríbela como «lat,lng».'
            : 'No se pudo tomar la ubicación; inténtalo otra vez o escríbela.',
        );
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 },
    );
  }

  return (
    <span className="block">
      <span className="flex items-center gap-2">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          placeholder={field.placeholder ?? 'lat,lng'}
          className={clsx(className, 'tabular min-w-0 flex-1 font-mono')}
        />
        <button
          type="button"
          onClick={locate}
          disabled={busy}
          className={clsx(SECONDARY_BTN, 'h-11')}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <LocateFixed className="h-4 w-4" aria-hidden />
          )}
          Usar mi ubicación
        </button>
      </span>
      {note && <span className="mt-1 block text-micro text-ink-muted">{note}</span>}
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block text-micro text-primary underline-offset-2 hover:underline"
        >
          Ver en Google Maps
        </a>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Relación: elegir una fila de otra tabla
// ---------------------------------------------------------------------------

function relationLabel(value: string): string {
  try {
    const v = JSON.parse(value) as { id?: string; label?: string };
    return v.label || v.id?.slice(0, 8) || '';
  } catch {
    return '';
  }
}

function relationUrl(
  target: SubmitTarget,
  blockId: string,
  field: string,
  q: string,
): string | null {
  const qs = new URLSearchParams({ block: blockId, field, q });
  if (target.kind === 'app') return `/api/views/${target.viewId}/relation?${qs}`;
  if (target.kind === 'public') {
    qs.set('token', target.token);
    return `/api/views/public/relation?${qs}`;
  }
  return null;
}

export function RelationInput({
  field,
  id,
  value,
  onChange,
  onBlur,
  invalid,
  describedBy,
  className,
  target,
  blockId,
}: FieldInputProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const box = useRef<HTMLSpanElement>(null);
  const selected = value ? relationLabel(value) : '';

  // Busca al escribir (con una pausa corta) y sólo mientras la lista está abierta.
  useEffect(() => {
    if (!open) return;
    const url = relationUrl(target, blockId, field.key, q);
    if (!url) {
      setState('idle');
      return;
    }
    let cancelled = false;
    setState('loading');
    const t = setTimeout(async () => {
      try {
        const res = await fetch(url);
        const body = (await res.json().catch(() => null)) as {
          options?: Array<{ id: string; label: string }>;
        } | null;
        if (cancelled) return;
        if (!res.ok || !body?.options) throw new Error('bad');
        setOptions(body.options);
        setState('idle');
      } catch {
        if (!cancelled) setState('error');
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, q, target, blockId, field.key]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) {
        setOpen(false);
        onBlur?.();
      }
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, onBlur]);

  return (
    <span ref={box} className="relative block">
      <button
        type="button"
        id={id}
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onClick={() => setOpen((o) => !o)}
        className={clsx(className, 'flex items-center justify-between gap-2 text-left')}
      >
        <span className={clsx('truncate', !selected && 'text-ink-faint')}>
          {selected || field.placeholder || 'Elige…'}
        </span>
        {selected ? (
          // biome-ignore lint/a11y/useSemanticElements: un botón dentro de un botón no es válido; esto es un acceso rápido con teclado en el propio botón.
          <span
            role="button"
            tabIndex={-1}
            aria-label="Quitar"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
            }}
            onKeyDown={() => {}}
            className="grid h-5 w-5 shrink-0 place-items-center rounded-pill text-ink-muted hover:bg-surface-2"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </span>
        ) : (
          <Search className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
        )}
      </button>
      {open && (
        <span className="absolute left-0 right-0 z-20 mt-1 block rounded-sm border border-border bg-surface p-2 shadow-pop">
          <input
            // biome-ignore lint/a11y/noAutofocus: se abre para buscar; el foco va al buscador.
            autoFocus
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Buscar…"
            className="mb-2 h-9 w-full rounded-sm border border-border bg-surface px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          />
          <span className="block max-h-56 overflow-auto">
            {options.map((o) => (
              <button
                key={o.id}
                type="button"
                aria-pressed={selected === o.label}
                onClick={() => {
                  onChange(JSON.stringify({ id: o.id, label: o.label }));
                  setOpen(false);
                  setQ('');
                }}
                className="block w-full truncate rounded-sm px-2 py-1.5 text-left text-sm text-ink hover:bg-surface-2"
              >
                {o.label}
              </button>
            ))}
            {state === 'loading' && (
              <span className="block px-2 py-1.5 text-xs text-ink-muted">Buscando…</span>
            )}
            {state === 'error' && (
              <span className="block px-2 py-1.5 text-xs text-rose">No se pudo buscar.</span>
            )}
            {state === 'idle' && options.length === 0 && (
              <span className="block px-2 py-1.5 text-xs text-ink-muted">Sin resultados.</span>
            )}
          </span>
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Archivo y escáner: las piezas que otro agente reemplaza por la cámara y el lector
// ---------------------------------------------------------------------------

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
};

/**
 * PLACEHOLDER de archivo: por ahora se pega el enlace `https://` de un archivo
 * ya subido y se arma el valor con su nombre. Cuando haya subida real, este
 * componente se reemplaza entero respetando el contrato del encabezado.
 */
export function FileInput({
  field,
  id,
  value,
  onChange,
  onBlur,
  invalid,
  describedBy,
  className,
}: FieldInputProps) {
  const [text, setText] = useState(() => {
    try {
      const v = JSON.parse(value) as { url?: string } | Array<{ url?: string }>;
      return (Array.isArray(v) ? v : [v]).map((f) => f.url ?? '').join(' ');
    } catch {
      return '';
    }
  });

  function commit(next: string) {
    setText(next);
    const urls = next
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, field.multiple ? 5 : 1);
    if (urls.length === 0) return onChange('');
    const files = urls.map((url) => {
      const name = decodeURIComponent(url.split('?')[0]?.split('/').pop() || 'archivo');
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      return {
        url,
        name,
        mime:
          MIME_BY_EXT[ext] ??
          (field.accept === 'image' ? 'image/jpeg' : 'application/octet-stream'),
        size: 0,
      };
    });
    onChange(JSON.stringify(field.multiple ? files : files[0]));
  }

  return (
    <input
      id={id}
      type="url"
      value={text}
      onChange={(e) => commit(e.target.value)}
      onBlur={onBlur}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      placeholder={
        field.placeholder ??
        (field.accept === 'image'
          ? 'Enlace de la foto (https://…)'
          : 'Enlace del archivo (https://…)')
      }
      className={className}
    />
  );
}

/** PLACEHOLDER del escáner: hoy es un texto normal; el lector de códigos lo reemplaza. */
export function ScanInput({
  field,
  id,
  value,
  onChange,
  onBlur,
  invalid,
  describedBy,
  className,
}: FieldInputProps) {
  return (
    <input
      id={id}
      type="text"
      data-scan="true"
      autoComplete="off"
      maxLength={400}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      placeholder={field.placeholder ?? 'Escribe o escanea el código'}
      className={clsx(className, 'tabular font-mono')}
    />
  );
}
