'use client';

import {
  EDITING_LABEL,
  EDITING_MODES,
  REFRESH_CHOICES,
  REFRESH_LABEL,
} from '@/lib/views/editor-shape';
import {
  type EditorDraft,
  type EditorProblem,
  type EditorSource,
  newAlert,
} from '@/lib/views/editor-spec';
import type { ViewAlert, ViewSpec } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlertTriangle, BellRing, Check, Plus } from 'lucide-react';
import { FiltersEditor } from './FiltersEditor';
import {
  AddButton,
  Field,
  INPUT,
  RemoveButton,
  Section,
  Segmented,
  SourceSelect,
  Toggle,
} from './controls';

/**
 * LO QUE ES DE LA VISTA ENTERA Y NO DE UN BLOQUE: cómo se llama, cada cuánto
 * se refresca, quién puede cambiar filas desde ella y cuándo avisa.
 *
 * «Quién puede editar» va con la explicación de lo que ve cada quien, no con
 * `off/team/public`: abrir la edición al enlace es una decisión con peso, y se
 * toma leyendo lo que significa.
 */

type Change = (next: EditorDraft, coalesce?: string) => void;

export function ViewSettings({
  draft,
  sources,
  problems,
  onChange,
}: {
  draft: EditorDraft;
  sources: EditorSource[];
  /** Los problemas que no son de un bloque: de la vista o de sus avisos. */
  problems: EditorProblem[];
  onChange: Change;
}) {
  const spec = draft.spec;
  const setSpec = (next: Partial<ViewSpec>, coalesce?: string) =>
    onChange({ ...draft, spec: { ...spec, ...next } }, coalesce);
  const general = problems.filter((p) => !p.alertId);

  return (
    <div className="space-y-4">
      {general.length > 0 && (
        <div className="rounded-sm border border-amber/40 bg-amber-soft px-3 py-2 text-xs leading-relaxed text-ink">
          {general.map((p) => (
            <p key={p.message} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" />
              {p.message}
            </p>
          ))}
        </div>
      )}

      <Section title="Nombre">
        <Field label="Cómo se llama">
          <input
            value={draft.name}
            maxLength={80}
            onChange={(e) => onChange({ ...draft, name: e.target.value }, 'view:name')}
            className={INPUT}
          />
        </Field>
        <Field label="Una línea bajo el título (opcional)">
          <input
            value={spec.subtitle ?? ''}
            maxLength={300}
            onChange={(e) => setSpec({ subtitle: e.target.value || undefined }, 'view:subtitle')}
            className={INPUT}
          />
        </Field>
        <Field label="Para qué es (opcional)" hint="Se ve en la lista de vistas.">
          <textarea
            rows={2}
            value={draft.description}
            maxLength={500}
            onChange={(e) =>
              onChange({ ...draft, description: e.target.value }, 'view:description')
            }
            className={INPUT}
          />
        </Field>
      </Section>

      <Section title="En vivo">
        <Segmented
          label="Se actualiza sola"
          value={spec.refreshSeconds}
          options={REFRESH_CHOICES.map((r) => ({ value: r, label: REFRESH_LABEL[r] }))}
          onChange={(refreshSeconds) => setSpec({ refreshSeconds })}
        />
        <p className="text-micro text-ink-faint">
          Mientras la pestaña está abierta y visible. Una pestaña escondida no consulta.
        </p>
      </Section>

      <Section title="Quién puede cambiar filas">
        <fieldset className="space-y-1.5">
          <legend className="sr-only">Quién puede cambiar filas desde la vista</legend>
          {EDITING_MODES.map((mode) => (
            <label
              key={mode}
              className={clsx(
                'flex cursor-pointer items-start gap-2.5 rounded-sm border px-3 py-2 transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary/40',
                spec.editing === mode
                  ? 'border-primary bg-primary-soft/40'
                  : 'border-border hover:bg-surface-2',
              )}
            >
              <input
                type="radio"
                name="view-editing"
                className="sr-only"
                checked={spec.editing === mode}
                onChange={() => setSpec({ editing: mode })}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-ink">
                  {EDITING_LABEL[mode].title}
                </span>
                <span className="block text-micro text-ink-muted">{EDITING_LABEL[mode].body}</span>
              </span>
              {spec.editing === mode && <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
            </label>
          ))}
        </fieldset>
      </Section>

      <Section
        title="Avisos"
        action={
          <AddButton
            disabled={spec.alerts.length >= 5}
            onClick={() => {
              const alert = newAlert(spec, sources);
              if (alert) setSpec({ alerts: [...spec.alerts, alert] });
            }}
          >
            <Plus className="h-3.5 w-3.5" /> Agregar aviso
          </AddButton>
        }
      >
        {spec.alerts.length === 0 && (
          <p className="text-micro leading-relaxed text-ink-faint">
            Que suene cuando entra algo nuevo: «una factura de más de 5 millones», «una guía
            retenida».
          </p>
        )}
        {spec.alerts.map((alert, i) => (
          <AlertCard
            key={alert.id}
            alert={alert}
            sources={sources}
            problems={problems.filter((p) => p.alertId === alert.id).map((p) => p.message)}
            onChange={(next, coalesce) =>
              setSpec({ alerts: spec.alerts.map((a, j) => (j === i ? next : a)) }, coalesce)
            }
            onRemove={() => setSpec({ alerts: spec.alerts.filter((_, j) => j !== i) })}
          />
        ))}
      </Section>
    </div>
  );
}

function AlertCard({
  alert,
  sources,
  problems,
  onChange,
  onRemove,
}: {
  alert: ViewAlert;
  sources: EditorSource[];
  problems: string[];
  onChange: (next: ViewAlert, coalesce?: string) => void;
  onRemove: () => void;
}) {
  const source = sources.find((s) => s.slug === alert.source);
  return (
    <div className="space-y-2.5 rounded-sm border border-border bg-surface-2/60 p-2.5">
      <div className="flex items-center gap-2">
        <BellRing className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          {alert.message || `Nuevo en ${source?.name ?? alert.source}`}
        </span>
        <RemoveButton label="Quitar este aviso" onClick={onRemove} />
      </div>
      {problems.map((p) => (
        <p key={p} className="text-micro text-amber">
          {p}
        </p>
      ))}
      <Field label="Cuando entra algo nuevo en">
        <SourceSelect
          sources={sources}
          value={alert.source}
          blockType="alert"
          onChange={(next) => onChange({ ...alert, source: next.slug, filters: [] })}
        />
      </Field>
      <div>
        <span className="field-label mb-1 block">Y cumple</span>
        <FiltersEditor
          source={source}
          filters={alert.filters}
          max={4}
          onChange={(filters) => onChange({ ...alert, filters }, `${alert.id}:filters`)}
        />
      </div>
      <Field label="Mensaje (opcional)">
        <input
          value={alert.message ?? ''}
          maxLength={120}
          placeholder={`Nuevo en ${source?.name ?? 'la tabla'}`}
          onChange={(e) =>
            onChange({ ...alert, message: e.target.value || undefined }, `${alert.id}:message`)
          }
          className={INPUT}
        />
      </Field>
      <div className="space-y-2">
        <Toggle
          label="Sonido"
          checked={alert.sound}
          onChange={(sound) => onChange({ ...alert, sound })}
        />
        <Toggle
          label="Notificación del sistema"
          hint="Si quien mira la permite en su navegador."
          checked={alert.desktop}
          onChange={(desktop) => onChange({ ...alert, desktop })}
        />
        <Toggle
          label="Campana de Cortex"
          hint="Cuando la fila entra por un formulario de esta vista, aunque nadie la tenga abierta."
          checked={alert.bell}
          onChange={(bell) => onChange({ ...alert, bell })}
        />
      </div>
    </div>
  );
}
