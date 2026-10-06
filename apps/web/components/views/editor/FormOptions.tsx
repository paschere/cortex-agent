'use client';

import { addFieldToTracker } from '@/components/trackers/schema-client';
import type { EditorSource } from '@/lib/views/editor-spec';
import {
  APPROVAL_STATES,
  addStep,
  approvalFieldCandidates,
  approvalStateField,
  askedKeys,
  assignField,
  guessApproval,
  moveKey,
  moveStep,
  notesCandidates,
  pruneSteps,
  removeStep,
  startSteps,
  unassigned,
} from '@/lib/views/form-options';
import type { ViewBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Loader2, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Field, INPUT, Section, Toggle } from './controls';

type FormBlock = Extract<ViewBlock, { type: 'form' }>;

const NATIVE = 'rounded-sm border border-border-strong bg-surface px-2 py-1.5 text-sm text-ink';
const DEFAULT_WINDOW = 10;

/**
 * LAS OPCIONES DE UN FORMULARIO que no son su texto: qué campos pide y en qué
 * orden, cuánto tiempo se puede corregir lo enviado, si pasa por aprobación y
 * si se llena por pasos. Todo se escribe en el spec del bloque; el contrato lo
 * revisa `checkSpecAgainst` (checkFormExtras) igual que si lo hubiera armado
 * Cortex, y la vista previa muestra los problemas.
 */
