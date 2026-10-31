'use client';

import { formatCompactMoney, formatNumber } from '@/lib/datagrid/format';
import { applyComputed } from '@cortex/agent-tools/src/trackers/computed';
import {
  type FormLine,
  MAX_LINES,
  normalizeLines,
  parseLinesValue,
  serializeLines,
} from '@cortex/agent-tools/src/views/form-lines';
import { compressImage } from '@/lib/views/compress-image';
import { isPendingUrl, previewUrl, stashBlob } from '@/lib/views/offline-files';
import { checkUpload, parseFileValue, serializeFileValue } from '@/lib/views/upload-rules';
import { clsx } from 'clsx';
import { Camera, Loader2, Minus, Plus, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import type { SubmitTarget } from '../ViewCanvas';
import { OfflineUploadError, uploadFile } from '../inputs/FileInput';
import { NumberInput } from './NumberInput';
import { Initial, RelationSheet, useRelationSource } from './RelationPicker';

/**
 * LA LISTA DE ÍTEMS CON CANTIDAD DE UN FORMULARIO («elegir varios equipos, cada
 * uno con su cantidad»). Cada línea es un ítem de otra tabla y una cantidad; al
 * enviar, el servidor las guarda como filas hijas (ver
 * packages/agent-tools/src/views/form-lines.ts).
 *
 * Pensada para el pulgar: el botón de agregar abre la misma hoja de búsqueda de
 * las relaciones (con «+ Agregar» si el rol puede), cada línea trae un
 * contador de 44 px con − y +, y elegir otra vez un ítem que ya está suma 1 en
 * vez de duplicarlo. El valor viaja como JSON en `values.__lines`.
 */

export interface LinesConfig {
  title: string;
  itemLabel: string;
  qtyLabel: string;
  min?: number;
  max?: number;
  decimals?: boolean;
  /** Foto por línea (se guarda en un campo `file` de la tabla hija); `required`: sin ella no se envía. */
  photo?: { label: string; required: boolean };
  /** Monto por línea (fórmula de la tabla hija), calculado aquí al instante. */
  amount?: {
    key: string;
    label: string;
    qtyKey: string;
    itemKey: string;
    fields: Array<{ key: string; label: string; type: string; formula?: string; lookup?: { via: string; field: string; editable?: boolean }; percent?: boolean; options?: string[] }>;
    format: 'money' | 'number';
  };
}

/**
 * La foto de UNA línea: un botón de cámara (trasera en el teléfono) que se vuelve
 * miniatura. Sube por la misma ruta que los campos `file`; sin señal la guarda en
 * el teléfono y sube al enviar (ver offline-files.ts).
 */
function LinePhoto({
  value,
  onChange,
  label,
  required,
  who,
  target,
  blockId,
  fieldKey,
  large,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  required: boolean;
  /** El nombre de la línea, para los lectores de pantalla. */
  who: string;
  target: SubmitTarget;
  blockId: string;
  fieldKey: string;
  large?: boolean;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = parseFileValue(value);
  const first = files[0];

  async function handle(list: FileList | null) {
    const original = list?.[0];
    if (!original) return;
    setError(null);
    const pre = checkUpload(original, 'image');
    if (!pre.ok && !original.type.startsWith('image/')) return setError(pre.error);
    setBusy(true);
    try {
      const file = original.type.startsWith('image/') ? await compressImage(original) : original;
      const check = checkUpload(file, 'image');
      if (!check.ok) return setError(check.error);
      const saveHere = async () => onChange(serializeFileValue([await stashBlob(file as File)], false));
      const live = target.kind === 'app' || target.kind === 'custom_app' || target.kind === 'public';
      if (live && typeof navigator !== 'undefined' && !navigator.onLine) return await saveHere();
      try {
        onChange(serializeFileValue([await uploadFile(target, blockId, fieldKey, file, () => {})], false));
      } catch (e) {
        if (e instanceof OfflineUploadError) await saveHere();
        else setError(e instanceof Error ? e.message : 'No se pudo subir la foto.');
      }
    } finally {
      setBusy(false);
    }
  }

  const size = large ? 'h-14 w-14' : 'h-11 w-11';
  return (
    <span className="flex items-center gap-2">
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          void handle(e.target.files);
          e.target.value = '';
        }}
      />
      {first ? (
        <span className="relative">
          <button
            type="button"
            aria-label={`Cambiar la foto de ${who}`}
            onClick={() => cameraRef.current?.click()}
            className="block"
          >
            {(previewUrl(first.url) ?? !isPendingUrl(first.url)) ? (
              <img
                src={previewUrl(first.url) ?? first.url}
                alt={`${label} de ${who}`}
                className={clsx(size, 'rounded-sm border border-border-strong object-cover')}
              />
            ) : (
              <span className={clsx(size, 'grid place-items-center rounded-sm border border-border-strong text-ink-muted')}>
                <Camera className="h-5 w-5" aria-hidden />
              </span>
            )}
          </button>
          <button
            type="button"
            aria-label={`Quitar la foto de ${who}`}
            onClick={() => onChange('')}
            className="absolute -right-2 -top-2 grid h-6 w-6 place-items-center rounded-full bg-ink text-white shadow"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          aria-label={`${label} de ${who}${required ? ' (obligatoria)' : ''}`}
          onClick={() => cameraRef.current?.click()}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-pill border-2 px-3 font-semibold transition-colors disabled:opacity-50',
            large ? 'min-h-12 text-base' : 'min-h-11 text-sm',
            required
              ? 'border-primary/40 bg-primary/5 text-primary hover:bg-primary/10'
              : 'border-border-strong text-ink-muted hover:bg-surface-2',
          )}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Camera className="h-4 w-4" aria-hidden />}
          {label}
          {required && <span aria-hidden className="text-rose">*</span>}
        </button>
      )}
      {first && isPendingUrl(first.url) && (
        <span className="text-micro leading-tight text-amber">Se sube al enviar</span>
      )}
      {error && <span role="alert" className="text-micro font-semibold text-rose">{error}</span>}
    </span>
  );
}

