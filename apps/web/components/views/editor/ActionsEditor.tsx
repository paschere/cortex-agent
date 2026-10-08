'use client';

import { type EditorSource, fieldOptions } from '@/lib/views/editor-spec';
import type { RowAction } from '@cortex/agent-tools';
import { Plus } from 'lucide-react';
import {
  AddButton,
  Field,
  FieldChips,
  FieldSelect,
  INPUT,
  RemoveButton,
  Segmented,
  Toggle,
  ValueInput,
} from './controls';

/**
 * LOS BOTONES POR FILA. Tres clases y ninguna más, igual que en el contrato
 * (spec.ts, `rowActionSchema`): «Cambiar un campo» pone un valor FIJO que se
 * elige aquí —nunca uno que mande el navegador— (y puede exigir que antes estén
 * llenos otros campos: foto y nota para terminar), «Avisar» deja un aviso en la
 * campana de quien creó la vista y «Asignar a una persona» (sólo dentro de una
 * aplicación) guarda quién tiene la tarea y le avisa. Máximo tres por bloque.
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
                { value: 'assign', label: 'Asignar' },
              ]}
              onChange={(kind) =>
                set(
                  i,
                  kind === 'notify'
                    ? { ...action, kind, field: undefined, value: undefined }
                    : kind === 'assign'
                      ? {
                          ...action,
                          kind,
                          field: fields.find((f) => f.type === 'text')?.key,
                          value: undefined,
                        }
                      : {
                          ...action,
                          kind,
                          field: preferred?.key,
                          value: preferred?.options[0] ?? '',
                        },
                )
              }
            />
            {action.kind === 'set_field' && (
              <>
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
                <FieldChips
                  label="Antes tienen que estar llenos"
                  fields={fields}
                  value={action.requireFields ?? []}
                  max={6}
                  emptyHint="Ninguno: el botón funciona siempre. Úsalo para exigir foto y nota antes de terminar."
                  onChange={(next) =>
                    set(i, { ...action, requireFields: next.length ? next : undefined })
                  }
                />
              </>
            )}
            {action.kind === 'notify' && (
              <p className="text-micro text-ink-faint">
                Avisa en la campana a quien creó la vista y a los administradores.
              </p>
            )}
            {action.kind === 'assign' && (
              <div className="space-y-1.5">
                <p className="text-micro text-ink-faint">
                  Abre la lista de personas de la app; la elegida queda en la fila y le llega un
                  aviso. Sólo lo ven los roles que asignan tareas.
                </p>
                <Field label="Campo donde se guarda la persona (su id)">
                  <FieldSelect
                    ariaLabel="Campo con la persona"
                    fields={fields.filter((f) => f.type === 'text')}
                    value={action.field}
                    onChange={(key) => set(i, { ...action, field: key })}
                  />
                </Field>
                <Field label="Campo con su nombre">
                  <FieldSelect
                    ariaLabel="Campo con el nombre"
                    fields={fields.filter((f) => f.type === 'text')}
                    value={action.nameField}
                    emptyLabel="Ninguno"
                    onChange={(key) => set(i, { ...action, nameField: key })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-1.5">
                  <FieldSelect
                    ariaLabel="Estado que pone al asignar"
                    fields={fields.filter((f) => f.type === 'select')}
                    value={action.statusField}
                    emptyLabel="No cambia el estado"
                    onChange={(key) => {
                      const f = fields.find((x) => x.key === key);
                      set(i, {
                        ...action,
                        statusField: key,
                        value: key ? f?.options[0] : undefined,
                      });
                    }}
                  />
                  {action.statusField && (
                    <ValueInput
                      ariaLabel="Estado al asignar"
                      field={fields.find((f) => f.key === action.statusField)}
                      value={action.value}
                      onChange={(value) => set(i, { ...action, value })}
                    />
                  )}
                </div>
              </div>
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
