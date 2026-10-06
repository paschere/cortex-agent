'use client';

import { TRACKER_TYPE_LABEL } from '@/lib/datagrid/trackers';
import {
  type DateBoundMode,
  FIELD_TYPES,
  FORMAT_PRESETS,
  type FieldType,
  MAX_SELECT_OPTIONS,
  type TrackerField,
  boundShortcuts,
  changeFieldType,
  previewMessages,
  probePattern,
  readDateBound,
  shortcutActive,
  showIfChoices,
  showIfTargets,
  typeChangeIsSafe,
  typeHas,
  writeDateBound,
} from '@/lib/trackers/schema-editor';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Field, INPUT, Segmented, Toggle } from '../views/editor/controls';

/**
 * UN CAMPO DE LA TABLA, EDITABLE: nombre, tipo y sus opciones arriba; debajo,
 * «Reglas» (obligatorio, límites, largo, formato, único, mensaje, valor por
 * defecto, ayuda, «mostrar sólo si…») y una vista previa del input con una
 * prueba escrita a mano. La clave interna se muestra pero NO se cambia: las
 * filas, las vistas y las sincronizaciones la usan para encontrar el valor.
 *
 * Toda la lógica de qué aplica a qué tipo vive en `lib/trackers/schema-editor`.
 */

const NATIVE = 'rounded-sm border border-border-strong bg-surface px-2 py-1.5 text-sm text-ink';

