'use client';

import { Input } from '@/components/ui/input';
import {
  ACTION_LABEL,
  MODULE,
  type ProposedStep,
  TARGET_LABEL,
  TARGET_WHY,
} from '@/lib/browser-shape';
import {
  type ProposedVariable,
  canBeOptional,
  canMoveDown,
  canMoveUp,
  canRemove,
  checkSteps,
  hole,
  holesIn,
  isAnchor,
  markStepAsFixed,
  markStepAsVariable,
  moveStep,
  pruneVariables,
  removeStep,
  renameStep,
  setStepLiteral,
  setStepOptional,
  setStepTemplate,
  variableNameFrom,
  whyPinned,
} from '@/lib/browser-steps';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, KeyRound, Trash2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

/**
 * Los pasos que el modelo entendió, para corregirlos antes de guardar.
 *
 * ---------------------------------------------------------------------------
 * WHAT A PERSON ACTUALLY DOES AFTER A RECORDING
 * ---------------------------------------------------------------------------
 * Four things, in this order of frequency: throw away a step that is not a step
 * (the cookie banner, a click that landed on nothing, the same thing twice),
 * fix the order, rewrite a name a machine wrote, and say which typed value is
 * the datum that changes. This screen does those four and deliberately nothing
 * else — it does not let anybody invent a step, retype a selector or change an
 * action, because none of that can be verified from a recording that no longer
 * exists, and a hand-written locator that fails is a worse failure than a
 * misread one: nobody knows whether the portal changed or the guess was wrong.
 *
 * ---------------------------------------------------------------------------
 * SUBIR Y BAJAR, NO ARRASTRAR
 * ---------------------------------------------------------------------------
 * Two buttons per row. Drag and drop needs a pointer, a library and a keyboard
 * story that almost nobody writes; two buttons work with a finger, with a
 * screen reader and on the phone somebody is holding while standing at a
 * counter. The one thing they owe back is FOCUS: press «subir» and the button
 * you pressed has to arrive with you at the new position, or the second press
 * moves a different step. That is what `pendingFocus` is for.
 *
 * ---------------------------------------------------------------------------
 * EL ARRANQUE NO SE TOCA
 * ---------------------------------------------------------------------------
 * A `goto` in first position is where the errand starts, its address comes from
 * «Empieza en» above, and the replay engine never navigates on its own. So its
 * arrows are off, its bin is off and it has no «opcional» switch — each with the
 * reason attached rather than a greyed-out control that looks broken. The rules
 * themselves are in `lib/browser-steps.ts`, which the POST route checks too.
 */

/** Lo que se está editando: los pasos, los datos que declaran y los valores de prueba. */
export interface StepDraft {
  steps: ProposedStep[];
  variables: ProposedVariable[];
  sample: Record<string, string>;
}

/** Acciones que escriben algo. El resto no tiene nada que volver variable. */
const TYPES_SOMETHING = new Set<ProposedStep['action']>(['fill', 'select', 'press']);

const FIXED = '__fijo__';
const NEW = '__nuevo__';
const MIXED = '__combinado__';

