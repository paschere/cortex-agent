'use client';

import type {
  SchemaActions,
  SchemaEditorData,
  SchemaImpact,
  SheetProposalView,
} from '@/app/(app)/trackers/schema-types';
import { TRACKER_TYPE_LABEL } from '@/lib/datagrid/trackers';
import {
  type DuplicateDraft,
  FIELD_TYPES,
  type FieldType,
  MAX_TRACKER_FIELDS,
  type TrackerField,
  cleanFields,
  duplicateProblem,
  intervalProblem,
  moveField,
  newField,
  removeField,
  validateDraft,
} from '@/lib/trackers/schema-editor';
import { clsx } from 'clsx';
import { AlertTriangle, Loader2, Plus, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Field, INPUT, Section, Toggle } from '../views/editor/controls';
import { FieldCard } from './FieldCard';
import { DuplicatesRule, SyncRules } from './TableRules';

/**
 * «CAMPOS Y REGLAS»: el editor de una tabla, el MISMO desde la pantalla de la
 * tabla, desde el inspector de una vista y desde «Crear tabla nueva».
 *
 * Tres modos con una sola interfaz:
 *   - editar una tabla que existe (`data`): guarda campos y duplicados con un
 *     «Guardar» que primero pregunta al servidor qué rompería (vistas,
 *     sincronizaciones, filas con datos) y no guarda si rompe algo;
 *   - crear desde cero (`seed`): una tabla con el primer campo puesto;
 *   - crear desde una hoja (`sheet`): ya prellenado con lo que Cortex leyó, con
 *     el porqué y ejemplos de cada campo, la clave y la regla de duplicados
 *     sugeridas; la persona corrige y al crear se llena con la hoja.
 *
 * Lo que este componente dice que es válido no manda: el servidor vuelve a
 * validar todo con el mismo esquema (`trackerFieldsSchema`).
 */

export interface SchemaSeed {
  name: string;
  description: string;
  fields: TrackerField[];
  duplicates: DuplicateDraft | null;
  otherTrackers: Array<{ slug: string; name: string }>;
}

