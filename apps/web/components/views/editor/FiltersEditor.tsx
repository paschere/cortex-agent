'use client';

import {
  DAYS_OPS,
  type EditorFilterOp,
  FILTER_OPS,
  FILTER_OP_LABEL,
  VALUELESS_OPS,
} from '@/lib/views/editor-shape';
import { type EditorSource, emptyFilter, fieldOptions } from '@/lib/views/editor-spec';
import type { ViewFilter } from '@cortex/agent-tools';
import { Plus } from 'lucide-react';
import { AddButton, FieldSelect, INPUT, NumberInput, RemoveButton, ValueInput } from './controls';

/**
 * LOS FILTROS COMO FRASES: «Estado» «no es» «Pagada».
 *
 * Cada fila se lee de izquierda a derecha como se diría en voz alta. El
 * operador sólo ofrece lo que tiene sentido para el tipo del campo (nadie
 * pregunta si un nombre es «mayor que»), y el valor cambia de forma con el
 * campo: opciones si es de opciones, calendario si es fecha, número si es
 * número, y «días» para los de próximos/últimos días.
 */

const TEXT_OPS: EditorFilterOp[] = ['eq', 'neq', 'contains', 'empty', 'not_empty'];
const NUMBER_OPS: EditorFilterOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'empty', 'not_empty'];
const DATE_OPS: EditorFilterOp[] = [
  'before_today',
  'after_today',
  'next_days',
  'last_days',
  'eq',
  'gt',
  'lt',
  'empty',
  'not_empty',
];
const SELECT_OPS: EditorFilterOp[] = ['eq', 'neq', 'empty', 'not_empty'];

function opsFor(type: string | undefined): EditorFilterOp[] {
  if (type === 'number' || type === 'money') return NUMBER_OPS;
  if (type === 'date') return DATE_OPS;
  if (type === 'select') return SELECT_OPS;
  if (type === 'text') return TEXT_OPS;
  return [...FILTER_OPS];
}

export function FiltersEditor({
  source,
  filters,
  onChange,
  max,
}: {
  source: EditorSource | undefined;
  filters: ViewFilter[];
  onChange: (next: ViewFilter[]) => void;
  max: number;
}) {
  const fields = fieldOptions(source);
  const set = (i: number, next: ViewFilter) =>
    onChange(filters.map((f, j) => (j === i ? next : f)));
  return (
    <div className="space-y-2">
      {filters.length === 0 && (
        <p className="text-micro text-ink-faint">Sin filtros: cuenta todas las filas.</p>
      )}
      {filters.map((filter, i) => {
        const field = fields.find((f) => f.key === filter.field);
        const ops = opsFor(field?.type);
        const op = filter.op as EditorFilterOp;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: los filtros no tienen id; el orden es su identidad.
            key={i}
            className="rounded-sm border border-border bg-surface-2/60 p-2"
          >
            <div className="flex items-center gap-1.5">
              <div className="min-w-0 flex-1">
                <FieldSelect
                  ariaLabel={`Campo del filtro ${i + 1}`}
                  fields={fields}
                  value={filter.field}
                  onChange={(key) => {
                    const nextField = fields.find((f) => f.key === key);
                    const nextOps = opsFor(nextField?.type);
                    const nextOp = nextOps.includes(op) ? op : (nextOps[0] ?? 'eq');
                    set(i, {
                      field: key ?? filter.field,
                      op: nextOp,
                      value: VALUELESS_OPS.has(nextOp)
                        ? undefined
                        : DAYS_OPS.has(nextOp)
                          ? 7
                          : (nextField?.options[0] ?? ''),
                    });
                  }}
                />
              </div>
              <RemoveButton
                label={`Quitar el filtro ${i + 1}`}
                onClick={() => onChange(filters.filter((_, j) => j !== i))}
              />
            </div>
            <div className="mt-1.5 grid grid-cols-2 gap-1.5">
              <select
                aria-label={`Condición del filtro ${i + 1}`}
                value={op}
                onChange={(e) => {
                  const nextOp = e.target.value as EditorFilterOp;
                  set(i, {
                    ...filter,
                    op: nextOp,
                    value: VALUELESS_OPS.has(nextOp)
                      ? undefined
                      : DAYS_OPS.has(nextOp)
                        ? Number(filter.value) > 0
                          ? Number(filter.value)
                          : 7
                        : DAYS_OPS.has(op)
                          ? ''
                          : filter.value,
                  });
                }}
                className={INPUT}
              >
                {(ops.includes(op) ? ops : [op, ...ops]).map((o) => (
                  <option key={o} value={o}>
                    {FILTER_OP_LABEL[o]}
                  </option>
                ))}
              </select>
              {VALUELESS_OPS.has(op) ? (
                <span />
              ) : DAYS_OPS.has(op) ? (
                <div className="flex items-center gap-1.5">
                  <NumberInput
                    ariaLabel={`Días del filtro ${i + 1}`}
                    min={1}
                    max={3650}
                    value={
                      typeof filter.value === 'number'
                        ? filter.value
                        : Number(filter.value) || undefined
                    }
                    onChange={(n) => set(i, { ...filter, value: n ?? '' })}
                  />
                  <span className="text-micro text-ink-faint">días</span>
                </div>
              ) : (
                <ValueInput
                  ariaLabel={`Valor del filtro ${i + 1}`}
                  field={field}
                  value={filter.value}
                  onChange={(value) => set(i, { ...filter, value })}
                />
              )}
            </div>
          </div>
        );
      })}
      <AddButton
        disabled={filters.length >= max || !source}
        onClick={() => onChange([...filters, emptyFilter(source)])}
      >
        <Plus className="h-3.5 w-3.5" /> Agregar filtro
      </AddButton>
    </div>
  );
}
