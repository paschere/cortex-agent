'use client';

import type { SchemaActions, SchemaSyncInfo } from '@/app/(app)/trackers/schema-types';
import {
  type DuplicateDraft,
  SYNC_INTERVALS,
  type TrackerField,
  duplicateProblem,
  intervalProblem,
  missingFlagOption,
  withFlagOption,
} from '@/lib/trackers/schema-editor';
import { clsx } from 'clsx';
import { AlertTriangle, Check, Loader2, Play, Plus, RefreshCw } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Field, INPUT, Section, Toggle } from '../views/editor/controls';

/**
 * LAS REGLAS DE LA TABLA (no de un campo): qué se hace con los duplicados y
 * cómo se llena sola. Los duplicados se guardan junto con los campos (un solo
 * «Guardar»); cada sincronización se guarda por su cuenta, porque corre sola
 * en el servidor y no tiene por qué esperar a que se terminen de editar los
 * campos.
 */

const NATIVE = 'rounded-sm border border-border-strong bg-surface px-2 py-1.5 text-sm text-ink';

export function DuplicatesRule({
  rule,
  fields,
  readOnly,
  hint,
  onChange,
  onFields,
}: {
  rule: DuplicateDraft | null;
  fields: TrackerField[];
  readOnly: boolean;
  /** Por qué se sugiere (si viene de la lectura de una hoja). */
  hint?: string;
  onChange: (next: DuplicateDraft | null) => void;
  onFields: (next: TrackerField[]) => void;
}) {
  const flaggable = fields.filter((f) => f.type === 'select' || f.type === 'text');
  const problem = rule ? duplicateProblem(rule, fields) : null;
  const missing = rule ? missingFlagOption(rule, fields) : null;
  const first = (pick: (f: TrackerField) => boolean) => fields.find(pick)?.key ?? '';
  const start = (): DuplicateDraft => {
    const flag = first((f) => f.type === 'select');
    const key = first((f) => f.key !== flag && f.type === 'text');
    return { key, flagField: flag, flagValue: 'Duplicada' };
  };
  return (
    <Section title="Duplicados">
      <Toggle
        label="Marcar filas repetidas"
        hint="Si dos filas traen el mismo valor en el campo clave, se marcan las dos con un valor que tú eliges, y la marca se quita sola al corregir."
        checked={Boolean(rule)}
        disabled={readOnly}
        onChange={(on) => onChange(on ? start() : null)}
      />
      {rule && (
        <div className="space-y-3 rounded-sm border border-border bg-surface-2/40 p-3">
          {hint && <p className="text-micro text-ink-muted">{hint}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Campo que no debe repetirse">
              <select
                value={rule.key}
                disabled={readOnly}
                onChange={(e) => onChange({ ...rule, key: e.target.value })}
                className={clsx(NATIVE, 'w-full')}
              >
                <option value="">Elige…</option>
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sólo si cambia… (opcional)" hint="Vacío: cualquier repetición se marca.">
              <select
                value={rule.distinctBy ?? ''}
                disabled={readOnly}
                onChange={(e) => onChange({ ...rule, distinctBy: e.target.value || undefined })}
                className={clsx(NATIVE, 'w-full')}
              >
                <option value="">Cualquier repetición</option>
                {fields
                  .filter((f) => f.key !== rule.key)
                  .map((f) => (
                    <option key={f.key} value={f.key}>
                      Con distinto «{f.label}»
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="Dónde se marca">
              <select
                value={rule.flagField}
                disabled={readOnly}
                onChange={(e) => onChange({ ...rule, flagField: e.target.value })}
                className={clsx(NATIVE, 'w-full')}
              >
                <option value="">Elige un campo de opciones o texto…</option>
                {flaggable.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Con qué valor">
              <input
                value={rule.flagValue}
                maxLength={80}
                disabled={readOnly}
                onChange={(e) => onChange({ ...rule, flagValue: e.target.value })}
                className={INPUT}
              />
            </Field>
          </div>
          {missing && (
            <button
              type="button"
              disabled={readOnly}
              onClick={() => onFields(withFlagOption(fields, rule))}
              className="inline-flex items-center gap-1 rounded-pill border border-primary/50 bg-primary-soft px-3 py-1 text-xs font-semibold text-primary"
            >
              <Plus className="h-3.5 w-3.5" /> Crear la opción «{rule.flagValue}» en «
              {fields.find((f) => f.key === missing)?.label}»
            </button>
          )}
          {problem && !missing && (
            <p className="flex items-start gap-1 text-xs text-rose">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {problem}
            </p>
          )}
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Sincronizaciones
// ---------------------------------------------------------------------------

export function SyncRules({
  syncs,
  savedFields,
  canSync,
  actions,
  onSaved,
}: {
  syncs: SchemaSyncInfo[];
  /** Los campos que la tabla tiene guardados: una clave tiene que ser uno de ellos. */
  savedFields: TrackerField[];
  canSync: boolean;
  actions: Pick<SchemaActions, 'updateSync' | 'syncNow'>;
  onSaved: (sync: SchemaSyncInfo) => void;
}) {
  return (
    <Section title="Se llena sola">
      {syncs.length === 0 ? (
        <p className="text-xs leading-relaxed text-ink-muted">
          Esta tabla no se llena desde una hoja ni una carpeta. Para conectarla, pídeselo a Cortex
          en el chat («llena esta tabla desde mi hoja de Google»); después aquí ajustas cuándo y
          cómo.
        </p>
      ) : (
        <ul className="space-y-3">
          {syncs.map((s) => (
            <SyncCard
              key={s.id}
              sync={s}
              savedFields={savedFields}
              canSync={canSync}
              actions={actions}
              onSaved={onSaved}
            />
          ))}
        </ul>
      )}
    </Section>
  );
}

function SyncCard({
  sync,
  savedFields,
  canSync,
  actions,
  onSaved,
}: {
  sync: SchemaSyncInfo;
  savedFields: TrackerField[];
  canSync: boolean;
  actions: Pick<SchemaActions, 'updateSync' | 'syncNow'>;
  onSaved: (sync: SchemaSyncInfo) => void;
}) {
  const [draft, setDraft] = useState(sync);
  const [pending, start] = useTransition();
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [running, setRunning] = useState(false);
  const dirty =
    draft.enabled !== sync.enabled ||
    draft.intervalMinutes !== sync.intervalMinutes ||
    draft.notify !== sync.notify ||
    draft.instructions !== sync.instructions ||
    draft.keyFields.join('|') !== sync.keyFields.join('|');
  const intervalIssue = intervalProblem(draft.intervalMinutes);
  const keyIssue = draft.keyFields.length === 0 ? 'Elige al menos una columna clave.' : null;
  const preset = SYNC_INTERVALS.some((i) => i.value === draft.intervalMinutes);

  function save() {
    setStatus(null);
    start(async () => {
      const patch: Parameters<SchemaActions['updateSync']>[2] = {};
      if (draft.enabled !== sync.enabled) patch.enabled = draft.enabled;
      if (draft.intervalMinutes !== sync.intervalMinutes)
        patch.intervalMinutes = draft.intervalMinutes;
      if (draft.notify !== sync.notify) patch.notify = draft.notify;
      if (draft.keyFields.join('|') !== sync.keyFields.join('|')) patch.keyFields = draft.keyFields;
      if (sync.kind === 'drive_folder' && draft.instructions !== sync.instructions)
        patch.instructions = draft.instructions;
      const r = await actions.updateSync(sync.kind, sync.id, patch);
      if (r.ok) {
        setDraft(r.sync);
        onSaved(r.sync);
        setStatus({ ok: true, text: 'Guardado.' });
      } else setStatus({ ok: false, text: r.error });
    });
  }

  async function runNow() {
    setRunning(true);
    setStatus(null);
    const r = await actions.syncNow(sync.kind, sync.id);
    setRunning(false);
    setStatus({ ok: r.ok, text: r.ok ? r.message : r.error });
  }

  return (
    <li className="space-y-3 rounded-card border border-border bg-surface p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{sync.source}</p>
          <p className="text-micro text-ink-faint">
            {sync.lastRunAt
              ? `Última vez: ${new Date(sync.lastRunAt).toLocaleString('es-CO')}`
              : 'Todavía no ha corrido'}
            {sync.lastError && <span className="text-rose"> · Error: {sync.lastError}</span>}
          </p>
        </div>
        <button
          type="button"
          onClick={runNow}
          disabled={!canSync || running || dirty}
          title={dirty ? 'Guarda los cambios primero' : undefined}
          className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong px-3 py-1.5 text-xs font-semibold text-ink-muted hover:text-ink disabled:opacity-40"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          Sincronizar ahora
        </button>
      </div>

      <Toggle
        label={draft.enabled ? 'Activa' : 'En pausa'}
        hint="En pausa no corre sola; «Sincronizar ahora» sigue disponible."
        checked={draft.enabled}
        disabled={!canSync}
        onChange={(enabled) => setDraft({ ...draft, enabled })}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Cada cuánto" hint={intervalIssue ?? undefined}>
          <div className="flex gap-1">
            <select
              value={preset ? draft.intervalMinutes : 'custom'}
              disabled={!canSync}
              onChange={(e) =>
                e.target.value !== 'custom' &&
                setDraft({ ...draft, intervalMinutes: Number(e.target.value) })
              }
              className={NATIVE}
            >
              {SYNC_INTERVALS.map((i) => (
                <option key={i.value} value={i.value}>
                  {i.label}
                </option>
              ))}
              <option value="custom">Otro…</option>
            </select>
            <input
              type="number"
              min={5}
              max={1440}
              aria-label="Minutos"
              value={draft.intervalMinutes}
              disabled={!canSync}
              onChange={(e) => setDraft({ ...draft, intervalMinutes: Number(e.target.value) })}
              className={clsx(INPUT, 'w-24 py-1', intervalIssue && 'border-rose')}
            />
          </div>
        </Field>
        <Toggle
          label="Avisar en la campana"
          hint="Cuando entran filas nuevas o hay algo por revisar."
          checked={draft.notify}
          disabled={!canSync}
          onChange={(notify) => setDraft({ ...draft, notify })}
        />
      </div>

      <div>
        <span className="field-label mb-1 block">Columnas clave (identifican cada fila)</span>
        <div className="flex flex-wrap gap-1.5">
          {savedFields.map((f) => {
            const on = draft.keyFields.includes(f.key);
            return (
              <button
                key={f.key}
                type="button"
                aria-pressed={on}
                disabled={!canSync}
                onClick={() =>
                  setDraft({
                    ...draft,
                    keyFields: on
                      ? draft.keyFields.filter((k) => k !== f.key)
                      : [...draft.keyFields, f.key].slice(0, 5),
                  })
                }
                className={clsx(
                  'inline-flex items-center gap-1 rounded-pill border px-2.5 py-1 text-xs font-semibold',
                  on
                    ? 'border-primary bg-primary-soft text-primary'
                    : 'border-border text-ink-muted hover:text-ink',
                )}
              >
                {on && <Check className="h-3 w-3" />} {f.label}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-micro text-ink-faint">
          Si cambias la clave, las filas que ya entraron se vuelven a leer como nuevas la próxima
          vez. Cámbiala sólo si sabes que la hoja repite las anteriores.
        </p>
        {keyIssue && <p className="text-xs text-rose">{keyIssue}</p>}
      </div>

      {sync.kind === 'drive_folder' && (
        <Field
          label="Instrucciones para leer los documentos"
          hint="Qué buscar y cómo interpretarlo (hasta 1000 letras)."
        >
          <textarea
            rows={4}
            maxLength={1000}
            value={draft.instructions}
            disabled={!canSync}
            onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
            className={INPUT}
          />
        </Field>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={!canSync || !dirty || pending || Boolean(intervalIssue) || Boolean(keyIssue)}
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          Guardar sincronización
        </button>
        {status && (
          <span
            aria-live="polite"
            className={clsx('text-xs', status.ok ? 'text-emerald' : 'text-rose')}
          >
            {status.text}
          </span>
        )}
      </div>
    </li>
  );
}
