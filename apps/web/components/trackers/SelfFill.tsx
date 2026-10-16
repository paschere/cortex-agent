'use client';

import { formatCompactMoney, formatNumber, formatPercent } from '@/lib/datagrid/format';
import type { TrackerField } from '@/lib/trackers/schema-editor';
import { FORMULA_RESULT_TYPES, applyComputed } from '@cortex/agent-tools/src/trackers/computed';
import { FORMULA_FUNCTIONS, parseFormula } from '@cortex/agent-tools/src/trackers/formula';
import { clsx } from 'clsx';
import { Calculator, Link2, Sparkles } from 'lucide-react';
import { useRef, useState } from 'react';
import { Field, INPUT, Toggle } from '../views/editor/controls';

/**
 * «Se llena solo» en el editor de un campo: fórmula (con autocompletado de
 * campos y funciones, y vista previa con la primera fila), traer de otra tabla
 * (lookup) y llenar con Cortex (autofill). La validación de verdad es la del
 * servidor (`trackerFieldsSchema`); aquí sólo se ayuda a escribirlo.
 */

const NATIVE = 'rounded-sm border border-border-strong bg-surface px-2 py-1.5 text-sm text-ink';

type AutoCfg = NonNullable<TrackerField['autofill']>;
type Mode = 'manual' | 'formula' | 'lookup';
type Other = {
  slug: string;
  name: string;
  fields?: Array<{ key: string; label: string; type: string }>;
};

