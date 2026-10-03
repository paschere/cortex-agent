'use client';

import type { GridColumn, GridColumnType, GridRow } from '@/components/datagrid/types';
import { parseInput } from '@/lib/datagrid/format';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { ExternalLink, Plus, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useId, useMemo, useState } from 'react';
import { CellValue, FieldInput, type RawValue, rawFromValue } from './cells';
import {
  TYPE_ICON,
  TYPE_LABEL,
  dangerButton,
  ghostButton,
  inputClass,
  primaryButton,
  selectClass,
} from './primitives';

/**
 * Lo que se abre encima de la grilla: el detalle de una fila, crear una,
 * agregar una columna, editar varias a la vez y confirmar un borrado.
 */

// ---------------------------------------------------------------------------
// Marcos
// ---------------------------------------------------------------------------

export function Sheet({
  open,
  onOpenChange,
  title,
  description,
  side = 'right',
  children,
  footer,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  side?: 'right' | 'bottom' | 'center';
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-ink/25 animate-veil motion-reduce:animate-none" />
        <Dialog.Content
          className={clsx(
            'fixed z-[61] flex flex-col bg-surface text-ink shadow-pop focus:outline-none',
            side === 'right' &&
              'inset-y-0 right-0 w-full max-w-[520px] border-l border-border md:rounded-l-card',
            side === 'bottom' &&
              'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-card border-t border-border',
            side === 'center' &&
              'left-1/2 top-1/2 max-h-[90dvh] w-[calc(100vw-32px)] max-w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-card border border-border',
          )}
        >
          <header className="flex items-start gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-base font-bold text-ink">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-xs text-ink-muted">
                  {description}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">Detalle</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-muted hover:bg-surface-2 hover:text-ink"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" aria-hidden />
            </Dialog.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
              {footer}
            </footer>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Un formulario de campos (crear, editar en bloque)
// ---------------------------------------------------------------------------

function useFieldForm(columns: GridColumn[], initial: Record<string, unknown>) {
  const [raw, setRaw] = useState<Record<string, RawValue>>(() =>
    Object.fromEntries(columns.map((c) => [c.key, rawFromValue(c, initial[c.key])])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const validate = (): Record<string, unknown> | null => {
    const out: Record<string, unknown> = {};
    const errs: Record<string, string> = {};
    for (const c of columns) {
      const r = raw[c.key];
      const parsed = parseInput(c, typeof r === 'boolean' ? r : r);
      if (!parsed.ok) errs[c.key] = parsed.error;
      else if (parsed.value !== null && !(Array.isArray(parsed.value) && !parsed.value.length))
        out[c.key] = parsed.value;
    }
    setErrors(errs);
    return Object.keys(errs).length ? null : out;
  };
  return { raw, setRaw, errors, validate };
}

function FieldRow({
  column,
  raw,
  onChange,
  error,
  people,
}: {
  column: GridColumn;
  raw: RawValue;
  onChange: (raw: RawValue) => void;
  error?: string;
  people?: string[];
}) {
  const id = useId();
  const Icon = TYPE_ICON[column.type];
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 flex items-center gap-1.5 text-micro font-semibold text-ink-muted"
      >
        <Icon className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
        {column.label}
        {column.required ? <span className="text-rose">*</span> : null}
      </label>
      <FieldInput
        id={id}
        column={column}
        raw={raw}
        onChange={onChange}
        error={error}
        people={people}
      />
      {error ? (
        <p role="alert" className="mt-1 text-micro font-semibold text-rose">
          {error}
        </p>
      ) : column.description ? (
        <p className="mt-1 text-micro text-ink-faint">{column.description}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nueva fila
// ---------------------------------------------------------------------------

export function NewRowDialog({
  open,
  onOpenChange,
  columns,
  initial,
  title,
  submitLabel,
  people,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: GridColumn[];
  initial: Record<string, unknown>;
  title: string;
  submitLabel: string;
  people?: string[];
  onSubmit: (values: Record<string, unknown>) => Promise<boolean>;
}) {
  const editable = useMemo(
    () =>
      columns
        .filter((c) => c.editable !== false)
        .sort(
          (a, b) =>
            Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
            Number(Boolean(b.required)) - Number(Boolean(a.required)),
        ),
    [columns],
  );
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} side="center">
      {open ? (
        <NewRowForm
          columns={editable}
          initial={initial}
          people={people}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
          submitLabel={submitLabel}
        />
      ) : null}
    </Sheet>
  );
}

function NewRowForm({
  columns,
  initial,
  people,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  columns: GridColumn[];
  initial: Record<string, unknown>;
  people?: string[];
  onSubmit: (values: Record<string, unknown>) => Promise<boolean>;
  onCancel: () => void;
  submitLabel: string;
}) {
  const form = useFieldForm(columns, initial);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const values = form.validate();
        if (!values) return;
        setBusy(true);
        const ok = await onSubmit(values);
        setBusy(false);
        if (ok) onCancel();
      }}
    >
      {columns.map((c) => (
        <FieldRow
          key={c.key}
          column={c}
          raw={form.raw[c.key] ?? ''}
          onChange={(r) => form.setRaw((s) => ({ ...s, [c.key]: r }))}
          error={form.errors[c.key]}
          people={people}
        />
      ))}
      <div className="sticky bottom-0 -mx-5 -mb-4 flex justify-end gap-2 border-t border-border bg-surface px-5 py-3">
        <button type="button" onClick={onCancel} className={ghostButton}>
          Cancelar
        </button>
        <button type="submit" disabled={busy} className={primaryButton}>
          <Plus className="h-4 w-4" aria-hidden />
          {busy ? 'Creando…' : submitLabel}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Detalle de una fila (si la pantalla no trae el suyo)
// ---------------------------------------------------------------------------

export function RowDrawer({
  row,
  columns,
  onOpenChange,
  title,
  canEdit,
  people,
  onSave,
  onDelete,
  custom,
  extra,
}: {
  row: GridRow | null;
  columns: GridColumn[];
  onOpenChange: (open: boolean) => void;
  title: string;
  canEdit: boolean;
  people?: string[];
  onSave: (key: string, value: unknown) => void;
  onDelete: (() => void) | null;
  custom?: ReactNode;
  extra?: ReactNode;
}) {
  const [editingKey, setEditingKey] = useState<string | null>(null);
  return (
    <Sheet
      open={Boolean(row)}
      onOpenChange={(o) => {
        if (!o) setEditingKey(null);
        onOpenChange(o);
      }}
      title={title}
      footer={
        row && (onDelete || row.href) ? (
          <>
            {onDelete ? (
              <button
                type="button"
                onClick={onDelete}
                className={clsx(
                  ghostButton,
                  'mr-auto text-rose hover:bg-rose-soft hover:text-rose',
                )}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
                Borrar
              </button>
            ) : null}
            {row.href ? (
              <Link href={row.href} className={primaryButton}>
                <ExternalLink className="h-4 w-4" aria-hidden />
                Abrir
              </Link>
            ) : null}
          </>
        ) : null
      }
    >
      {row
        ? (custom ?? (
            <dl className="flex flex-col divide-y divide-border">
              {columns.map((c) => {
                const editable = canEdit && c.editable !== false && !row.locked;
                const Icon = TYPE_ICON[c.type];
                return (
                  <div
                    key={c.key}
                    className="grid grid-cols-[minmax(0,140px)_1fr] items-start gap-3 py-2.5"
                  >
                    <dt className="flex items-center gap-1.5 pt-1 text-micro font-semibold text-ink-muted">
                      <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                      <span className="truncate">{c.label}</span>
                    </dt>
                    <dd className="min-w-0 text-xs text-ink">
                      {editingKey === c.key ? (
                        <InlineField
                          column={c}
                          value={row.values[c.key]}
                          people={people}
                          onDone={(v) => {
                            setEditingKey(null);
                            if (v !== undefined) onSave(c.key, v);
                          }}
                        />
                      ) : editable ? (
                        <button
                          type="button"
                          onClick={() => setEditingKey(c.key)}
                          className="-mx-1.5 block w-[calc(100%+12px)] rounded-sm px-1.5 py-1 text-left hover:bg-surface-2"
                          aria-label={`Editar ${c.label}`}
                        >
                          <CellValue column={c} value={row.values[c.key]} />
                          {row.values[c.key] === undefined ||
                          row.values[c.key] === null ||
                          row.values[c.key] === '' ? (
                            <span className="text-ink-faint">Agregar…</span>
                          ) : null}
                        </button>
                      ) : (
                        <div className="py-1">
                          <CellValue column={c} value={row.values[c.key]} />
                        </div>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          ))
        : null}
      {row && extra ? <div className="mt-4 border-t border-border pt-4">{extra}</div> : null}
    </Sheet>
  );
}

function InlineField({
  column,
  value,
  people,
  onDone,
}: {
  column: GridColumn;
  value: unknown;
  people?: string[];
  onDone: (value: unknown | undefined) => void;
}) {
  const [raw, setRaw] = useState<RawValue>(() => rawFromValue(column, value));
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const save = () => {
    const parsed = parseInput(column, raw);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    onDone(parsed.value);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          onDone(undefined);
        }
      }}
      className="flex flex-col gap-2"
    >
      <FieldInput
        id={id}
        column={column}
        raw={raw}
        onChange={(r) => {
          setRaw(r);
          setError(null);
        }}
        error={error}
        people={people}
      />
      {error ? (
        <p role="alert" className="text-micro font-semibold text-rose">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="submit"
          className="h-8 rounded-pill bg-primary px-3 text-micro font-bold text-white"
        >
          Guardar
        </button>
        <button type="button" onClick={() => onDone(undefined)} className={ghostButton}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Agregar columna
// ---------------------------------------------------------------------------

export function AddColumnDialog({
  open,
  onOpenChange,
  types,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  types: GridColumnType[];
  onSubmit: (input: {
    label: string;
    type: GridColumnType;
    options?: string[];
    required: boolean;
  }) => Promise<boolean>;
}) {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<GridColumnType>(types[0] ?? 'text');
  const [options, setOptions] = useState('');
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const typeId = useId();
  const optId = useId();
  const needsOptions = type === 'select' || type === 'status' || type === 'multi_select';
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Agregar columna"
      side="center"
      description="Las filas que ya existen quedan con esta columna vacía."
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!label.trim()) return setError('Ponle un nombre a la columna.');
          const opts = options
            .split(/[\n,]/)
            .map((s) => s.trim())
            .filter(Boolean);
          if (needsOptions && !opts.length) return setError('Escribe al menos una opción.');
          setBusy(true);
          const ok = await onSubmit({
            label: label.trim(),
            type,
            ...(needsOptions ? { options: [...new Set(opts)] } : {}),
            required,
          });
          setBusy(false);
          if (ok) {
            setLabel('');
            setOptions('');
            setRequired(false);
            setError(null);
            onOpenChange(false);
          }
        }}
      >
        <div>
          <label htmlFor={labelId} className="field-label mb-1 block">
            Nombre
          </label>
          <input
            id={labelId}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={60}
            placeholder="Ej.: Fecha de entrega"
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor={typeId} className="field-label mb-1 block">
            Tipo
          </label>
          <select
            id={typeId}
            value={type}
            onChange={(e) => setType(e.target.value as GridColumnType)}
            className={clsx(selectClass, 'w-full')}
          >
            {types.map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        {needsOptions ? (
          <div>
            <label htmlFor={optId} className="field-label mb-1 block">
              Opciones (una por línea o separadas por coma)
            </label>
            <textarea
              id={optId}
              value={options}
              onChange={(e) => setOptions(e.target.value)}
              rows={4}
              placeholder={'Pendiente\nEn curso\nHecho'}
              className={clsx(inputClass, 'h-auto py-2')}
            />
          </div>
        ) : null}
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          <input
            type="checkbox"
            checked={required}
            onChange={(e) => setRequired(e.target.checked)}
          />
          Obligatoria en filas nuevas
        </label>
        {error ? (
          <p role="alert" className="text-micro font-semibold text-rose">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => onOpenChange(false)} className={ghostButton}>
            Cancelar
          </button>
          <button type="submit" disabled={busy} className={primaryButton}>
            {busy ? 'Agregando…' : 'Agregar columna'}
          </button>
        </div>
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------
// Editar varias filas a la vez
// ---------------------------------------------------------------------------

export function BulkEditDialog({
  open,
  onOpenChange,
  columns,
  count,
  people,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columns: GridColumn[];
  count: number;
  people?: string[];
  onSubmit: (key: string, value: unknown) => void;
}) {
  const editable = columns.filter((c) => c.editable !== false);
  const [key, setKey] = useState(editable[0]?.key ?? '');
  const column = editable.find((c) => c.key === key) ?? editable[0];
  const [raw, setRaw] = useState<RawValue>('');
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  const valueId = useId();
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={`Cambiar ${count} ${count === 1 ? 'fila' : 'filas'}`}
      side="center"
      description="El mismo valor para todas las marcadas."
    >
      {column ? (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const parsed = parseInput(column, raw);
            if (!parsed.ok) return setError(parsed.error);
            onSubmit(column.key, parsed.value);
            onOpenChange(false);
          }}
        >
          <div>
            <label htmlFor={selectId} className="field-label mb-1 block">
              Columna
            </label>
            <select
              id={selectId}
              value={column.key}
              onChange={(e) => {
                setKey(e.target.value);
                const next = editable.find((c) => c.key === e.target.value);
                setRaw(next ? rawFromValue(next, null) : '');
                setError(null);
              }}
              className={clsx(selectClass, 'w-full')}
            >
              {editable.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={valueId} className="field-label mb-1 block">
              Nuevo valor
            </label>
            <FieldInput
              id={valueId}
              column={column}
              raw={raw}
              onChange={(r) => {
                setRaw(r);
                setError(null);
              }}
              error={error}
              people={people}
            />
            {error ? (
              <p role="alert" className="mt-1 text-micro font-semibold text-rose">
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => onOpenChange(false)} className={ghostButton}>
              Cancelar
            </button>
            <button type="submit" className={primaryButton}>
              Aplicar a {count}
            </button>
          </div>
        </form>
      ) : (
        <p className="text-xs text-ink-muted">No hay columnas que se puedan editar.</p>
      )}
    </Sheet>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirm,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={title} side="center">
      <p className="text-sm text-ink-muted">{body}</p>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" onClick={() => onOpenChange(false)} className={ghostButton}>
          Cancelar
        </button>
        <button
          type="button"
          onClick={() => {
            onConfirm();
            onOpenChange(false);
          }}
          className={dangerButton}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          {confirm}
        </button>
      </div>
    </Sheet>
  );
}
