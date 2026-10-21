'use client';

import { formatCompactMoney, formatNumber, formatPercent } from '@/lib/datagrid/format';
import type { TrackerField } from '@/lib/trackers/schema-editor';
import { FORMULA_RESULT_TYPES, applyComputed } from '@cortex/agent-tools/src/trackers/computed';
import { FORMULA_FUNCTIONS, parseFormula } from '@cortex/agent-tools/src/trackers/formula';
import { REFERENCE_LISTS } from '@cortex/agent-tools/src/reference-lists';
import Link from 'next/link';
import { clsx } from 'clsx';
import { Calculator, Link2, SearchCheck, Sparkles, Workflow } from 'lucide-react';
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
type MatchCfg = NonNullable<TrackerField['match']>;
type Mode = 'manual' | 'match' | 'formula' | 'lookup' | 'rule' | 'cortex';
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
  const [ruleHint, setRuleHint] = useState(false);
  const mode: Mode = ruleHint
    ? 'rule'
    : field.formula !== undefined
      ? 'formula'
      : field.lookup
        ? 'lookup'
        : field.match
          ? 'match'
          : field.autofill
            ? 'cortex'
            : 'manual';
  const relations = fields.filter((f) => f.type === 'relation' && f.key !== field.key);
  const others = fields.filter((f) => f.key !== field.key);

  const setMode = (next: Mode) => {
    if (next === mode) return;
    setRuleHint(next === 'rule');
    if (next === 'rule') return;
    if (next === 'manual')
      set({ formula: undefined, lookup: undefined, match: undefined, autofill: undefined });
    else if (next === 'formula')
      set({
        formula: '',
        lookup: undefined,
        autofill: undefined,
        match: undefined,
        required: false,
        ...(FORMULA_RESULT_TYPES.includes(field.type as never) ? {} : { type: 'number' }),
      });
    else if (next === 'lookup')
      set({
        formula: undefined,
        match: undefined,
        autofill: undefined,
        lookup: { via: relations[0]?.key ?? '', field: '', editable: false },
        required: false,
      });
    else if (next === 'match')
      set({
        formula: undefined,
        lookup: undefined,
        match: {
          from: field.key,
          extract: { mode: 'full' },
          source: [...REFERENCE_LISTS.keys()][0] ?? 'cortex.aerolineas',
          key: 'codigo',
          fills: {},
        },
      });
    else
      set({
        formula: undefined,
        lookup: undefined,
        match: undefined,
        autofill: { instruction: '', from: [field.key], fills: [] },
      });
  };

  return (
    <div className="space-y-3 rounded-sm border border-border bg-surface-2/50 p-3">
      <Field
        label="¿Cómo se llena?"
        hint="De lo más rápido y seguro a lo más flexible: lista, fórmula, otra tabla, regla o Cortex (IA)."
      >
        <select
          aria-label="Cómo se llena este campo"
          value={mode}
          disabled={readOnly}
          onChange={(e) => setMode(e.target.value as Mode)}
          className={clsx(NATIVE, 'w-full')}
        >
          <option value="manual">A mano — lo escribe la persona</option>
          <option value="match" disabled={others.length === 0}>
            Buscar en una lista — sin IA, al instante
          </option>
          <option value="formula">Fórmula — se calcula de otros campos</option>
          <option value="lookup" disabled={relations.length === 0}>
            Traer de otra tabla
            {relations.length === 0 ? ' (primero agrega un campo Relación)' : ''}
          </option>
          <option value="rule">Regla — la pone una automatización</option>
          <option value="cortex" disabled={others.length === 0}>
            Con Cortex (IA) — busca y propone
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

      {mode === 'match' && field.match && (
        <MatchEditor
          field={field}
          others={others}
          otherTrackers={otherTrackers}
          readOnly={readOnly}
          set={set}
        />
      )}

      {mode === 'rule' && (
        <p className="flex items-start gap-1.5 text-xs text-ink-muted">
          <Workflow className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Una automatización de la aplicación puede escribir este campo cuando pasa algo («al
            crear un vuelo, poner…»). Se arma en la pestaña Automatizaciones de la app, o pídeselo a
            Cortex en el chat.{' '}
            <Link href="/apps" className="font-semibold text-primary hover:underline">
              Ir a mis aplicaciones
            </Link>
          </span>
        </p>
      )}

      {(mode === 'cortex' || (mode === 'match' && field.match)) && (
        <CortexEditor field={field} others={others} readOnly={readOnly} set={set} withList={mode === 'match'} />
      )}
    </div>
  );
}

