'use client';

import type { EditorSource, FieldOption } from '@/lib/views/editor-spec';
import { sourceRefusal } from '@/lib/views/editor-spec';
import { clsx } from 'clsx';
import { X } from 'lucide-react';
import { useId } from 'react';

/**
 * LOS CONTROLES DEL INSPECTOR.
 *
 * Nativos siempre que se pueda: un `<select>` de verdad se abre con la rueda
 * del teléfono, se lee con el lector de pantalla y se maneja con el teclado
 * sin una línea de código nuestra. Lo único hecho a mano son el conmutador
 * (un `role="switch"`) y los botones segmentados, que por dentro son radios.
 */

export const INPUT =
  'w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50';

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: el control llega como hijo.
    <label className={clsx('block', className)}>
      <span className="field-label mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-micro text-ink-faint">{hint}</span>}
    </label>
  );
}

export function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-border pt-4 first:border-0 first:pt-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-ink">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Segmented<T extends string | number>({
  label,
  value,
  options,
  onChange,
  size = 'md',
  hideLabel = false,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: React.ReactNode; title?: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  size?: 'sm' | 'md';
  hideLabel?: boolean;
}) {
  const name = useId();
  return (
    <fieldset>
      <legend className={clsx('field-label mb-1', hideLabel && 'sr-only')}>{label}</legend>
      <div className="inline-flex max-w-full flex-wrap gap-0.5 rounded-pill bg-surface-2 p-0.5">
        {options.map((o) => (
          <label
            key={String(o.value)}
            title={o.title}
            className={clsx(
              'relative cursor-pointer rounded-pill font-semibold transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary/50',
              size === 'sm' ? 'px-2 py-0.5 text-micro' : 'px-3 py-1 text-xs',
              value === o.value
                ? 'bg-surface text-ink shadow-card'
                : 'text-ink-muted hover:text-ink',
              o.disabled && 'cursor-not-allowed opacity-40',
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={value === o.value}
              disabled={o.disabled}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={clsx('flex items-start justify-between gap-3', disabled && 'opacity-50')}>
      <div className="min-w-0">
        <label htmlFor={id} className="block text-sm text-ink">
          {label}
        </label>
        {hint && <p className="text-micro text-ink-faint">{hint}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative mt-0.5 h-5 w-9 shrink-0 rounded-pill transition-colors duration-150 disabled:cursor-not-allowed',
          checked ? 'bg-primary' : 'bg-border-strong',
        )}
      >
        <span
          className={clsx(
            'absolute left-0 top-0.5 h-4 w-4 rounded-pill bg-white shadow-card transition-transform duration-150',
            checked ? 'translate-x-[1.125rem]' : 'translate-x-0.5',
          )}
        />
      </button>
    </div>
  );
}

const FAMILY: Record<EditorSource['kind'], string> = {
  tracker: 'Tablas de tu empresa',
  platform: 'Datos de Cortex (sólo lectura)',
  feed: 'Tu Feed (privado, sólo lectura)',
};

/** Las fuentes agrupadas por familia; las que este bloque no admite salen deshabilitadas con su motivo. */
export function SourceSelect({
  sources,
  value,
  onChange,
  blockType,
}: {
  sources: EditorSource[];
  value: string;
  onChange: (source: EditorSource) => void;
  blockType: string;
}) {
  const current = sources.find((s) => s.slug === value);
  return (
    <select
      value={value}
      onChange={(e) => {
        const next = sources.find((s) => s.slug === e.target.value);
        if (next) onChange(next);
      }}
      className={INPUT}
    >
      {!current && <option value={value}>{value} (no disponible)</option>}
      {(['tracker', 'platform', 'feed'] as const).map((kind) => {
        const list = sources.filter((s) => s.kind === kind);
        if (!list.length) return null;
        return (
          <optgroup key={kind} label={FAMILY[kind]}>
            {list.map((s) => {
              const refusal = s.slug === value ? null : sourceRefusal(blockType, s);
              return (
                <option
                  key={s.slug}
                  value={s.slug}
                  disabled={Boolean(refusal)}
                  title={refusal ?? s.description}
                >
                  {s.name}
                  {refusal ? ' — no sirve aquí' : ''}
                </option>
              );
            })}
          </optgroup>
        );
      })}
    </select>
  );
}

export function FieldSelect({
  fields,
  value,
  onChange,
  emptyLabel,
  ariaLabel,
}: {
  fields: FieldOption[];
  value: string | undefined;
  onChange: (key: string | undefined) => void;
  /** Si existe, se puede dejar sin elegir. */
  emptyLabel?: string;
  ariaLabel?: string;
}) {
  const known = !value || fields.some((f) => f.key === value);
  return (
    <select
      aria-label={ariaLabel}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || undefined)}
      className={INPUT}
    >
      {emptyLabel !== undefined && <option value="">{emptyLabel}</option>}
      {!known && <option value={value}>{value} (no existe)</option>}
      {fields.map((f) => (
        <option key={f.key} value={f.key}>
          {f.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Una lista de campos elegidos, en orden: fichas que se quitan con ✕ y un menú
 * para agregar el siguiente. El orden es el de las columnas en la tabla.
 */
export function FieldChips({
  label,
  fields,
  value,
  onChange,
  max,
  emptyHint,
}: {
  label: string;
  fields: FieldOption[];
  value: string[];
  onChange: (next: string[]) => void;
  max: number;
  emptyHint: string;
}) {
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const left = fields.filter((f) => !value.includes(f.key));
  return (
    <div>
      <span className="field-label mb-1 block">{label}</span>
      {value.length === 0 ? (
        <p className="mb-2 text-micro text-ink-faint">{emptyHint}</p>
      ) : (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {value.map((key) => (
            <li
              key={key}
              className={clsx(
                'inline-flex items-center gap-1 rounded-pill border py-0.5 pl-2.5 pr-1 text-xs',
                byKey.has(key)
                  ? 'border-border bg-surface-2 text-ink'
                  : 'border-amber/40 bg-amber-soft text-amber',
              )}
            >
              {byKey.get(key)?.label ?? key}
              <button
                type="button"
                aria-label={`Quitar ${byKey.get(key)?.label ?? key}`}
                onClick={() => onChange(value.filter((k) => k !== key))}
                className="grid h-5 w-5 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface hover:text-ink"
              >
                <X className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length < max && left.length > 0 && (
        <select
          aria-label={`Agregar a ${label.toLowerCase()}`}
          value=""
          onChange={(e) => e.target.value && onChange([...value, e.target.value])}
          className={clsx(INPUT, 'text-ink-muted')}
        >
          <option value="">+ Agregar…</option>
          {left.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** Un valor para un campo: opciones si es de opciones, fecha, número o texto. */
export function ValueInput({
  field,
  value,
  onChange,
  ariaLabel,
}: {
  field: FieldOption | undefined;
  value: string | number | undefined;
  onChange: (value: string | number) => void;
  ariaLabel: string;
}) {
  if (field?.type === 'select' && field.options.length)
    return (
      <select
        aria-label={ariaLabel}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
        className={INPUT}
      >
        <option value="">Elige…</option>
        {field.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  const numeric = field?.type === 'number' || field?.type === 'money';
  return (
    <input
      aria-label={ariaLabel}
      type={field?.type === 'date' ? 'date' : numeric ? 'number' : 'text'}
      inputMode={numeric ? 'decimal' : undefined}
      step="any"
      maxLength={200}
      value={value ?? ''}
      onChange={(e) => {
        const raw = e.target.value;
        onChange(numeric && raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw);
      }}
      className={INPUT}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  ariaLabel,
  placeholder,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  ariaLabel?: string;
  placeholder?: string;
}) {
  return (
    <input
      aria-label={ariaLabel}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      placeholder={placeholder}
      value={value ?? ''}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(undefined);
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(n);
      }}
      className={INPUT}
    />
  );
}

export function AddButton({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-xs font-semibold text-primary transition-colors duration-150 hover:bg-primary-soft disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint transition-colors duration-150 hover:bg-rose-soft hover:text-rose"
    >
      <X className="h-4 w-4" />
    </button>
  );
}