export function SchemaEditor({
  data,
  seed,
  sheet,
  actions,
  onSaved,
  onCreated,
  onCancel,
}: {
  data?: SchemaEditorData;
  seed?: SchemaSeed;
  sheet?: SheetProposalView;
  actions: SchemaActions;
  onSaved?: (fresh: SchemaEditorData) => void;
  onCreated?: (created: { slug: string; id: string; fields: TrackerField[] }) => void;
  onCancel?: () => void;
}) {
  const editing = Boolean(data);
  const start = data
    ? {
        name: data.tracker.name,
        description: data.tracker.description,
        fields: data.tracker.fields,
        duplicates: data.tracker.duplicates,
      }
    : (seed as SchemaSeed);
  const otherTrackers = data?.otherTrackers ?? seed?.otherTrackers ?? [];
  const readOnly = data ? !data.canEdit : false;

  const [saved, setSaved] = useState(data);
  const [name, setName] = useState(start.name);
  const [description, setDescription] = useState(start.description);
  const [fields, setFields] = useState<TrackerField[]>(start.fields);
  const [duplicates, setDuplicates] = useState<DuplicateDraft | null>(start.duplicates);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ label: string; type: FieldType }>({
    label: '',
    type: 'text',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [impact, setImpact] = useState<SchemaImpact | null>(null);
  const [okNote, setOkNote] = useState<string | null>(null);
  // Sólo «desde una hoja».
  const keyFromColumns = useMemo(() => {
    if (!sheet) return [];
    return sheet.keyColumns.flatMap((col) => {
      const hit = Object.entries(sheet.evidence).find(
        ([, e]) => e.sourceColumn === col || e.sourceColumn.toLowerCase() === col.toLowerCase(),
      );
      return hit ? [hit[0]] : [];
    });
  }, [sheet]);
  const [keyFields, setKeyFields] = useState<string[]>(keyFromColumns);
  const [every, setEvery] = useState(15);
  const [notify, setNotify] = useState(false);

  const savedKeys = useMemo(
    () => new Map((saved?.tracker.fields ?? []).map((f) => [f.key, f] as const)),
    [saved],
  );
  const validation = useMemo(() => validateDraft(fields), [fields]);
  const ruleIssue = duplicates ? duplicateProblem(duplicates, fields) : null;
  const dirty = useMemo(
    () =>
      JSON.stringify({ name, description, fields: cleanFields(fields), duplicates }) !==
      JSON.stringify({
        name: start.name,
        description: start.description,
        fields: cleanFields(start.fields),
        duplicates: start.duplicates,
      }),
    [name, description, fields, duplicates, start],
  );
  const sheetIssues = sheet
    ? [
        keyFields.length === 0 ? 'Elige al menos una columna que identifique cada fila.' : null,
        intervalProblem(every),
      ].filter((x): x is string => Boolean(x))
    : [];
  const blocking = !name.trim() || !validation.ok || Boolean(ruleIssue) || sheetIssues.length > 0;

  function change(next: TrackerField[]) {
    setFields(next);
    setImpact(null);
    setError(null);
    setOkNote(null);
  }

  function addField() {
    if (fields.length >= MAX_TRACKER_FIELDS || readOnly) return;
    const f = newField(fields, adding.label, adding.type);
    change([...fields, f]);
    setOpen(f.key);
    setAdding({ label: '', type: 'text' });
  }

  function dropField(key: string) {
    const r = removeField(fields, key);
    if (duplicates && [duplicates.key, duplicates.distinctBy, duplicates.flagField].includes(key))
      setDuplicates(null);
    setKeyFields((k) => k.filter((x) => x !== key));
    change(r.fields);
    if (r.clearedShowIf.length)
      setOkNote(
        `«${r.clearedShowIf.join('», «')}» se mostraba según ese campo y ahora se muestra siempre.`,
      );
  }

  async function submit(confirm: boolean) {
    setShowErrors(true);
    setError(null);
    setOkNote(null);
    if (blocking) return;
    setBusy(true);
    try {
      const cleaned = cleanFields(fields);
      if (!data) {
        if (sheet && actions.createFromSheet) {
          const columns = Object.fromEntries(
            Object.entries(sheet.evidence).map(([k, e]) => [k, e.sourceColumn]),
          );
          const r = await actions.createFromSheet({
            sourceId: sheet.sourceId,
            sheetIndex: sheet.sheetIndex,
            name,
            description,
            fields: cleaned,
            columns,
            keyColumns: keyFields,
            duplicates,
            intervalMinutes: every,
            notify,
          });
          if (!r.ok) return setError(r.error);
          return onCreated?.(r);
        }
        const r = await actions.create({ name, description, fields: cleaned, duplicates });
        if (!r.ok) return setError(r.error);
        return onCreated?.(r);
      }
      const analysis = await actions.analyze(data.tracker.id, { fields: cleaned, duplicates });
      if (!analysis.ok) return setError(analysis.error);
      setImpact(analysis.impact);
      if (!analysis.impact.canSave) return;
      if (analysis.impact.needsConfirm && !confirm) return;
      const r = await actions.save(data.tracker.id, {
        name,
        description,
        fields: cleaned,
        duplicates,
        confirmRemoved: confirm
          ? analysis.impact.removed.filter((x) => x.rows > 0).map((x) => x.key)
          : [],
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      const fresh = await actions.load(data.tracker.slug);
      if (fresh.ok) {
        setSaved(fresh.data);
        setFields(fresh.data.tracker.fields);
        setDuplicates(fresh.data.tracker.duplicates);
        onSaved?.(fresh.data);
      }
      setImpact(null);
      setOkNote('Guardado. Las vistas y los formularios ya usan los campos nuevos.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      {readOnly && (
        <p className="rounded-sm border border-amber/40 bg-amber-soft px-3 py-2 text-xs text-ink">
          Tu equipo no tiene permiso para cambiar los campos ni las reglas de las tablas. Puedes
          verlas.
        </p>
      )}

      {sheet && (
        <div className="rounded-card border border-primary/30 bg-primary-soft/30 p-3 text-xs leading-relaxed text-ink-muted">
          <p className="font-semibold text-ink">Esto es lo que Cortex leyó de tu hoja</p>
          <p>
            {sheet.rows} filas leídas. Debajo de cada campo ves por qué lo propuse así y ejemplos;
            corrige lo que no cuadre antes de crear.
          </p>
          {sheet.notes.map((n) => (
            <p key={n} className="mt-1">
              {n}
            </p>
          ))}
        </div>
      )}

      <section className="grid gap-3">
        <Field label="Nombre de la tabla">
          <input
            value={name}
            maxLength={80}
            disabled={readOnly}
            onChange={(e) => {
              setName(e.target.value);
              setOkNote(null);
            }}
            className={clsx(INPUT, showErrors && !name.trim() && 'border-rose')}
          />
        </Field>
        <Field label="Para qué sirve (opcional)">
          <input
            value={description}
            maxLength={500}
            disabled={readOnly}
            onChange={(e) => setDescription(e.target.value)}
            className={INPUT}
          />
        </Field>
      </section>

      <Section
        title={`Campos (${fields.length}/${MAX_TRACKER_FIELDS})`}
        action={
          <button
            type="button"
            onClick={() => setOpen(open === '*' ? null : '*')}
            className="text-micro font-semibold text-primary"
          >
            {open === '*' ? 'Cerrar reglas' : 'Ver todas las reglas'}
          </button>
        }
      >
        {validation.general.map((g) => (
          <p key={g} className="text-xs text-rose">
            {g}
          </p>
        ))}
        <ul className="space-y-3">
          {fields.map((f, i) => (
            <FieldCard
              key={f.key}
              field={f}
              index={i}
              total={fields.length}
              fields={fields}
              errors={
                showErrors || validation.byField[f.key] ? (validation.byField[f.key] ?? []) : []
              }
              existing={
                savedKeys.get(f.key) ? { type: (savedKeys.get(f.key) as TrackerField).type } : null
              }
              hasData={(saved?.rowCount ?? 0) > 0}
              otherTrackers={otherTrackers}
              readOnly={readOnly}
              open={open === '*' || open === f.key}
              onToggle={() => setOpen(open === f.key ? null : f.key)}
              note={sheet?.evidence[f.key]}
              onChange={(next) => change(fields.map((x) => (x.key === f.key ? next : x)))}
              onMove={(d) => change(moveField(fields, i, i + d))}
              onRemove={() => dropField(f.key)}
            />
          ))}
        </ul>
        {!readOnly && !sheet && (
          <div className="flex flex-wrap gap-2 rounded-card border border-dashed border-border-strong p-3">
            <input
              aria-label="Nombre del campo nuevo"
              value={adding.label}
              placeholder="Nombre del campo nuevo"
              maxLength={60}
              onChange={(e) => setAdding({ ...adding, label: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addField();
                }
              }}
              className={clsx(INPUT, 'min-w-[10rem] flex-1')}
            />
            <select
              aria-label="Tipo del campo nuevo"
              value={adding.type}
              onChange={(e) => setAdding({ ...adding, type: e.target.value as FieldType })}
              className="rounded-sm border border-border-strong bg-surface px-2 py-1.5 text-sm"
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TRACKER_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addField}
              disabled={fields.length >= MAX_TRACKER_FIELDS}
              className="inline-flex items-center gap-1 rounded-pill border border-primary/50 bg-primary-soft px-4 py-1.5 text-xs font-semibold text-primary disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" /> Agregar campo
            </button>
          </div>
        )}
      </Section>

      {sheet && (
        <Section title="Cómo se reconoce cada fila">
          <p className="text-xs text-ink-muted">{sheet.keyWhy}</p>
          <div className="flex flex-wrap gap-1.5">
            {fields.map((f) => {
              const on = keyFields.includes(f.key);
              return (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    setKeyFields(
                      on ? keyFields.filter((k) => k !== f.key) : [...keyFields, f.key].slice(0, 5),
                    )
                  }
                  className={clsx(
                    'rounded-pill border px-2.5 py-1 text-xs font-semibold',
                    on
                      ? 'border-primary bg-primary-soft text-primary'
                      : 'border-border text-ink-muted hover:text-ink',
                  )}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Cada cuánto se vuelve a leer la hoja (minutos)"
              hint={intervalProblem(every) ?? undefined}
            >
              <input
                type="number"
                min={5}
                max={1440}
                value={every}
                onChange={(e) => setEvery(Number(e.target.value))}
                className={INPUT}
              />
            </Field>
            <Toggle
              label="Avisar en la campana"
              hint="Cuando entran filas nuevas."
              checked={notify}
              onChange={setNotify}
            />
          </div>
        </Section>
      )}

      <DuplicatesRule
        rule={duplicates}
        fields={fields}
        readOnly={readOnly}
        hint={sheet?.duplicates?.why}
        onChange={(r) => {
          setDuplicates(r);
          setImpact(null);
        }}
        onFields={change}
      />

      {saved && (
        <SyncRules
          syncs={saved.syncs}
          savedFields={saved.tracker.fields}
          canSync={saved.canSync}
          actions={actions}
          onSaved={(s) =>
            setSaved({ ...saved, syncs: saved.syncs.map((x) => (x.id === s.id ? s : x)) })
          }
        />
      )}

      {impact && <ImpactPanel impact={impact} />}

      <div className="sticky bottom-0 -mx-4 space-y-2 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur">
        {error && (
          <p role="alert" className="flex items-start gap-1.5 text-xs text-rose">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {error}
          </p>
        )}
        {okNote && !error && (
          <p aria-live="polite" className="text-xs text-emerald">
            {okNote}
          </p>
        )}
        {showErrors && blocking && (
          <p className="text-xs text-rose">
            {!name.trim()
              ? 'Ponle un nombre a la tabla.'
              : ruleIssue
                ? ruleIssue
                : sheetIssues[0]
                  ? sheetIssues[0]
                  : 'Corrige lo marcado en rojo para guardar.'}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-pill border border-border px-4 py-2 text-xs font-semibold text-ink-muted hover:text-ink"
            >
              {editing ? 'Cerrar' : 'Cancelar'}
            </button>
          )}
          {impact?.needsConfirm && impact.canSave ? (
            <button
              type="button"
              onClick={() => submit(true)}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-pill bg-rose px-5 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Quitar esos campos y guardar
            </button>
          ) : (
            <button
              type="button"
              onClick={() => submit(false)}
              disabled={busy || readOnly || (editing && !dirty)}
              className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-5 py-2 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              {editing
                ? 'Guardar campos y reglas'
                : sheet
                  ? 'Crear y llenar con la hoja'
                  : 'Crear tabla'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Lo que el servidor dice que pasaría al guardar: bloqueos, vistas que se romperían, datos que se pierden de vista. */
function ImpactPanel({ impact }: { impact: SchemaImpact }) {
  const blocked = !impact.canSave;
  return (
    <div
      aria-live="polite"
      className={clsx(
        'space-y-2 rounded-card border p-3 text-xs leading-relaxed',
        blocked ? 'border-rose/50 bg-rose/5' : 'border-amber/50 bg-amber-soft',
      )}
    >
      <p
        className={clsx(
          'flex items-center gap-1.5 font-semibold',
          blocked ? 'text-rose' : 'text-amber',
        )}
      >
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        {blocked ? 'No se guardó: esto se rompería' : 'Antes de guardar, confirma'}
      </p>
      {impact.blockers.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-ink">
          {impact.blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {impact.views.length > 0 && (
        <div className="text-ink">
          <p className="font-semibold">
            {impact.views.length === 1
              ? 'Una vista dejaría de funcionar'
              : `${impact.views.length} vistas dejarían de funcionar`}
            :
          </p>
          <ul className="list-disc space-y-1 pl-4">
            {impact.views.map((v) => (
              <li key={v.id}>
                <strong>{v.name}</strong>
                <ul className="list-[circle] pl-4 text-ink-muted">
                  {v.problems.slice(0, 4).map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-ink-muted">
            Abre cada vista, quita ese campo del bloque y vuelve a guardar aquí. No se tocan solas
            para no cambiarte lo que armaste.
          </p>
        </div>
      )}
      {!blocked && impact.removed.some((r) => r.rows > 0) && (
        <ul className="list-disc space-y-0.5 pl-4 text-ink">
          {impact.removed
            .filter((r) => r.rows > 0)
            .map((r) => (
              <li key={r.key}>
                «{r.label}» tiene datos en {r.rows} {r.rows === 1 ? 'fila' : 'filas'}: dejarán de
                verse en la tabla, los formularios y las vistas.
              </li>
            ))}
        </ul>
      )}
      {!blocked && impact.droppedOptions.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-4 text-ink-muted">
          {impact.droppedOptions.map((d) => (
            <li key={d.key}>
              «{d.label}» pierde las opciones {d.options.map((o) => `«${o}»`).join(', ')}; las filas
              que las tienen las conservan.
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