/** «Cortex propone valores»: solo (modo Cortex) o como respaldo de la lista. */
function CortexEditor({
  field,
  others,
  readOnly,
  set,
  withList,
}: {
  field: TrackerField;
  others: TrackerField[];
  readOnly: boolean;
  set: (patch: Partial<TrackerField>) => void;
  withList: boolean;
}) {
  return (
    <div className="space-y-2">
      {withList ? (
        <Toggle
          label="Si no la encuentra, que Cortex la busque"
          hint="Respaldo con IA (web y otras tablas): sólo corre cuando la lista no tiene el dato."
          checked={Boolean(field.autofill)}
          disabled={readOnly || others.length === 0}
          onChange={(on) =>
            set({
              autofill: on
                ? {
                    instruction: '',
                    from: [field.key],
                    fills: Object.keys(field.match?.fills ?? {}),
                  }
                : undefined,
            })
          }
        />
      ) : (
        <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
          <Sparkles className="h-3.5 w-3.5" aria-hidden />
          Al llenar este campo, Cortex busca y propone los demás
        </p>
      )}
      {field.autofill && (
        <div className="space-y-2">
          <Field
            label="¿Qué debe hacer Cortex?"
            hint="Ej.: «Con el número de vuelo identifica la aerolínea y el próximo arribo». Si el dato es una equivalencia fija (código → nombre), usa «Buscar en una lista»: es más rápido y barato."
          >
            <textarea
              rows={2}
              maxLength={600}
              value={field.autofill.instruction}
              disabled={readOnly}
              onChange={(e) =>
                set({ autofill: { ...(field.autofill as AutoCfg), instruction: e.target.value } })
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
          {withList && (
            <Field label="Cuando la lista sí encuentra">
              <select
                aria-label="Qué hace Cortex si la lista encuentra"
                value={field.autofill.when ?? 'no_match'}
                disabled={readOnly}
                onChange={(e) =>
                  set({
                    autofill: {
                      ...(field.autofill as AutoCfg),
                      when: e.target.value === 'rest' ? 'rest' : undefined,
                    },
                  })
                }
                className={clsx(NATIVE, 'w-full')}
              >
                <option value="no_match">Cortex no hace nada</option>
                <option value="rest">Cortex completa los campos que la lista no llenó</option>
              </select>
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

/** «Buscar en una lista»: fuente, columna clave, cómo sacar la clave y qué campos llena. */
function MatchEditor({
  field,
  others,
  otherTrackers,
  readOnly,
  set,
}: {
  field: TrackerField;
  others: TrackerField[];
  otherTrackers: Other[];
  readOnly: boolean;
  set: (patch: Partial<TrackerField>) => void;
}) {
  const match = field.match as MatchCfg;
  const update = (patch: Partial<MatchCfg>) => set({ match: { ...match, ...patch } });
  const list = REFERENCE_LISTS.get(match.source);
  const tracker = otherTrackers.find((t) => t.slug === match.source);
  const columns: Array<{ key: string; label: string }> = list
    ? list.columns
    : (tracker?.fields ?? []).map((f) => ({ key: f.key, label: f.label }));
  const extract = match.extract ?? { mode: 'full' as const };
  const fillable = others.filter(
    (f) =>
      !f.formula &&
      !(f.lookup && !f.lookup.editable) &&
      !['file', 'relation', 'location'].includes(f.type),
  );
  const setSource = (source: string) => {
    const l = REFERENCE_LISTS.get(source);
    update({ source, key: l?.keyColumn ?? '', fills: {} });
  };
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
        <SearchCheck className="h-3.5 w-3.5" aria-hidden />
        Al llenar «{field.label}», buscarlo en una lista y llenar otros campos
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Lista donde se busca">
          <select
            aria-label="Lista de referencia"
            value={match.source}
            disabled={readOnly}
            onChange={(e) => setSource(e.target.value)}
            className={clsx(NATIVE, 'w-full')}
          >
            <optgroup label="Listas de Cortex">
              {[...REFERENCE_LISTS.values()].map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </optgroup>
            {otherTrackers.length > 0 && (
              <optgroup label="Tablas de este espacio">
                {otherTrackers.map((t) => (
                  <option key={t.slug} value={t.slug}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </Field>
        <Field label="Se busca por la columna">
          <select
            aria-label="Columna clave"
            value={match.key}
            disabled={readOnly}
            onChange={(e) => update({ key: e.target.value })}
            className={clsx(NATIVE, 'w-full')}
          >
            <option value="">Elige…</option>
            {columns.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field
          label="Cómo sacar la clave"
          hint="Se normaliza antes: mayúsculas, sin espacios, guiones ni tildes."
        >
          <select
            aria-label="Cómo sacar la clave"
            value={extract.mode}
            disabled={readOnly}
            onChange={(e) => {
              const m = e.target.value;
              update({
                extract:
                  m === 'prefix'
                    ? { mode: 'prefix', length: 2 }
                    : m === 'regex'
                      ? { mode: 'regex', pattern: '^([A-Z0-9]{2})' }
                      : { mode: 'full' },
              });
            }}
            className={clsx(NATIVE, 'w-full')}
          >
            <option value="full">El valor completo</option>
            <option value="prefix">Las primeras N letras (ej. «AV123» → AV)</option>
            <option value="regex">Un patrón con grupo (avanzado)</option>
          </select>
        </Field>
        {extract.mode === 'prefix' && (
          <Field label="Cuántas letras">
            <input
              type="number"
              min={1}
              max={8}
              value={extract.length}
              disabled={readOnly}
              onChange={(e) =>
                update({
                  extract: {
                    mode: 'prefix',
                    length: Math.min(8, Math.max(1, Number(e.target.value) || 1)),
                  },
                })
              }
              className={INPUT}
            />
          </Field>
        )}
        {extract.mode === 'regex' && (
          <Field label="Patrón (el primer grupo es la clave)">
            <input
              value={extract.pattern}
              maxLength={200}
              disabled={readOnly}
              onChange={(e) => update({ extract: { mode: 'regex', pattern: e.target.value } })}
              className={clsx(INPUT, 'font-mono text-xs')}
            />
          </Field>
        )}
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-xs font-semibold text-ink">Campos que se llenan</legend>
        {fillable.length === 0 && (
          <p className="text-xs text-ink-faint">Agrega otros campos para poder llenarlos.</p>
        )}
        {fillable.map((f) => (
          <div key={f.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-2">
            <span className="truncate text-xs text-ink">{f.label}</span>
            <select
              aria-label={`Columna para ${f.label}`}
              value={match.fills[f.key] ?? ''}
              disabled={readOnly}
              onChange={(e) => {
                const { [f.key]: _drop, ...rest } = match.fills;
                update({ fills: e.target.value ? { ...rest, [f.key]: e.target.value } : rest });
              }}
              className={clsx(NATIVE, 'w-full')}
            >
              <option value="">No llenar</option>
              {columns.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
        ))}
      </fieldset>
      {Object.keys(match.fills).length === 0 && (
        <p role="alert" className="text-xs font-semibold text-amber">
          Elige al menos un campo para llenar.
        </p>
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