export function LinesInput({
  id,
  config,
  value,
  onChange,
  onBlur,
  target,
  blockId,
  fieldKey,
  error,
  large,
}: {
  id: string;
  config: LinesConfig;
  /** JSON de las líneas (`[]` o vacío = ninguna). */
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  target: SubmitTarget;
  blockId: string;
  /** La llave con que se piden las opciones de ítems (`__lines`). */
  fieldKey: string;
  error?: string;
  large?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const source = useRelationSource(target, blockId, fieldKey);
  const lines = parseLinesValue(value) ?? [];
  const max = Math.min(config.max ?? MAX_LINES, MAX_LINES);
  const noun = config.itemLabel.toLocaleLowerCase('es-CO');
  const btn = large ? 'h-12 w-12' : 'h-11 w-11';

  const write = (next: FormLine[]) => {
    onChange(next.length ? serializeLines(next) : '');
  };
  const setPhoto = (itemId: string, photo: string) =>
    write(
      lines.map((l) => {
        if (l.item.id !== itemId) return l;
        const { photo: _old, ...rest } = l;
        return photo ? { ...rest, photo } : rest;
      }),
    );
  const setQty = (itemId: string, qty: number) =>
    write(lines.map((l) => (l.item.id === itemId ? { ...l, qty } : l)));
  const step = config.decimals ? 0.5 : 1;
  const total = lines.reduce((n, l) => n + (Number.isFinite(l.qty) ? l.qty : 0), 0);
  // El monto de cada línea con la MISMA fórmula que corre el servidor al guardar.
  const amountOf = (l: FormLine): number | null => {
    const a = config.amount;
    if (!a) return null;
    const res = applyComputed<string | number>(a.fields, {
      ...(l.pick ?? {}),
      [a.qtyKey]: l.qty,
    });
    const raw = res.values[a.key];
    const n = raw === undefined ? Number.NaN : Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  const showAmount = (n: number) =>
    config.amount?.format === 'money' ? formatCompactMoney(n) : formatNumber(n, 2);
  const amounts = lines.map(amountOf);
  const grand = amounts.reduce<number>((n, v) => n + (v ?? 0), 0);
  const missingPrice = config.amount ? amounts.filter((v) => v === null).length : 0;

  return (
    <div id={id} role="group" aria-label={config.title} onBlur={onBlur} className="space-y-2">
      {lines.length > 0 && (
        <ul className="divide-y divide-border overflow-hidden rounded-sm border border-border-strong bg-surface">
          {lines.map((l) => (
            <li
              key={l.item.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5"
            >
              <span className="order-1">
                <Initial label={l.item.label || '?'} />
              </span>
              <span className="order-2 min-w-0 flex-1">
                <span className="block truncate text-base font-semibold text-ink">
                  {l.item.label || 'Sin nombre'}
                </span>
                {config.amount && (
                  <span className="block text-xs text-ink-muted" aria-live="polite">
                    {config.amount.label}:{' '}
                    {(() => {
                      const v = amountOf(l);
                      return v === null ? 'sin tarifa' : <strong className="text-ink">{showAmount(v)}</strong>;
                    })()}
                  </span>
                )}
              </span>
              <button
                type="button"
                aria-label={`Quitar ${l.item.label}`}
                onClick={() => write(lines.filter((x) => x.item.id !== l.item.id))}
                className="order-3 grid h-11 w-11 shrink-0 place-items-center rounded-pill text-ink-muted hover:bg-rose-soft hover:text-rose sm:order-5"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
              <span
                className="order-4 flex w-full items-center justify-between gap-1 sm:w-auto sm:justify-end"
                role="group"
                aria-label={`${config.qtyLabel} de ${l.item.label}`}
              >
                <span className="text-xs font-semibold text-ink-muted sm:sr-only">
                  {config.qtyLabel}
                </span>
                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Una menos de ${l.item.label}`}
                    disabled={l.qty <= step}
                    onClick={() => setQty(l.item.id, Math.max(step, l.qty - step))}
                    className={clsx(
                      btn,
                      'grid place-items-center rounded-pill border border-border-strong text-ink hover:bg-surface-2 disabled:opacity-40',
                    )}
                  >
                    <Minus className="h-4 w-4" aria-hidden />
                  </button>
                  <span className="w-16">
                    <NumberInput
                      id={`${id}-${l.item.id}`}
                      value={String(l.qty)}
                      decimals={config.decimals ? 3 : 0}
                      onChange={(next) => setQty(l.item.id, Number(next) || 0)}
                      className={clsx(
                        'w-full rounded-sm border border-border-strong bg-surface px-1 text-center text-base text-ink outline-none focus:border-primary focus-visible:ring-4 focus-visible:ring-primary/15',
                        large ? 'h-12' : 'h-11',
                      )}
                    />
                  </span>
                  <button
                    type="button"
                    aria-label={`Una más de ${l.item.label}`}
                    onClick={() => setQty(l.item.id, l.qty + step)}
                    className={clsx(
                      btn,
                      'grid place-items-center rounded-pill border border-border-strong text-ink hover:bg-surface-2',
                    )}
                  >
                    <Plus className="h-4 w-4" aria-hidden />
                  </button>
                </span>
              </span>
              {config.photo && (
                <span className="order-6 w-full">
                  <LinePhoto
                    value={l.photo ?? ''}
                    onChange={(next) => setPhoto(l.item.id, next)}
                    label={config.photo.label}
                    required={config.photo.required}
                    who={l.item.label || 'la línea'}
                    target={target}
                    blockId={blockId}
                    fieldKey={fieldKey}
                    large={large}
                  />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={lines.length >= max}
        onClick={() => setOpen(true)}
        className={clsx(
          'flex w-full items-center justify-center gap-2 rounded-sm border-2 border-dashed border-border-strong font-semibold text-primary-ink transition-colors hover:border-primary hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-50',
          large ? 'min-h-14 text-lg' : 'min-h-12 text-base',
        )}
      >
        <Plus className="h-5 w-5" aria-hidden />
        Agregar {noun}
      </button>
      <p className="flex items-center justify-between gap-2 text-micro text-ink-muted">
        <span>
          {lines.length === 0
            ? config.min
              ? `Agrega al menos ${config.min}.`
              : 'Opcional: puedes dejarla vacía.'
            : `${lines.length} ${lines.length === 1 ? 'ítem' : 'ítems'} · ${formatNumber(total, 3)} en total`}
          {config.amount && lines.length > 0 && (
            <span aria-live="polite">
              {' · '}
              {config.amount.label} total:{' '}
              <strong className="text-ink">{showAmount(grand)}</strong>
              {missingPrice > 0 ? ` (${missingPrice} sin tarifa)` : ''}
            </span>
          )}
        </span>
        {lines.length >= max && <span>Máximo {max}.</span>}
      </p>
      {error && (
        <p role="alert" className="text-xs font-semibold text-rose">
          {error}
        </p>
      )}
      <RelationSheet
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) onBlur?.();
        }}
        title={config.title}
        addNoun={noun}
        source={source}
        onSelect={(o) =>
          write(
            normalizeLines([
              ...lines,
              { item: { id: o.id, label: o.label }, qty: 1, ...(o.pick ? { pick: o.pick } : {}) },
            ]).slice(0, max),
          )
        }
      />
    </div>
  );
}