export function StepEditor({
  value,
  onChange,
}: {
  value: StepDraft;
  onChange: (next: StepDraft) => void;
}) {
  const { steps, variables, sample } = value;
  const [creatingAt, setCreatingAt] = useState<number | null>(null);
  const [draftLabel, setDraftLabel] = useState('');

  // Where the keyboard should land after the list reorders itself. Set by the
  // handler, spent by the effect that runs on the render it caused.
  const pendingFocus = useRef<string | null>(null);
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    pendingFocus.current = null;
    document.getElementById(id)?.focus();
  });

  const problems = checkSteps(steps, variables);
  const general = problems.filter((p) => p.index === null);

  const move = (index: number, direction: 'up' | 'down') => {
    const next = moveStep(steps, index, direction);
    if (next === steps) return;
    const landed = direction === 'up' ? index - 1 : index + 1;
    pendingFocus.current = buttonId(landed, direction);
    setCreatingAt(null);
    onChange({ ...value, steps: next });
  };

  const drop = (index: number) => {
    const next = removeStep(steps, index);
    if (next === steps) return;
    setCreatingAt(null);
    // The variables a deleted step was the only user of stop being asked for.
    onChange({ ...value, steps: next, variables: pruneVariables(variables, next) });
  };

  const createVariable = (index: number) => {
    const label = draftLabel.trim();
    if (!label) return;
    const name = variableNameFrom(
      label,
      variables.map((v) => v.name),
    );
    onChange(markStepAsVariable({ steps, variables, sample }, index, { name, label }));
    setCreatingAt(null);
    setDraftLabel('');
  };

  return (
    <div>
      <ol className="space-y-2">
        {steps.map((step, index) => {
          const rowProblems = problems.filter((p) => p.index === index);
          const anchor = isAnchor(steps, index);
          return (
            <li
              // The steps carry no identity of their own, so position is the
              // key. Everything inside is controlled, and the focus handling
              // above is what keeps reordering usable from the keyboard.
              // biome-ignore lint/suspicious/noArrayIndexKey: a step list has no id
              key={index}
              className={clsx(
                'rounded-sm border px-3 py-2.5',
                rowProblems.length > 0
                  ? 'border-rose/30 bg-rose-soft/30'
                  : 'border-border bg-surface-2/50',
              )}
            >
              <div className="flex items-start gap-2">
                <span className="tabular mt-2.5 w-5 shrink-0 text-micro font-semibold text-ink-faint">
                  {String(index + 1).padStart(2, '0')}
                </span>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={chipClass(anchor ? 'primary' : 'neutral')}>
                      {ACTION_LABEL[step.action]}
                    </span>
                    <Input
                      id={`paso-${index}-nombre`}
                      className="min-w-[180px] flex-1"
                      value={step.label}
                      maxLength={200}
                      aria-label={`Nombre del paso ${index + 1}`}
                      placeholder="Qué hace este paso"
                      onChange={(e) =>
                        onChange({ ...value, steps: renameStep(steps, index, e.target.value) })
                      }
                    />
                  </div>

                  <ValueField
                    step={step}
                    index={index}
                    variables={variables}
                    sample={sample}
                    creating={creatingAt === index}
                    draftLabel={draftLabel}
                    onDraftLabel={setDraftLabel}
                    onCreate={() => createVariable(index)}
                    onCancelCreate={() => {
                      setCreatingAt(null);
                      setDraftLabel('');
                    }}
                    onStartCreate={() => {
                      setCreatingAt(index);
                      setDraftLabel('');
                    }}
                    onPick={(name) => {
                      const picked = variables.find((v) => v.name === name);
                      onChange(
                        markStepAsVariable({ steps, variables, sample }, index, {
                          name,
                          label: picked?.label ?? name,
                        }),
                      );
                    }}
                    onFixed={() => onChange(markStepAsFixed({ steps, variables, sample }, index))}
                    onText={(text) =>
                      onChange({
                        ...value,
                        steps:
                          step.value?.kind === 'template'
                            ? setStepTemplate(steps, index, text)
                            : setStepLiteral(steps, index, text),
                      })
                    }
                  />

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    {canBeOptional(steps, index) ? (
                      <button
                        type="button"
                        aria-pressed={Boolean(step.optional)}
                        onClick={() =>
                          onChange({
                            ...value,
                            steps: setStepOptional(steps, index, !step.optional),
                          })
                        }
                        className={clsx(
                          'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-[3px] text-micro font-semibold transition-colors duration-150',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none',
                          step.optional
                            ? 'border-amber/20 bg-amber-soft text-amber'
                            : 'border-border bg-surface text-ink-faint hover:text-ink',
                        )}
                      >
                        <span
                          className={clsx(
                            'h-2 w-2 rounded-full',
                            step.optional ? 'bg-amber' : 'bg-ink-faint/40',
                          )}
                          aria-hidden="true"
                        />
                        A veces no aparece
                      </button>
                    ) : (
                      <span className="text-micro text-ink-faint">El arranque corre siempre.</span>
                    )}
                    {step.optional && (
                      <span className="text-micro text-ink-muted">
                        Si no lo encuentro, sigo con el siguiente en vez de fallar.
                      </span>
                    )}
                  </div>

                  {step.targets.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {step.targets.map((t, i) => (
                        <span
                          key={`${t.kind}-${t.value}-${i}`}
                          title={TARGET_WHY[t.kind]}
                          className={clsx(
                            'rounded-pill border px-2 py-[2px] font-mono text-micro',
                            i === 0
                              ? 'border-primary/20 bg-primary-soft text-primary-ink'
                              : 'border-border bg-surface text-ink-faint',
                          )}
                        >
                          {TARGET_LABEL[t.kind]}: {t.name ?? t.value}
                        </span>
                      ))}
                    </div>
                  )}

                  {anchor && (
                    <p className="mt-2 text-micro leading-snug text-ink-faint">
                      Abre el sitio y va siempre de primero. La dirección se toma de «Empieza en»,
                      arriba.
                    </p>
                  )}

                  {rowProblems.map((problem) => (
                    <p
                      key={problem.message}
                      className="mt-1.5 text-xs leading-snug text-rose"
                      role="alert"
                    >
                      {problem.message}
                    </p>
                  ))}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <RowButton
                    id={buttonId(index, 'up')}
                    label={`Subir el paso ${index + 1}`}
                    disabled={!canMoveUp(steps, index)}
                    why={whyPinned(steps, index, 'up')}
                    onClick={() => move(index, 'up')}
                  >
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  </RowButton>
                  <RowButton
                    id={buttonId(index, 'down')}
                    label={`Bajar el paso ${index + 1}`}
                    disabled={!canMoveDown(steps, index)}
                    why={whyPinned(steps, index, 'down')}
                    onClick={() => move(index, 'down')}
                  >
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
                  </RowButton>
                  <RowButton
                    label={`Quitar el paso ${index + 1}`}
                    disabled={!canRemove(steps, index)}
                    why={
                      anchor
                        ? 'Este paso abre el sitio: sin él no hay por dónde empezar.'
                        : 'Un trámite necesita al menos un paso.'
                    }
                    danger
                    onClick={() => drop(index)}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </RowButton>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {general.length > 0 && (
        <ul className="mt-3 space-y-1">
          {general.map((problem) => (
            <li key={problem.message} className="text-xs leading-snug text-rose" role="alert">
              {problem.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function buttonId(index: number, direction: 'up' | 'down'): string {
  return `paso-${index}-${direction === 'up' ? 'subir' : 'bajar'}`;
}

/**
 * Qué escribe el paso: siempre lo mismo, o el dato que cambia en cada corrida.
 *
 * The mechanism underneath is the one that already exists — `kind: 'template'`
 * with `{{holes}}`, rendered by the replay engine — and the picker is a way of
 * writing one hole without typing braces. The raw text stays editable below it
 * because a real errand sometimes needs `{{mes}}/2026`, and a control that made
 * that unexpressible would send people back to re-recording.
 *
 * A `secret` is not editable at all, in either direction. Turning it into typed
 * text would be a way to write a password into a flow that is stored, versioned
 * and shown on a screen; turning something else into a secret would claim a
 * credential field that may not exist. Credentials are bound as credentials.
 */
function ValueField({
  step,
  index,
  variables,
  sample,
  creating,
  draftLabel,
  onDraftLabel,
  onCreate,
  onCancelCreate,
  onStartCreate,
  onPick,
  onFixed,
  onText,
}: {
  step: ProposedStep;
  index: number;
  variables: ProposedVariable[];
  sample: Record<string, string>;
  creating: boolean;
  draftLabel: string;
  onDraftLabel: (next: string) => void;
  onCreate: () => void;
  onCancelCreate: () => void;
  onStartCreate: () => void;
  onPick: (name: string) => void;
  onFixed: () => void;
  onText: (text: string) => void;
}) {
  if (step.value?.kind === 'secret') {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className={chipClass('amber')}>
          <KeyRound className="h-3 w-3" aria-hidden="true" />
          clave guardada
        </span>
        <span className="text-micro text-ink-muted">
          Se toma del campo «{step.value.field}» de la credencial vinculada. No queda escrita en el{' '}
          {MODULE.one}.
        </span>
      </div>
    );
  }

  if (!step.value && !TYPES_SOMETHING.has(step.action)) return null;

  const template = step.value?.kind === 'template' ? step.value.text : '';
  const holes = template ? holesIn(step) : [];
  const first = holes[0];
  // The picker can only say «this field is that datum» when the value is
  // exactly one hole. `{{mes}}/2026` is a legitimate template and is named as
  // what it is instead of being silently reduced to `{{mes}}`.
  const onlyHole = holes.length === 1 && first && template.trim() === hole(first) ? first : null;
  const selected = step.value?.kind === 'template' ? (onlyHole ?? MIXED) : FIXED;
  const text = step.value?.kind === 'literal' ? step.value.text : template;
  const selectId = `paso-${index}-dato`;

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className="field-label" htmlFor={selectId}>
          Qué escribe
        </label>
        <select
          id={selectId}
          // While the new datum is being named the picker stays on «Un dato
          // nuevo…»: snapping back to «Siempre lo mismo» under an open naming
          // box reads as the choice having been rejected.
          value={creating ? NEW : selected}
          onChange={(e) => {
            const picked = e.target.value;
            if (picked === FIXED) onFixed();
            else if (picked === NEW) onStartCreate();
            else if (picked !== MIXED) onPick(picked);
          }}
          className="rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-xs text-ink transition-colors focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
        >
          <option value={FIXED}>Siempre lo mismo</option>
          {variables.map((variable) => (
            <option key={variable.name} value={variable.name}>
              El dato «{variable.label}»
            </option>
          ))}
          <option value={NEW}>Un dato nuevo…</option>
          {selected === MIXED && <option value={MIXED}>Texto con datos adentro</option>}
        </select>
        <Input
          className={clsx(
            'min-w-[140px] max-w-[280px] flex-1',
            step.value?.kind === 'template' && 'font-mono text-xs text-primary',
          )}
          value={text}
          maxLength={4000}
          aria-label={`Texto que escribe el paso ${index + 1}`}
          placeholder={step.value?.kind === 'template' ? '{{placa}}' : 'lo que se escribió'}
          onChange={(e) => onText(e.target.value)}
        />
      </div>

      {creating && (
        <div className="mt-2 flex flex-wrap items-end gap-2 rounded-sm border border-primary/20 bg-primary-soft px-3 py-2.5">
          <div className="min-w-[200px] flex-1">
            <label className="field-label" htmlFor={`paso-${index}-nuevo-dato`}>
              ¿Cómo se llama este dato?
            </label>
            <Input
              id={`paso-${index}-nuevo-dato`}
              className="mt-1"
              value={draftLabel}
              maxLength={120}
              placeholder="Placa del vehículo"
              onChange={(e) => onDraftLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  onCreate();
                }
              }}
            />
          </div>
          <button
            type="button"
            onClick={onCreate}
            disabled={draftLabel.trim().length === 0}
            className="rounded-pill bg-primary px-3.5 py-1.5 text-xs font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transform-none motion-reduce:transition-none"
          >
            Marcarlo como dato
          </button>
          <button
            type="button"
            onClick={onCancelCreate}
            className="rounded-pill px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            Cancelar
          </button>
          <p className="basis-full text-micro leading-snug text-ink-faint">
            Lo que escribiste al grabar queda como el valor de la prueba, y en cada corrida se
            reemplaza por el que te pidan.
          </p>
        </div>
      )}

      {selected !== FIXED && !creating && (
        <p className="mt-1 text-micro leading-snug text-ink-faint">
          {selected === MIXED
            ? 'Mezcla texto fijo con {{huecos}}. Cada hueco tiene que ser uno de los datos declarados arriba.'
            : `En la prueba escribo «${sample[selected] || 'lo que pongas arriba'}».`}
        </p>
      )}
    </div>
  );
}

function RowButton({
  id,
  label,
  why,
  disabled,
  danger,
  onClick,
  children,
}: {
  id?: string;
  label: string;
  /** Por qué está apagado. Va en el `title`, para que no sea un botón muerto. */
  why?: string | null;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      id={id}
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={disabled ? (why ?? label) : label}
      className={clsx(
        'inline-flex h-7 w-7 items-center justify-center rounded-sm border transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none',
        'disabled:cursor-not-allowed disabled:opacity-35',
        danger
          ? 'border-border bg-surface text-ink-faint hover:enabled:border-rose/30 hover:enabled:bg-rose-soft hover:enabled:text-rose'
          : 'border-border bg-surface text-ink-muted hover:enabled:bg-surface-2 hover:enabled:text-ink',
      )}
    >
      {children}
    </button>
  );
}
