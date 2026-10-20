'use client';

import type { ComputedFormField } from '@cortex/agent-tools';
import { formatLocation, mapsUrl } from '@cortex/agent-tools/src/trackers/schema';
import { clsx } from 'clsx';
import { Loader2, LocateFixed, Search, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { SubmitTarget } from '../ViewCanvas';
import { FileInput as RealFileInput } from '../inputs/FileInput';
import { ScanInput as RealScanInput } from '../inputs/ScanInput';
import { SignatureInput } from '../inputs/SignatureInput';
import {
  Initial,
  RelationSheet,
  chosenDetail,
  parseRelation,
  useRelationSource,
} from './RelationPicker';

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
  /**
   * Relación: se avisa al elegir (con lo que traen los campos «traídos» de esa
   * fila, `pick`) y al quitar (null), para que el formulario llene sus lookups.
   */
  onPick?: (pick: Record<string, string | number> | null) => void;
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

/**
 * El campo de relación: un botón grande que abre la hoja de búsqueda
 * (RelationPicker) y, ya elegido, la TARJETA de lo elegido (iniciales, nombre y
 * un dato para reconocerlo) con «Cambiar» y «Quitar». El valor sigue siendo el
 * JSON `{"id","label"}` de siempre.
 */
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
  onPick,
}: FieldInputProps) {
  const [open, setOpen] = useState(false);
  // Elegir y cerrar no es «salir sin elegir»: el aviso de «falta» sólo si se cerró sin escoger nada.
  const picked = useRef(false);
  const source = useRelationSource(target, blockId, field.key);
  const selected = parseRelation(value);
  const detail = selected ? chosenDetail(selected.id)?.detail : undefined;
  const noun = field.label.toLocaleLowerCase('es-CO');

  return (
    <span className="block">
      {selected ? (
        <span
          className={clsx(
            'flex items-center gap-3 rounded-sm border bg-surface px-3 py-2',
            invalid ? 'border-rose' : 'border-border-strong',
          )}
        >
          <Initial label={selected.label} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-base font-semibold text-ink">{selected.label}</span>
            {detail && <span className="block truncate text-xs text-ink-muted">{detail}</span>}
          </span>
          <button
            type="button"
            id={id}
            aria-describedby={describedBy}
            onClick={() => setOpen(true)}
            className="inline-flex h-10 shrink-0 items-center rounded-pill border border-border-strong px-3 text-xs font-semibold text-ink hover:bg-surface-2"
          >
            Cambiar
          </button>
          <button
            type="button"
            aria-label={`Quitar ${selected.label}`}
            onClick={() => {
              onChange('');
              onPick?.(null);
              onBlur?.();
            }}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-pill text-ink-muted hover:bg-surface-2"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </span>
      ) : (
        <button
          type="button"
          id={id}
          aria-haspopup="dialog"
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onClick={() => setOpen(true)}
          className={clsx(className, 'flex items-center justify-between gap-2 text-left')}
        >
          <span className="truncate text-ink-faint">
            {field.placeholder || `Elegir ${noun}…`}
          </span>
          <Search className="h-5 w-5 shrink-0 text-ink-faint" aria-hidden />
        </button>
      )}
      <RelationSheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (next) picked.current = false;
          else if (!picked.current) onBlur?.();
        }}
        title={field.label}
        addNoun={noun}
        source={source}
        selectedId={selected?.id}
        onSelect={(o) => {
          picked.current = true;
          onChange(JSON.stringify({ id: o.id, label: o.label }));
          onPick?.(o.pick ?? {});
        }}
      />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Archivo y escáner: las piezas que otro agente reemplaza por la cámara y el lector
// ---------------------------------------------------------------------------

/** Subida real (inputs/FileInput): foto con cámara o galería, comprimida en el navegador. */
export function FileInput({
  field,
  value,
  onChange,
  onBlur,
  target,
  blockId,
  className,
}: FieldInputProps) {
  // Firma dibujada: un lienzo, no cámara ni galería.
  if (field.accept === 'signature')
    return (
      <div onBlur={onBlur}>
        <SignatureInput
          value={value}
          onChange={onChange}
          target={target}
          blockId={blockId}
          field={field.key}
          large={className.includes('h-14')}
        />
      </div>
    );
  return (
    <div onBlur={onBlur}>
      <RealFileInput
        value={value}
        onChange={onChange}
        accept={field.accept === 'any' ? 'any' : 'image'}
        multiple={field.multiple}
        target={target}
        blockId={blockId}
        field={field.key}
        large={className.includes('h-14')}
        evidence={field.evidence}
        watermark={field.watermark}
      />
    </div>
  );
}

/** Texto con lector de códigos de barras y QR (inputs/ScanInput). */
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
    <RealScanInput
      id={id}
      value={value}
      onChange={onChange}
      onBlur={onBlur}
      invalid={invalid}
      describedBy={describedBy}
      inputClassName={className}
      placeholder={field.placeholder ?? 'Escribe o escanea el código'}
      continuous={field.scanMode === 'continuous'}
      multiline={field.type === 'longtext'}
    />
  );
}
