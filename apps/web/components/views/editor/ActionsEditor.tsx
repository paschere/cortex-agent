'use client';

import { type EditorSource, fieldOptions } from '@/lib/views/editor-spec';
import type { RowAction } from '@cortex/agent-tools';
import { Plus } from 'lucide-react';
import {
  AddButton,
  Field,
  FieldSelect,
  INPUT,
  RemoveButton,
  Segmented,
  Toggle,
  ValueInput,
} from './controls';

/**
 * LOS BOTONES POR FILA. Dos clases y ninguna más, igual que en el contrato
 * (spec.ts, `rowActionSchema`): «Cambiar un campo» pone un valor FIJO que se
 * elige aquí —nunca uno que mande el navegador— y «Avisar» deja un aviso en
 * la campana de quien creó la vista. Máximo tres por bloque.
 */

function nextActionId(actions: RowAction[]): string {
  const taken = new Set(actions.map((a) => a.id));
  let n = actions.length + 1;
  while (taken.has(`boton_${n}`)) n++;
  return `boton_${n}`;
}

export function ActionsEditor({
  source,
  actions,
  onChange,
}: {
  source: EditorSource | undefined;
  actions: RowAction[];
  onChange: (next: RowAction[]) => void;
}) {
  const fields = fieldOptions(source).filter((f) => !f.builtin);
  // «Marcar pagada» casi siempre cambia un campo de opciones (estado): va primero.
  const preferred = fields.find((f) => f.type === 'select') ?? fields[0];
  const set = (i: number, next: RowAction) => onChange(actions.map((a, j) => (j === i ? next : a)));
  return (
    <div className="space-y-2">
      {actions.length === 0 && (
        <p className="text-micro text-ink-faint">
          Un botón en cada fila: «Marcar pagada», «Pedir revisión».
        </p>
      )}
      {actions.map((action, i) => {
        const field = fields.find((f) => f.key === action.field);
        return (
          <div
            key={action.id}
            className="space-y-2 rounded-sm border border-border bg-surface-2/60 p-2.5"
          >
            <div className="flex items-end gap-1.5">
              <Field label="Texto del botón" className="min-w-0 flex-1">
                <input
                  value={action.label}
                  maxLength={32}
                  onChange={(e) => set(i, { ...action, label: e.target.value })}
                  className={INPUT}
                />
              </Field>
              <RemoveButton
                label={`Quitar el botón ${action.label}`}
                onClick={() => onChange(actions.filter((_, j) => j !== i))}
              />
            </div>
            <Segmented
              label="Qué hace"
              size="sm"
              value={action.kind}
              options={[
                { value: 'set_field', label: 'Cambiar un campo' },
                { value: 'notify', label: 'Avisar' },
              ]}
              onChange={(kind) =>
                set(
                  i,
                  kind === 'notify'
                    ? { ...action, kind, field: undefined, value: undefined }
                    : {
                        ...action,
                        kind,
                        field: preferred?.key,
                        value: preferred?.options[0] ?? '',
                      },
                )
              }
            />
            {action.kind === 'set_field' ? (
              <div className="grid grid-cols-2 gap-1.5">
                <FieldSelect
                  ariaLabel="Campo que cambia"
                  fields={fields}
                  value={action.field}
                  onChange={(key) => {
                    const f = fields.find((x) => x.key === key);
                    set(i, { ...action, field: key, value: f?.options[0] ?? '' });
                  }}
                />
                <ValueInput
                  ariaLabel="Valor que pone"
                  field={field}
                  value={action.value}
                  onChange={(value) => set(i, { ...action, value })}
                />
              </div>
            ) : (
              <p className="text-micro text-ink-faint">
                Avisa en la campana a quien creó la vista y a los administradores.
              </p>
            )}
            <Toggle
              label="Pedir confirmación"
              checked={action.confirm}
              onChange={(confirm) => set(i, { ...action, confirm })}
            />
          </div>
        );
      })}
      <AddButton
        disabled={actions.length >= 3 || !source}
        onClick={() =>
          onChange([
            ...actions,
            {
              id: nextActionId(actions),
              label: 'Marcar listo',
              kind: preferred ? 'set_field' : 'notify',
              field: preferred?.key,
              value: preferred ? (preferred.options.at(-1) ?? '') : undefined,
              confirm: false,
              tone: 'primary',
            },
          ])
        }
      >
        <Plus className="h-3.5 w-3.5" /> Agregar botón
      </AddButton>
    </div>
  );
}