export function FieldCard({
  field,
  index,
  total,
  fields,
  errors,
  existing,
  hasData,
  otherTrackers,
  readOnly,
  lockType,
  onChange,
  onMove,
  onRemove,
  open,
  onToggle,
  note,
}: {
  field: TrackerField;
  index: number;
  total: number;
  fields: TrackerField[];
  errors: string[];
  /** Ya existe en la tabla guardada (la clave es definitiva) y su tipo original. */
  existing: { type: FieldType } | null;
  /** La tabla tiene filas: pedir confirmación al quitar y cuidar el cambio de tipo. */
  hasData: boolean;
  otherTrackers: Array<{ slug: string; name: string }>;
  readOnly: boolean;
  /** Tabla desde una hoja: el tipo viene de la lectura de la hoja pero se puede corregir. */
  lockType?: boolean;
  onChange: (next: TrackerField) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  open: boolean;
  onToggle: () => void;
  /** «Por qué se propuso así»: evidencia de la hoja. */
  note?: { sourceColumn: string; label?: string; why: string[]; samples: string[] };
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const set = (patch: Partial<TrackerField>) => onChange({ ...field, ...patch });
  const retypeRisk =
    existing &&
    hasData &&
    field.type !== existing.type &&
    !typeChangeIsSafe(existing.type, field.type);

  return (
    <li
      className={clsx(
        'rounded-card border bg-surface',
        errors.length ? 'border-rose/50' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-center gap-2 p-3">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-pill bg-surface-2 text-micro font-semibold text-ink-muted">
          {index + 1}
        </span>
        <input
          aria-label={`Nombre del campo ${index + 1}`}
          value={field.label}
          maxLength={60}
          disabled={readOnly}
          onChange={(e) => set({ label: e.target.value })}
          className={clsx(INPUT, 'min-w-[8rem] flex-1')}
        />
        <select
          aria-label={`Tipo de «${field.label}»`}
          value={field.type}
          disabled={readOnly}
          onChange={(e) => onChange(changeFieldType(field, e.target.value as FieldType))}
          className={NATIVE}
        >
          {FIELD_TYPES.map((t) => (
            <option key={t} value={t}>
              {TRACKER_TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-0.5">
          <IconBtn label="Subir" disabled={readOnly || index === 0} onClick={() => onMove(-1)}>
            <ArrowUp className="h-3.5 w-3.5" />
          </IconBtn>
          <IconBtn
            label="Bajar"
            disabled={readOnly || index === total - 1}
            onClick={() => onMove(1)}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </IconBtn>
          {confirmRemove ? (
            <span className="flex items-center gap-1 pl-1 text-micro">
              <span className="text-rose">¿Quitar?</span>
              <button
                type="button"
                onClick={onRemove}
                className="rounded-pill bg-rose px-2 py-0.5 font-semibold text-white"
              >
                Sí
              </button>
              <button
                type="button"
                onClick={() => setConfirmRemove(false)}
                className="rounded-pill border border-border px-2 py-0.5 text-ink-muted"
              >
                No
              </button>
            </span>
          ) : (
            <IconBtn
              label={`Quitar «${field.label}»`}
              disabled={readOnly || total <= 1}
              danger
              onClick={() => (existing && hasData ? setConfirmRemove(true) : onRemove())}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </IconBtn>
          )}
        </div>
      </div>

      {confirmRemove && (
        <p className="mx-3 mb-2 rounded-sm bg-amber-soft px-3 py-2 text-xs leading-relaxed text-ink">
          La tabla ya tiene filas. Al guardar, «{field.label}» deja de verse en la tabla, en los
          formularios y en las vistas; antes de guardar te digo cuántas filas tienen algo escrito
          ahí y si alguna vista lo usa.
        </p>
      )}

      {note && (
        <div className="mx-3 mb-2 rounded-sm bg-primary-soft/40 px-3 py-2 text-micro leading-relaxed text-ink-muted">
          <p>
            <span className="font-semibold text-ink">
              {note.label ?? `Columna «${note.sourceColumn}»`}:
            </span>{' '}
            {note.why.length ? note.why.join(' · ') : 'sin pistas fuertes, queda como texto.'}
          </p>
          {note.samples.length > 0 && (
            <p className="mt-0.5">
              Ejemplos:{' '}
              {note.samples.map((s) => (
                <code key={s} className="mr-1 rounded-sm bg-surface px-1 text-ink">
                  {s}
                </code>
              ))}
            </p>
          )}
        </div>
      )}

      {errors.length > 0 && (
        <ul className="mx-3 mb-2 space-y-0.5 text-xs text-rose" aria-live="polite">
          {errors.map((e) => (
            <li key={e} className="flex items-start gap-1">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {e}
            </li>
          ))}
        </ul>
      )}
      {retypeRisk && (
        <p className="mx-3 mb-2 flex items-start gap-1 text-xs text-amber">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          Esta tabla ya tiene datos: cambiar «{field.label}» de{' '}
          {TRACKER_TYPE_LABEL[existing.type].toLowerCase()} a{' '}
          {TRACKER_TYPE_LABEL[field.type].toLowerCase()} no se va a poder guardar si algún valor
          queda sin sentido. Lo seguro es crear un campo nuevo.
        </p>
      )}

      {/* Opciones propias del tipo */}
      <div className="space-y-3 px-3 pb-3">
        {typeHas.options(field.type) && (
          <OptionsEditor
            options={field.options ?? []}
            readOnly={readOnly}
            onChange={(options) => set({ options })}
          />
        )}
        {typeHas.file(field.type) && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Segmented
              label="Qué acepta"
              value={field.accept ?? 'any'}
              options={[
                { value: 'any', label: 'Cualquier archivo' },
                { value: 'image', label: 'Sólo imágenes' },
              ]}
              onChange={(accept) => set({ accept })}
            />
            <Toggle
              label="Varios archivos"
              hint="Hasta 5 por registro."
              checked={Boolean(field.multiple)}
              disabled={readOnly}
              onChange={(multiple) => set({ multiple })}
            />
          </div>
        )}
        {typeHas.relation(field.type) && (
          <Field label="Apunta a la tabla">
            <select
              value={field.tracker ?? ''}
              disabled={readOnly}
              onChange={(e) => set({ tracker: e.target.value || undefined })}
              className={clsx(NATIVE, 'w-full')}
            >
              <option value="">Elige una tabla…</option>
              {field.tracker && !otherTrackers.some((t) => t.slug === field.tracker) && (
                <option value={field.tracker}>{field.tracker}</option>
              )}
              {otherTrackers.map((t) => (
                <option key={t.slug} value={t.slug}>
                  {t.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        {typeHas.scan(field.type) && (
          <Toggle
            label="Se llena con el escáner"
            hint="Código de barras o QR desde la cámara."
            checked={Boolean(field.scan)}
            disabled={readOnly}
            onChange={(scan) => set({ scan })}
          />
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-micro text-ink-faint">
            {existing ? (
              <>
                Clave interna: <code className="text-ink-muted">{field.key}</code> (no cambia)
              </>
            ) : (
              <>
                Clave interna: <code className="text-ink-muted">{field.key}</code> (queda fija al
                guardar)
              </>
            )}
          </p>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            className="inline-flex items-center gap-1 rounded-pill border border-border px-3 py-1 text-xs font-semibold text-ink-muted transition-colors hover:text-ink"
          >
            Reglas{summaryOf(field)}
            <ChevronDown
              className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-180')}
            />
          </button>
        </div>

        {open && (
          <RulesSection
            field={field}
            fields={fields}
            readOnly={readOnly}
            lockType={lockType}
            onChange={onChange}
          />
        )}
      </div>
    </li>
  );
}

/** « · 3» cuando el campo tiene reglas puestas, para no abrirlo a ciegas. */
function summaryOf(field: TrackerField): string {
  const n = [
    field.required,
    field.min !== undefined,
    field.max !== undefined,
    field.minLength !== undefined,
    field.maxLength !== undefined,
    field.format,
    field.pattern,
    field.unique,
    field.message,
    field.default !== undefined,
    field.showIf,
  ].filter(Boolean).length;
  return n ? ` · ${n}` : '';
}

function IconBtn({
  label,
  disabled,
  danger,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
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
      className={clsx(
        'grid h-7 w-7 place-items-center rounded-pill text-ink-faint transition-colors disabled:opacity-30',
        danger ? 'hover:bg-rose/10 hover:text-rose' : 'hover:bg-surface-2 hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Opciones de un select
// ---------------------------------------------------------------------------

function OptionsEditor({
  options,
  readOnly,
  onChange,
}: {
  options: string[];
  readOnly: boolean;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  function add() {
    // Pegar «a, b, c» o una opción por línea agrega varias de una vez.
    const parts = draft
      .split(/[\n;,]/)
      .map((p) => p.trim().slice(0, 80))
      .filter((p) => p && !options.includes(p));
    if (!parts.length) return;
    onChange([...options, ...parts].slice(0, MAX_SELECT_OPTIONS));
    setDraft('');
  }
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= options.length) return;
    const next = [...options];
    const a = next[i] as string;
    next[i] = next[j] as string;
    next[j] = a;
    onChange(next);
  };
  return (
    <div>
      <span className="field-label mb-1 block">Opciones (en este orden se ofrecen)</span>
      <ul className="space-y-1">
        {options.map((o, i) => (
          <li key={`${i}-${o}`} className="flex items-center gap-1">
            <input
              value={o}
              maxLength={80}
              disabled={readOnly}
              aria-label={`Opción ${i + 1}`}
              onChange={(e) => onChange(options.map((x, k) => (k === i ? e.target.value : x)))}
              className={clsx(INPUT, 'py-1')}
            />
            <IconBtn
              label="Subir opción"
              disabled={readOnly || i === 0}
              onClick={() => move(i, -1)}
            >
              <ArrowUp className="h-3 w-3" />
            </IconBtn>
            <IconBtn
              label="Bajar opción"
              disabled={readOnly || i === options.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown className="h-3 w-3" />
            </IconBtn>
            <IconBtn
              label={`Quitar la opción «${o}»`}
              disabled={readOnly || options.length <= 1}
              danger
              onClick={() => onChange(options.filter((_, k) => k !== i))}
            >
              <X className="h-3 w-3" />
            </IconBtn>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 flex gap-1">
        <input
          value={draft}
          disabled={readOnly || options.length >= MAX_SELECT_OPTIONS}
          placeholder="Nueva opción (o varias separadas por coma)"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
          className={clsx(INPUT, 'py-1')}
        />
        <button
          type="button"
          onClick={add}
          disabled={readOnly || !draft.trim()}
          className="inline-flex items-center gap-1 rounded-sm border border-border-strong px-3 text-xs font-semibold text-ink-muted hover:text-ink disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" /> Agregar
        </button>
      </div>
      <p className="mt-1 text-micro text-ink-faint">
        Cambiar el texto de una opción no cambia las filas que ya la tienen.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reglas
// ---------------------------------------------------------------------------

function RulesSection({
  field,
  fields,
  readOnly,
  onChange,
}: {
  field: TrackerField;
  fields: TrackerField[];
  readOnly: boolean;
  lockType?: boolean;
  onChange: (next: TrackerField) => void;
}) {
  const set = (patch: Partial<TrackerField>) => onChange({ ...field, ...patch });
  const t = field.type;
  const targets = showIfTargets(fields, field.key);
  const parent = fields.find((f) => f.key === field.showIf?.field);
  const choices = showIfChoices(parent);
  const [sample, setSample] = useState('');
  const [patternSample, setPatternSample] = useState('');
  const probe = field.pattern ? probePattern(field.pattern, patternSample) : null;
  const messages = sample ? previewMessages(field, sample) : [];

  return (
    <div className="space-y-4 rounded-sm border border-border bg-surface-2/40 p-3">
      <Toggle
        label="Obligatorio"
        hint="No deja guardar sin llenarlo."
        checked={field.required}
        disabled={readOnly}
        onChange={(required) => set({ required })}
      />

      {typeHas.bounds(t) && (
        <div className="space-y-2">
          <span className="field-label block">
            {t === 'number' || t === 'money'
              ? 'Valor permitido'
              : t === 'date'
                ? 'Fechas permitidas'
                : 'Horas permitidas'}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {boundShortcuts(t).map((s) => {
              const active = shortcutActive(field, s);
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={readOnly}
                  aria-pressed={active}
                  onClick={() =>
                    active
                      ? set({
                          min: 'min' in s.patch ? undefined : field.min,
                          max: 'max' in s.patch ? undefined : field.max,
                        })
                      : set({
                          min: 'min' in s.patch ? s.patch.min : field.min,
                          max: 'max' in s.patch ? s.patch.max : field.max,
                        })
                  }
                  className={clsx(
                    'inline-flex items-center gap-1 rounded-pill border px-2.5 py-1 text-xs font-semibold transition-colors',
                    active
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-border text-ink-muted hover:text-ink',
                  )}
                >
                  {active && <Check className="h-3 w-3" />} {s.label}
                </button>
              );
            })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <BoundInput
              label="Mínimo"
              type={t}
              value={field.min}
              readOnly={readOnly}
              onChange={(min) => set({ min })}
            />
            <BoundInput
              label="Máximo"
              type={t}
              value={field.max}
              readOnly={readOnly}
              onChange={(max) => set({ max })}
            />
          </div>
        </div>
      )}

      {typeHas.length(t) && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Largo mínimo">
            <input
              type="number"
              min={0}
              value={field.minLength ?? ''}
              disabled={readOnly}
              onChange={(e) =>
                set({ minLength: e.target.value === '' ? undefined : Number(e.target.value) })
              }
              className={INPUT}
            />
          </Field>
          <Field label="Largo máximo">
            <input
              type="number"
              min={1}
              value={field.maxLength ?? ''}
              disabled={readOnly}
              onChange={(e) =>
                set({ maxLength: e.target.value === '' ? undefined : Number(e.target.value) })
              }
              className={INPUT}
            />
          </Field>
        </div>
      )}

      {typeHas.format(t) && (
        <Field
          label="Formato"
          hint={
            field.format
              ? `Ejemplo que pasa: ${FORMAT_PRESETS.find((p) => p.value === field.format)?.example}`
              : 'Revisa que lo escrito tenga la forma de un correo, un NIT, una placa…'
          }
        >
          <select
            value={field.format ?? ''}
            disabled={readOnly}
            onChange={(e) => {
              const format = (e.target.value || undefined) as TrackerField['format'];
              const preset = FORMAT_PRESETS.find((p) => p.value === format);
              set({ format, example: field.example ?? preset?.example });
            }}
            className={clsx(NATIVE, 'w-full')}
          >
            <option value="">Cualquier texto</option>
            {FORMAT_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label} — {p.example}
              </option>
            ))}
          </select>
        </Field>
      )}

      {typeHas.pattern(t) && (
        <div className="space-y-1.5">
          <Field
            label="Patrón propio (avanzado)"
            hint="Una expresión regular corta, p. ej. ^[A-Z]{3}\d{3}$. Pruébala con un ejemplo."
          >
            <input
              value={field.pattern ?? ''}
              maxLength={200}
              disabled={readOnly}
              onChange={(e) => set({ pattern: e.target.value || undefined })}
              className={clsx(INPUT, 'font-mono text-xs')}
            />
          </Field>
          {field.pattern && (
            <div>
              <input
                value={patternSample}
                placeholder="Escribe un ejemplo para probar…"
                onChange={(e) => setPatternSample(e.target.value)}
                className={clsx(INPUT, 'py-1')}
                aria-label="Ejemplo para probar el patrón"
              />
              <p
                aria-live="polite"
                className={clsx(
                  'mt-1 text-xs',
                  probe?.state === 'pass' && 'text-emerald',
                  (probe?.state === 'fail' || probe?.state === 'invalid') && 'text-rose',
                  probe?.state === 'empty' && 'text-ink-faint',
                )}
              >
                {probe?.state === 'pass' && 'Pasa.'}
                {probe?.state === 'fail' && 'No pasa: este valor se rechazaría.'}
                {probe?.state === 'invalid' && probe.message}
                {probe?.state === 'empty' && 'Escribe un ejemplo y te digo si pasa.'}
              </p>
            </div>
          )}
        </div>
      )}

      {typeHas.unique(t) && (
        <Toggle
          label="No se puede repetir"
          hint="Bloquea guardar si ya hay una fila con el mismo valor (sin importar mayúsculas, tildes ni guiones)."
          checked={Boolean(field.unique)}
          disabled={readOnly}
          onChange={(unique) => set({ unique })}
        />
      )}

      <Field label="Mensaje de error propio" hint="Reemplaza al mensaje de la regla que falle.">
        <input
          value={field.message ?? ''}
          maxLength={200}
          disabled={readOnly}
          onChange={(e) => set({ message: e.target.value || undefined })}
          className={INPUT}
        />
      </Field>

      {typeHas.defaultValue(t) && (
        <DefaultInput field={field} readOnly={readOnly} onChange={(def) => set({ default: def })} />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ayuda (debajo del campo)">
          <input
            value={field.help ?? ''}
            maxLength={200}
            disabled={readOnly}
            onChange={(e) => set({ help: e.target.value || undefined })}
            className={INPUT}
          />
        </Field>
        {typeHas.placeholder(t) && (
          <Field label="Texto de fondo">
            <input
              value={field.placeholder ?? ''}
              maxLength={80}
              disabled={readOnly}
              onChange={(e) => set({ placeholder: e.target.value || undefined })}
              className={INPUT}
            />
          </Field>
        )}
        <Field label="Ejemplo">
          <input
            value={field.example ?? ''}
            maxLength={80}
            disabled={readOnly}
            onChange={(e) => set({ example: e.target.value || undefined })}
            className={INPUT}
          />
        </Field>
      </div>

      {/* Mostrar sólo si… */}
      <div className="space-y-2">
        <Toggle
          label="Mostrar sólo si…"
          hint="El campo aparece (y se exige) únicamente cuando otro campo cumple una condición."
          checked={Boolean(field.showIf)}
          disabled={readOnly || targets.every((x) => x.disabled)}
          onChange={(on) => {
            if (!on) return set({ showIf: undefined });
            const first = targets.find((x) => !x.disabled);
            if (first) set({ showIf: { field: first.key, notEmpty: true } });
          }}
        />
        {field.showIf && (
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr]">
            <select
              aria-label="Campo del que depende"
              value={field.showIf.field}
              disabled={readOnly}
              onChange={(e) => set({ showIf: { field: e.target.value, notEmpty: true } })}
              className={NATIVE}
            >
              {targets.map((x) => (
                <option key={x.key} value={x.key} disabled={Boolean(x.disabled)} title={x.disabled}>
                  {x.label}
                  {x.disabled ? ' (formaría un círculo)' : ''}
                </option>
              ))}
            </select>
            <select
              aria-label="Condición"
              value={field.showIf.equals !== undefined ? 'equals' : 'notEmpty'}
              disabled={readOnly}
              onChange={(e) =>
                set({
                  showIf:
                    e.target.value === 'equals'
                      ? { field: field.showIf?.field as string, equals: choices?.[0] ?? '' }
                      : { field: field.showIf?.field as string, notEmpty: true },
                })
              }
              className={NATIVE}
            >
              <option value="notEmpty">tiene algo escrito</option>
              <option value="equals">es igual a…</option>
            </select>
            {field.showIf.equals !== undefined &&
              (choices ? (
                <ChoicePicker
                  choices={choices}
                  checkbox={parent?.type === 'checkbox'}
                  value={field.showIf.equals}
                  disabled={readOnly}
                  onChange={(equals) =>
                    set({ showIf: { field: field.showIf?.field as string, equals } })
                  }
                />
              ) : (
                <input
                  aria-label="Valor"
                  value={
                    Array.isArray(field.showIf.equals)
                      ? field.showIf.equals.join(', ')
                      : field.showIf.equals
                  }
                  disabled={readOnly}
                  onChange={(e) =>
                    set({
                      showIf: { field: field.showIf?.field as string, equals: e.target.value },
                    })
                  }
                  className={INPUT}
                />
              ))}
          </div>
        )}
      </div>

      {/* Vista previa */}
      <div className="rounded-sm border border-dashed border-border-strong bg-surface p-3">
        <p className="field-label mb-1">Vista previa</p>
        <p className="text-sm font-medium text-ink">
          {field.label || 'Sin nombre'}
          {field.required && <span className="text-rose"> *</span>}
        </p>
        <PreviewInput field={field} value={sample} onChange={setSample} />
        {field.help && <p className="mt-1 text-micro text-ink-faint">{field.help}</p>}
        {field.example && <p className="text-micro text-ink-faint">Ej.: {field.example}</p>}
        {messages.map((m) => (
          <p key={m} className="mt-1 text-xs text-rose">
            {m}
          </p>
        ))}
        {sample && messages.length === 0 && (
          <p className="mt-1 text-xs text-emerald">Pasa las reglas.</p>
        )}
      </div>
    </div>
  );
}

function ChoicePicker({
  choices,
  checkbox,
  value,
  disabled,
  onChange,
}: {
  choices: string[];
  checkbox: boolean;
  value: string | string[];
  disabled: boolean;
  onChange: (next: string | string[]) => void;
}) {
  const current = Array.isArray(value) ? value : [value];
  if (checkbox)
    return (
      <select
        aria-label="Valor"
        value={current[0] ?? '1'}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={NATIVE}
      >
        <option value="1">Sí (marcada)</option>
        <option value="0">No (sin marcar)</option>
      </select>
    );
  return (
    <div className="flex flex-wrap gap-1">
      {choices.map((c) => {
        const on = current.includes(c);
        return (
          <button
            key={c}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => {
              const next = on ? current.filter((x) => x !== c) : [...current, c];
              onChange(next.length <= 1 ? (next[0] ?? '') : next);
            }}
            className={clsx(
              'rounded-pill border px-2 py-0.5 text-xs font-semibold',
              on ? 'border-primary bg-primary-soft text-primary' : 'border-border text-ink-muted',
            )}
          >
            {c}
          </button>
        );
      })}
    </div>
  );
}

function BoundInput({
  label,
  type,
  value,
  readOnly,
  onChange,
}: {
  label: string;
  type: FieldType;
  value: string | number | undefined;
  readOnly: boolean;
  onChange: (next: string | number | undefined) => void;
}) {
  if (type === 'number' || type === 'money')
    return (
      <Field label={label}>
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          disabled={readOnly}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          className={INPUT}
        />
      </Field>
    );
  if (type === 'time')
    return (
      <Field label={label}>
        <div className="flex gap-1">
          <select
            aria-label={`${label}: modo`}
            value={value === 'now' ? 'now' : value ? 'fixed' : 'none'}
            disabled={readOnly}
            onChange={(e) =>
              onChange(
                e.target.value === 'now' ? 'now' : e.target.value === 'fixed' ? '08:00' : undefined,
              )
            }
            className={NATIVE}
          >
            <option value="none">Sin límite</option>
            <option value="now">Ahora</option>
            <option value="fixed">Una hora</option>
          </select>
          {value && value !== 'now' && (
            <input
              type="time"
              value={String(value)}
              disabled={readOnly}
              onChange={(e) => onChange(e.target.value || undefined)}
              className={clsx(INPUT, 'py-1')}
            />
          )}
        </div>
      </Field>
    );
  const r = readDateBound(value);
  const apply = (mode: DateBoundMode, n = r.n, date = r.date) =>
    onChange(writeDateBound(mode, n, date));
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-1">
        <select
          aria-label={`${label}: modo`}
          value={r.mode}
          disabled={readOnly}
          onChange={(e) =>
            apply(
              e.target.value as DateBoundMode,
              r.n,
              r.date || new Date().toISOString().slice(0, 10),
            )
          }
          className={NATIVE}
        >
          <option value="none">Sin límite</option>
          <option value="today">Hoy</option>
          <option value="before">Hace N días</option>
          <option value="after">Dentro de N días</option>
          <option value="fixed">Una fecha</option>
        </select>
        {(r.mode === 'before' || r.mode === 'after') && (
          <input
            type="number"
            min={1}
            max={9999}
            aria-label="Días"
            value={r.n}
            disabled={readOnly}
            onChange={(e) => apply(r.mode, Number(e.target.value))}
            className={clsx(INPUT, 'w-24 py-1')}
          />
        )}
        {r.mode === 'fixed' && (
          <input
            type="date"
            value={r.date}
            disabled={readOnly}
            onChange={(e) => apply('fixed', r.n, e.target.value)}
            className={clsx(INPUT, 'w-auto py-1')}
          />
        )}
      </div>
    </Field>
  );
}

function DefaultInput({
  field,
  readOnly,
  onChange,
}: {
  field: TrackerField;
  readOnly: boolean;
  onChange: (next: string | number | undefined) => void;
}) {
  const t = field.type;
  const dyn = t === 'date' ? 'today' : t === 'time' ? 'now' : t === 'text' ? 'viewer' : null;
  const dynLabel = t === 'date' ? 'Hoy' : t === 'time' ? 'La hora de ahora' : 'Quien lo llena';
  const isDyn = dyn !== null && field.default === dyn;
  return (
    <div>
      <span className="field-label mb-1 block">Valor por defecto</span>
      <div className="flex flex-wrap gap-1.5">
        {dyn && (
          <select
            aria-label="Valor por defecto: tipo"
            value={isDyn ? 'dyn' : field.default !== undefined ? 'fixed' : 'none'}
            disabled={readOnly}
            onChange={(e) =>
              onChange(
                e.target.value === 'dyn'
                  ? (dyn as string)
                  : e.target.value === 'fixed'
                    ? t === 'date'
                      ? new Date().toISOString().slice(0, 10)
                      : t === 'time'
                        ? '08:00'
                        : ' '
                    : undefined,
              )
            }
            className={NATIVE}
          >
            <option value="none">Vacío</option>
            <option value="dyn">{dynLabel}</option>
            <option value="fixed">Un valor fijo</option>
          </select>
        )}
        {!isDyn &&
          (dyn === null || field.default !== undefined) &&
          (t === 'select' ? (
            <select
              aria-label="Valor por defecto"
              value={String(field.default ?? '')}
              disabled={readOnly}
              onChange={(e) => onChange(e.target.value || undefined)}
              className={NATIVE}
            >
              <option value="">Vacío</option>
              {(field.options ?? []).map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : t === 'checkbox' ? (
            <select
              aria-label="Valor por defecto"
              value={String(field.default ?? '')}
              disabled={readOnly}
              onChange={(e) => onChange(e.target.value || undefined)}
              className={NATIVE}
            >
              <option value="">Vacío</option>
              <option value="1">Marcada</option>
              <option value="0">Sin marcar</option>
            </select>
          ) : (
            <input
              aria-label="Valor por defecto"
              type={
                t === 'date'
                  ? 'date'
                  : t === 'time'
                    ? 'time'
                    : t === 'number' || t === 'money'
                      ? 'number'
                      : 'text'
              }
              value={String(field.default ?? '')}
              disabled={readOnly}
              onChange={(e) =>
                onChange(
                  e.target.value === ''
                    ? undefined
                    : t === 'number' || t === 'money'
                      ? Number(e.target.value)
                      : e.target.value,
                )
              }
              className={clsx(INPUT, 'w-auto py-1')}
            />
          ))}
      </div>
    </div>
  );
}

function PreviewInput({
  field,
  value,
  onChange,
}: {
  field: TrackerField;
  value: string;
  onChange: (v: string) => void;
}) {
  const t = field.type;
  const common = {
    'aria-label': `Probar «${field.label}»`,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
      onChange(e.target.value),
  };
  if (t === 'select')
    return (
      <select {...common} className={clsx(NATIVE, 'mt-1 w-full')}>
        <option value="">Elige…</option>
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  if (t === 'checkbox')
    return (
      <select {...common} className={clsx(NATIVE, 'mt-1 w-full')}>
        <option value="">Sin responder</option>
        <option value="1">Sí</option>
        <option value="0">No</option>
      </select>
    );
  if (t === 'longtext')
    return (
      <textarea
        {...common}
        rows={2}
        placeholder={field.placeholder}
        className={clsx(INPUT, 'mt-1')}
      />
    );
  if (t === 'file' || t === 'relation' || t === 'location')
    return (
      <p className="mt-1 rounded-sm bg-surface-2 px-3 py-2 text-xs text-ink-faint">
        {t === 'file'
          ? `Aquí se sube ${field.multiple ? 'hasta 5 archivos' : 'un archivo'}${field.accept === 'image' ? ' (sólo imágenes)' : ''}.`
          : t === 'relation'
            ? `Aquí se elige una fila de «${field.tracker ?? 'otra tabla'}».`
            : 'Aquí se toma la ubicación del teléfono.'}
      </p>
    );
  return (
    <input
      {...common}
      type={
        t === 'date'
          ? 'date'
          : t === 'time'
            ? 'time'
            : t === 'number' || t === 'money'
              ? 'number'
              : 'text'
      }
      placeholder={field.placeholder}
      className={clsx(INPUT, 'mt-1')}
    />
  );
}