export function SelfFill({
  field,
  fields,
  otherTrackers,
  sample,
  readOnly,
  onChange,
}: {
  field: TrackerField;
  fields: TrackerField[];
  otherTrackers: Other[];
  sample: Record<string, string | number> | null;
  readOnly: boolean;
  onChange: (next: TrackerField) => void;
}) {
  const set = (patch: Partial<TrackerField>) => onChange({ ...field, ...patch });
  const mode: Mode = field.formula !== undefined ? 'formula' : field.lookup ? 'lookup' : 'manual';
  const relations = fields.filter((f) => f.type === 'relation' && f.key !== field.key);
  const others = fields.filter((f) => f.key !== field.key);

  const setMode = (next: Mode) => {
    if (next === mode) return;
    if (next === 'manual') set({ formula: undefined, lookup: undefined });
    else if (next === 'formula')
      set({
        formula: '',
        lookup: undefined,
        autofill: undefined,
        required: false,
        ...(FORMULA_RESULT_TYPES.includes(field.type as never) ? {} : { type: 'number' }),
      });
    else
      set({
        formula: undefined,
        lookup: { via: relations[0]?.key ?? '', field: '', editable: false },
        required: false,
      });
  };

  return (
    <div className="space-y-3 rounded-sm border border-border bg-surface-2/50 p-3">
      <Field
        label="¿Cómo se llena?"
        hint="A mano, calculado de otros campos, traído de otra tabla, o con ayuda de Cortex."
      >
        <select
          aria-label="Cómo se llena este campo"
          value={mode}
          disabled={readOnly}
          onChange={(e) => setMode(e.target.value as Mode)}
          className={clsx(NATIVE, 'w-full')}
        >
          <option value="manual">Lo escribe la persona</option>
          <option value="formula">Se calcula con una fórmula</option>
          <option value="lookup" disabled={relations.length === 0}>
            Se trae de otra tabla
            {relations.length === 0 ? ' (primero agrega un campo Relación)' : ''}
          </option>
        </select>
      </Field>

      {mode === 'formula' && (
        <FormulaEditor
          field={field}
          fields={fields}
          sample={sample}
          readOnly={readOnly}
          set={set}
        />
      )}

      {mode === 'lookup' && field.lookup && (
        <LookupEditor
          field={field}
          relations={relations}
          otherTrackers={otherTrackers}
          readOnly={readOnly}
          set={set}
        />
      )}

      {mode !== 'formula' && (
        <div className="space-y-2">
          <Toggle
            label="Cortex propone valores para otros campos"
            hint="Al llenar este campo, Cortex busca y propone los demás. Tú decides: nada pisa lo que ya escribiste."
            checked={Boolean(field.autofill)}
            disabled={readOnly || others.length === 0}
            onChange={(on) =>
              set({
                autofill: on
                  ? {
                      instruction: '',
                      from: [field.key],
                      fills: [],
                    }
                  : undefined,
              })
            }
          />
          {field.autofill && (
            <div className="space-y-2">
              <Field
                label="¿Qué debe hacer Cortex?"
                hint="Ej.: «Con el número de vuelo identifica la aerolínea y el próximo arribo»."
              >
                <textarea
                  rows={2}
                  maxLength={600}
                  value={field.autofill.instruction}
                  disabled={readOnly}
                  onChange={(e) =>
                    set({
                      autofill: { ...(field.autofill as AutoCfg), instruction: e.target.value },
                    })
                  }
                  className={clsx(INPUT, 'h-auto py-2')}
                />
              </Field>
              <FieldPicker
                label="Cortex empieza cuando estén llenos (además de este)"
                options={others}
                value={field.autofill.from.filter((k) => k !== field.key)}
                disabled={readOnly}
                onChange={(from) =>
                  set({ autofill: { ...(field.autofill as AutoCfg), from: [field.key, ...from] } })
                }
              />
              <FieldPicker
                label="Campos que Cortex propone"
                options={others.filter(
                  (f) =>
                    !f.formula &&
                    !(f.lookup && !f.lookup.editable) &&
                    !['file', 'relation', 'location'].includes(f.type) &&
                    !field.autofill?.from.includes(f.key),
                )}
                value={field.autofill.fills}
                disabled={readOnly}
                onChange={(fills) => set({ autofill: { ...(field.autofill as AutoCfg), fills } })}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FieldPicker({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: TrackerField[];
  value: string[];
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-semibold text-ink">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = value.includes(o.key);
          return (
            <button
              key={o.key}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChange(on ? value.filter((k) => k !== o.key) : [...value, o.key])}
              className={clsx(
                'rounded-pill border px-2.5 py-1 text-xs font-semibold transition-colors',
                on
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border-strong text-ink-muted hover:bg-surface-2',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

function LookupEditor({
  field,
  relations,
  otherTrackers,
  readOnly,
  set,
}: {
  field: TrackerField;
  relations: TrackerField[];
  otherTrackers: Other[];
  readOnly: boolean;
  set: (patch: Partial<TrackerField>) => void;
}) {
  const lookup = field.lookup as NonNullable<TrackerField['lookup']>;
  const via = relations.find((r) => r.key === lookup.via);
  const target = otherTrackers.find((t) => t.slug === via?.tracker);
  const update = (patch: Partial<typeof lookup>) => set({ lookup: { ...lookup, ...patch } });
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        <Link2 className="h-3.5 w-3.5" aria-hidden />
        Trae un dato de la fila que elijas en otro campo
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Al elegir…">
          <select
            aria-label="Campo de relación"
            value={lookup.via}
            disabled={readOnly}
            onChange={(e) => update({ via: e.target.value, field: '' })}
            className={clsx(NATIVE, 'w-full')}
          >
            {relations.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="traer el campo…">
          {target?.fields ? (
            <select
              aria-label="Campo que se trae"
              value={lookup.field}
              disabled={readOnly}
              onChange={(e) => update({ field: e.target.value })}
              className={clsx(NATIVE, 'w-full')}
            >
              <option value="">Elige…</option>
              {target.fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={lookup.field}
              placeholder="clave del campo en la otra tabla"
              disabled={readOnly}
              onChange={(e) => update({ field: e.target.value })}
              className={INPUT}
            />
          )}
        </Field>
      </div>
      <Toggle
        label="La persona puede cambiarlo"
        hint="Apagado, el dato siempre es el de la otra tabla y no se edita."
        checked={Boolean(lookup.editable)}
        disabled={readOnly}
        onChange={(editable) => update({ editable })}
      />
    </div>
  );
}

function FormulaEditor({
  field,
  fields,
  sample,
  readOnly,
  set,
}: {
  field: TrackerField;
  fields: TrackerField[];
  sample: Record<string, string | number> | null;
  readOnly: boolean;
  set: (patch: Partial<TrackerField>) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [caret, setCaret] = useState(0);
  const formula = field.formula ?? '';
  const parsed = formula.trim() ? parseFormula(formula) : null;

  // Autocompletado: lo que se lleva escrito de un campo «[Kil…» o de una función «dias_…».
  const before = formula.slice(0, caret);
  const open = before.lastIndexOf('[');
  const inRef = open >= 0 && !before.slice(open).includes(']');
  const word = /([\p{L}_]+)$/u.exec(before)?.[1] ?? '';
  const needle = (inRef ? before.slice(open + 1) : word).toLowerCase();
  const suggestions: Array<{ text: string; insert: string; hint: string }> = [];
  if (inRef || word.length >= 2) {
    for (const f of fields)
      if (f.key !== field.key && (f.label + f.key).toLowerCase().includes(needle))
        suggestions.push({
          text: f.label,
          insert: inRef ? `${f.label}]` : `[${f.label}]`,
          hint: 'campo',
        });
    if (!inRef)
      for (const fn of FORMULA_FUNCTIONS)
        if (fn.name.startsWith(needle) && needle)
          suggestions.push({ text: fn.usage, insert: `${fn.name}(`, hint: fn.help });
  }

  const insert = (text: string, replace: number) => {
    const el = ref.current;
    const at = el?.selectionStart ?? formula.length;
    const next = formula.slice(0, at - replace) + text + formula.slice(at);
    set({ formula: next });
    requestAnimationFrame(() => {
      el?.focus();
      const pos = at - replace + text.length;
      el?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };

  // Vista previa con la primera fila de la tabla.
  let preview: { text: string; warn: string | null; error: string | null } | null = null;
  if (parsed?.ok && sample) {
    const res = applyComputed(
      fields.map((f) => (f.key === field.key ? { ...f, formula } : f)),
      sample as Record<string, string | number>,
    );
    const raw = res.values[field.key];
    const text =
      raw === undefined
        ? '—'
        : field.type === 'money'
          ? formatCompactMoney(Number(raw))
          : field.type === 'number'
            ? field.percent
              ? formatPercent(Math.round(Number(raw) * 1e8) / 1e6)
              : formatNumber(Number(raw), 6)
            : field.type === 'checkbox'
              ? Number(raw) === 1
                ? 'Sí'
                : 'No'
              : String(raw);
    preview = {
      text,
      warn: res.warnings[field.key]?.[0] ?? null,
      error: res.errors[field.key] ?? null,
    };
  }

  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        <Calculator className="h-3.5 w-3.5" aria-hidden />
        Fórmula
      </p>
      <textarea
        ref={ref}
        rows={2}
        value={formula}
        maxLength={500}
        disabled={readOnly}
        spellCheck={false}
        aria-label="Fórmula"
        placeholder="Ej.: [Kilos] × [Tarifa]"
        onChange={(e) => {
          set({ formula: e.target.value });
          setCaret(e.target.selectionStart);
        }}
        onKeyUp={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        onClick={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart)}
        className={clsx(INPUT, 'h-auto py-2 font-mono text-xs')}
      />
      {suggestions.length > 0 && !readOnly && (
        <ul className="max-h-40 overflow-auto rounded-sm border border-border bg-surface">
          {suggestions.slice(0, 8).map((s) => (
            <li key={s.text + s.hint}>
              <button
                type="button"
                onClick={() => insert(s.insert, inRef ? needle.length : word.length)}
                className="flex w-full items-baseline justify-between gap-3 px-2 py-1 text-left text-xs hover:bg-surface-2"
              >
                <span className="font-mono text-ink">{s.text}</span>
                <span className="truncate text-ink-faint">{s.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-1">
        {fields
          .filter((f) => f.key !== field.key)
          .map((f) => (
            <button
              key={f.key}
              type="button"
              disabled={readOnly}
              onClick={() => insert(`[${f.label}]`, 0)}
              className="rounded-pill border border-border-strong px-2 py-0.5 text-micro font-semibold text-ink-muted hover:bg-surface-2"
            >
              [{f.label}]
            </button>
          ))}
      </div>
      {parsed && !parsed.ok && (
        <p role="alert" className="text-xs font-semibold text-rose">
          {parsed.message}
        </p>
      )}
      {parsed?.ok &&
        (() => {
          const missing = parsed.formula.refs.filter(
            (r) =>
              !fields.some(
                (f) =>
                  f.key === r ||
                  f.label.toLowerCase() === r.toLowerCase() ||
                  f.key.toLowerCase() === r.toLowerCase(),
              ),
          );
          return missing.length ? (
            <p role="alert" className="text-xs font-semibold text-rose">
              No existe el campo {missing.map((m) => `«${m}»`).join(', ')}.
            </p>
          ) : null;
        })()}
      {preview ? (
        <p aria-live="polite" className="text-xs text-ink-muted">
          Con la primera fila da:{' '}
          <strong className="text-ink">{preview.error ? 'vacío' : preview.text}</strong>
          {preview.error && <span className="text-rose"> — {preview.error}</span>}
          {preview.warn && <span className="text-amber"> — {preview.warn}</span>}
        </p>
      ) : (
        parsed?.ok && (
          <p className="text-xs text-ink-faint">Cuando haya filas verás aquí el resultado.</p>
        )
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <p className="text-xs text-ink-muted sm:col-span-2">
          El tipo del campo es el del resultado: número, plata, fecha, hora, texto o sí/no. Se
          calcula sola al guardar y no se escribe a mano.
        </p>
        {field.type === 'number' && (
          <Toggle
            label="Mostrar como porcentaje"
            hint="0,15 se ve «15 %»."
            checked={Boolean(field.percent)}
            disabled={readOnly}
            onChange={(percent) => set({ percent: percent || undefined })}
          />
        )}
      </div>
      <p className="flex items-center gap-1 text-micro text-ink-faint">
        <Sparkles className="hidden h-3 w-3" aria-hidden />
        Funciones:{' '}
        {FORMULA_FUNCTIONS.slice(0, 12)
          .map((f) => f.name)
          .join(', ')}
        … Separa con «;».
      </p>
    </div>
  );
}