export function FormOptions({
  block,
  source,
  editing,
  onChange,
  onAllowEditing,
  onSchemaChanged,
}: {
  block: FormBlock;
  source: EditorSource | undefined;
  editing: 'off' | 'team' | 'public';
  onChange: (next: ViewBlock, coalesce?: string) => void;
  onAllowEditing: () => void;
  /** La tabla cambió (se creó un campo): recargar el catálogo del lienzo. */
  onSchemaChanged?: () => void;
}) {
  const tableFields = source?.fields ?? [];
  const label = (k: string) => tableFields.find((f) => f.key === k)?.label ?? k;
  const asked = askedKeys(block.fields, tableFields);
  const rest = tableFields.filter((f) => !asked.includes(f.key));
  const set = (patch: Partial<FormBlock>, coalesce?: string) =>
    onChange({ ...block, ...patch } as ViewBlock, coalesce);
  /** Cambiar qué se pide arrastra a los pasos: nada queda apuntando a un campo que ya no se pide. */
  const setAsked = (fields: string[]) =>
    set({
      fields,
      ...(block.steps
        ? { steps: pruneSteps(block.steps, fields.length ? fields : tableFields.map((f) => f.key)) }
        : {}),
    });
  const windowMinutes = block.editWindowMinutes ?? DEFAULT_WINDOW;
  // Una tabla que Cortex propuso y todavía no se crea no se puede modificar por el servidor.
  const canEditSource = Boolean(source && !source.readOnly && !source.name.endsWith('(nueva)'));

  return (
    <>
      <Section title="Campos del formulario">
        {block.fields.length === 0 ? (
          <div className="space-y-2">
            <p className="text-xs text-ink-muted">
              Pide todos los campos de la tabla, en su orden.
            </p>
            <button
              type="button"
              disabled={!canEditSource}
              onClick={() => set({ fields: tableFields.map((f) => f.key).slice(0, 20) })}
              className="rounded-pill border border-border-strong px-3 py-1 text-xs font-semibold text-ink-muted hover:text-ink disabled:opacity-40"
            >
              Elegir y ordenar los campos
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <ol className="space-y-1">
              {block.fields.map((k, i) => (
                <li
                  key={k}
                  className="flex items-center gap-1 rounded-sm border border-border bg-surface px-2 py-1 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{label(k)}</span>
                  <Mini
                    label="Subir"
                    disabled={i === 0}
                    onClick={() => setAsked(moveKey(block.fields, i, i - 1))}
                  >
                    <ArrowUp className="h-3 w-3" />
                  </Mini>
                  <Mini
                    label="Bajar"
                    disabled={i === block.fields.length - 1}
                    onClick={() => setAsked(moveKey(block.fields, i, i + 1))}
                  >
                    <ArrowDown className="h-3 w-3" />
                  </Mini>
                  <Mini
                    label={`Dejar de pedir «${label(k)}»`}
                    disabled={block.fields.length <= 1}
                    onClick={() => setAsked(block.fields.filter((x) => x !== k))}
                  >
                    <X className="h-3 w-3" />
                  </Mini>
                </li>
              ))}
            </ol>
            {rest.length > 0 && block.fields.length < 20 && (
              <div className="flex flex-wrap gap-1">
                {rest.map((f) => (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => setAsked([...block.fields, f.key])}
                    className="inline-flex items-center gap-1 rounded-pill border border-dashed border-border-strong px-2 py-0.5 text-xs text-ink-muted hover:text-ink"
                  >
                    <Plus className="h-3 w-3" /> {f.label}
                  </button>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() =>
                set({
                  fields: [],
                  ...(block.steps
                    ? {
                        steps: pruneSteps(
                          block.steps,
                          tableFields.map((f) => f.key),
                        ),
                      }
                    : {}),
                })
              }
              className="text-micro font-semibold text-primary"
            >
              Pedir todos otra vez
            </button>
          </div>
        )}
      </Section>

      <Section title="Después de enviar">
        <Toggle
          label="Se puede corregir después de enviar"
          hint="Quien envía ve «Corregir» durante unos minutos."
          checked={windowMinutes > 0}
          onChange={(on) => set({ editWindowMinutes: on ? DEFAULT_WINDOW : 0 })}
        />
        {windowMinutes > 0 && (
          <Field label="Minutos para corregir" hint="De 1 a 1440 (un día). Sin tocar son 10.">
            <input
              type="number"
              min={1}
              max={1440}
              value={windowMinutes}
              onChange={(e) =>
                set(
                  {
                    editWindowMinutes: Math.max(
                      1,
                      Math.min(1440, Math.round(Number(e.target.value)) || 1),
                    ),
                  },
                  `${block.id}:window`,
                )
              }
              className={INPUT}
            />
          </Field>
        )}
      </Section>

      <ApprovalSection
        block={block}
        source={source}
        editing={editing}
        canEditSource={canEditSource}
        set={set}
        onAllowEditing={onAllowEditing}
        onSchemaChanged={onSchemaChanged}
      />

      <Section title="Formulario por pasos">
        <Toggle
          label="Dividir en pasos"
          hint="Barra de progreso, Siguiente y Atrás; cada paso se revisa antes de seguir."
          checked={Boolean(block.steps?.length)}
          onChange={(on) => set({ steps: on ? startSteps(asked) : undefined })}
        />
        {block.steps && block.steps.length > 0 && (
          <StepsEditor
            steps={block.steps}
            asked={asked}
            label={label}
            onChange={(steps) => set({ steps: steps.length ? steps : undefined })}
          />
        )}
      </Section>
    </>
  );
}

function Mini({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid h-6 w-6 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink disabled:opacity-30"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Aprobación
// ---------------------------------------------------------------------------

function ApprovalSection({
  block,
  source,
  editing,
  canEditSource,
  set,
  onAllowEditing,
  onSchemaChanged,
}: {
  block: FormBlock;
  source: EditorSource | undefined;
  editing: 'off' | 'team' | 'public';
  canEditSource: boolean;
  set: (patch: Partial<FormBlock>, coalesce?: string) => void;
  onAllowEditing: () => void;
  onSchemaChanged?: () => void;
}) {
  const fields = source?.fields ?? [];
  const candidates = approvalFieldCandidates(fields);
  const notes = notesCandidates(fields);
  const a = block.approval;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = a ? fields.find((f) => f.key === a.field) : undefined;

  function enable(fieldKey: string) {
    const f = fields.find((x) => x.key === fieldKey);
    const guess = f ? guessApproval(f) : null;
    if (!guess) return;
    set({ approval: { field: fieldKey, ...guess } });
    // Aprobar y rechazar son escrituras sobre la tabla: el espacio tiene que dejar escribir.
    if (editing === 'off') onAllowEditing();
  }

  async function createStateField() {
    if (!source) return;
    setBusy(true);
    setError(null);
    const field = approvalStateField(fields.map((f) => f.key));
    const r = await addFieldToTracker(source.slug, field);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    // La tabla ya tiene el campo; el catálogo se recarga y el bloque lo usa.
    set({
      approval: {
        field: field.key,
        pending: APPROVAL_STATES.pending,
        approved: APPROVAL_STATES.approved,
        rejected: APPROVAL_STATES.rejected,
      },
    });
    if (editing === 'off') onAllowEditing();
    onSchemaChanged?.();
  }

  return (
    <Section title="Aprobación">
      <Toggle
        label="Requiere aprobación"
        hint="Los envíos nacen «por revisar»; quien puede escribir ve Aprobar y Rechazar en las tablas y tarjetas de la vista."
        checked={Boolean(a)}
        disabled={!canEditSource}
        onChange={(on) => {
          if (!on) return set({ approval: undefined });
          const first = candidates[0];
          if (first) enable(first.key);
          else void createStateField();
        }}
      />
      {a && (
        <div className="space-y-3 rounded-sm border border-border bg-surface-2/40 p-3">
          <Field label="Campo de estado">
            <select
              value={a.field}
              onChange={(e) => enable(e.target.value)}
              className={clsx(NATIVE, 'w-full')}
            >
              {!candidates.some((c) => c.key === a.field) && (
                <option value={a.field}>{a.field}</option>
              )}
              {candidates.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          {(['pending', 'approved', 'rejected'] as const).map((role) => (
            <Field
              key={role}
              label={
                role === 'pending'
                  ? 'Valor al enviar (por revisar)'
                  : role === 'approved'
                    ? 'Valor al aprobar'
                    : 'Valor al rechazar'
              }
            >
              <select
                value={a[role]}
                onChange={(e) => set({ approval: { ...a, [role]: e.target.value } })}
                className={clsx(NATIVE, 'w-full')}
              >
                {!(current?.options ?? []).includes(a[role]) && (
                  <option value={a[role]}>{a[role]}</option>
                )}
                {(current?.options ?? []).map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          {new Set([a.pending, a.approved, a.rejected]).size < 3 && (
            <p className="text-xs text-rose">Los tres valores tienen que ser distintos.</p>
          )}
          <Field label="Guardar el motivo en (opcional)" hint="Un campo de texto de la tabla.">
            <select
              value={a.notesField ?? ''}
              onChange={(e) => set({ approval: { ...a, notesField: e.target.value || undefined } })}
              className={clsx(NATIVE, 'w-full')}
            >
              <option value="">No guardar motivo</option>
              {notes.map((n) => (
                <option key={n.key} value={n.key}>
                  {n.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      {!a && candidates.length === 0 && canEditSource && (
        <div className="space-y-1">
          <p className="text-xs text-ink-muted">
            La tabla no tiene un campo de opciones con tres estados. Se puede crear uno «Estado» con
            Por revisar, Aprobado y Rechazado.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={createStateField}
            className="inline-flex items-center gap-1.5 rounded-pill border border-primary/50 bg-primary-soft px-3 py-1 text-xs font-semibold text-primary disabled:opacity-50"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Crear el campo «Estado» y activar
          </button>
        </div>
      )}
      {error && <p className="text-xs text-rose">{error}</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Pasos
// ---------------------------------------------------------------------------

function StepsEditor({
  steps,
  asked,
  label,
  onChange,
}: {
  steps: Array<{ title: string; fields: string[] }>;
  asked: string[];
  label: (key: string) => string;
  onChange: (next: Array<{ title: string; fields: string[] }>) => void;
}) {
  const loose = unassigned(steps, asked);
  return (
    <div className="space-y-3">
      {steps.map((s, i) => (
        <div
          key={`${i}-${s.fields.join('|')}`}
          className="space-y-2 rounded-sm border border-border bg-surface-2/40 p-2"
        >
          <div className="flex items-center gap-1">
            <input
              aria-label={`Título del paso ${i + 1}`}
              value={s.title}
              maxLength={60}
              onChange={(e) =>
                onChange(steps.map((x, k) => (k === i ? { ...x, title: e.target.value } : x)))
              }
              className={clsx(INPUT, 'py-1')}
            />
            <Mini
              label="Paso antes"
              disabled={i === 0}
              onClick={() => onChange(moveStep(steps, i, i - 1))}
            >
              <ArrowUp className="h-3 w-3" />
            </Mini>
            <Mini
              label="Paso después"
              disabled={i === steps.length - 1}
              onClick={() => onChange(moveStep(steps, i, i + 1))}
            >
              <ArrowDown className="h-3 w-3" />
            </Mini>
            <Mini label={`Quitar el paso ${i + 1}`} onClick={() => onChange(removeStep(steps, i))}>
              <X className="h-3 w-3" />
            </Mini>
          </div>
          <ul className="space-y-1">
            {s.fields.map((k, j) => (
              <li
                key={k}
                className="flex items-center gap-1 rounded-sm bg-surface px-2 py-1 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{label(k)}</span>
                <Mini
                  label="Subir en el paso"
                  disabled={j === 0}
                  onClick={() =>
                    onChange(
                      steps.map((x, n) =>
                        n === i ? { ...x, fields: moveKey(x.fields, j, j - 1) } : x,
                      ),
                    )
                  }
                >
                  <ArrowUp className="h-3 w-3" />
                </Mini>
                <Mini
                  label="Bajar en el paso"
                  disabled={j === s.fields.length - 1}
                  onClick={() =>
                    onChange(
                      steps.map((x, n) =>
                        n === i ? { ...x, fields: moveKey(x.fields, j, j + 1) } : x,
                      ),
                    )
                  }
                >
                  <ArrowDown className="h-3 w-3" />
                </Mini>
                <select
                  aria-label={`Mover «${label(k)}» a otro paso`}
                  value={i}
                  onChange={(e) => {
                    const v = e.target.value;
                    onChange(
                      v === 'new'
                        ? addStep(steps, k)
                        : v === 'none'
                          ? assignField(steps, k, null)
                          : assignField(steps, k, Number(v)),
                    );
                  }}
                  className="rounded-sm border border-border bg-surface px-1 py-0.5 text-micro"
                >
                  {steps.map((st, n) => (
                    <option key={`${n}-${st.title}`} value={n}>
                      {n === i ? 'En ' : 'Mover a '}paso {n + 1}
                    </option>
                  ))}
                  {steps.length < 10 && <option value="new">Nuevo paso con este</option>}
                  <option value="none">Sin paso</option>
                </select>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {loose.length > 0 && (
        <div className="rounded-sm border border-dashed border-border-strong p-2">
          <p className="mb-1 text-micro text-ink-muted">
            Sin paso (se piden al final, en «Otros datos»):
          </p>
          <div className="flex flex-wrap gap-1">
            {loose.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => onChange(assignField(steps, k, steps.length - 1))}
                className="inline-flex items-center gap-1 rounded-pill border border-border px-2 py-0.5 text-xs text-ink-muted hover:text-ink"
                title={`Agregar «${label(k)}» al último paso`}
              >
                <Plus className="h-3 w-3" /> {label(k)}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
