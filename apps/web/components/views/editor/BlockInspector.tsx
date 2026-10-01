'use client';

import {
  AGGREGATES,
  AGGREGATE_LABEL,
  BUCKETS,
  BUCKET_LABEL,
  CHART_KINDS,
  CHART_LABEL,
  type EditorAggregate,
  type EditorTone,
  FORMATS,
  FORMAT_LABEL,
  TONES,
  TONE_LABEL,
  WIDTHS,
  WIDTH_LABEL,
} from '@/lib/views/editor-shape';
import {
  type EditorSource,
  fieldOptions,
  isNumericField,
  sourceOf,
  withSource,
} from '@/lib/views/editor-spec';
import type { RowAction, ViewBlock, ViewFilter } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlertTriangle, Lock } from 'lucide-react';
import { useId } from 'react';
import { ActionsEditor } from './ActionsEditor';
import { FiltersEditor } from './FiltersEditor';
import {
  Field,
  FieldChips,
  FieldSelect,
  INPUT,
  NumberInput,
  Section,
  Segmented,
  SourceSelect,
  Toggle,
} from './controls';

/**
 * EL INSPECTOR DE UN BLOQUE: SUS PROPIEDADES CON CONTROLES DE VERDAD.
 *
 * Cada propiedad del contrato tiene aquí un control con nombre de persona —
 * «Agrupar por», «Qué cuenta», «Se puede arrastrar»— y ningún JSON. Lo que no
 * se puede en una fuente (escribir en ventas, un tablero sin campo de
 * opciones) no se esconde: sale deshabilitado con el motivo, porque un
 * control que desaparece no enseña nada.
 *
 * `onChange(next, key)`: `key` agrupa las pulsaciones de un mismo campo de
 * texto en un solo paso de deshacer (ver ViewEditor).
 */

type Change = (next: ViewBlock, coalesce?: string) => void;
type Editing = 'off' | 'team' | 'public';

/** El plano (`zones`) se edita como un tablero; se tipa suelto para no atarse a su forma exacta. */
interface BoardLike {
  id: string;
  type: 'board' | 'zones';
  tracker: string;
  filters: ViewFilter[];
  title: string;
  groupBy: string;
  cardFields: string[];
  limit: number;
  draggable: boolean;
  actions: RowAction[];
  layout?: unknown[];
}

export function BlockInspector({
  block,
  sources,
  problems,
  editing,
  onChange,
  onAllowEditing,
}: {
  block: ViewBlock;
  sources: EditorSource[];
  problems: string[];
  editing: Editing;
  onChange: Change;
  onAllowEditing: () => void;
}) {
  const ref = sourceOf(block);
  const source = ref ? sources.find((s) => s.slug === ref) : undefined;
  const key = (prop: string) => `${block.id}:${prop}`;

  return (
    <div className="space-y-4">
      {problems.length > 0 && (
        <div
          aria-live="polite"
          className="rounded-sm border border-amber/40 bg-amber-soft px-3 py-2 text-xs leading-relaxed text-ink"
        >
          <p className="mb-1 flex items-center gap-1.5 font-semibold text-amber">
            <AlertTriangle className="h-3.5 w-3.5" /> Por corregir
          </p>
          <ul className="list-disc space-y-0.5 pl-4">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      <Section title="Contenido">
        {'title' in block && typeof block.title === 'string' && (
          <Field label="Título">
            <input
              value={block.title}
              maxLength={120}
              onChange={(e) =>
                onChange({ ...block, title: e.target.value } as ViewBlock, key('title'))
              }
              className={INPUT}
            />
          </Field>
        )}
        {block.type === 'text' && (
          <Field label="Texto" hint="## para un título, **negrita**, - para una lista.">
            <textarea
              rows={8}
              maxLength={4000}
              value={block.markdown}
              onChange={(e) => onChange({ ...block, markdown: e.target.value }, key('markdown'))}
              className={clsx(INPUT, 'font-mono text-xs leading-relaxed')}
            />
          </Field>
        )}
        <Segmented
          label="Ancho"
          value={block.width}
          options={WIDTHS.map((w) => ({ value: w, label: WIDTH_LABEL[w].long }))}
          onChange={(width) => onChange({ ...block, width } as ViewBlock)}
        />
      </Section>

      {ref && (
        <Section title="Datos">
          <Field
            label="Fuente"
            hint={
              source?.readOnly
                ? source.kind === 'feed'
                  ? 'Del Feed: sólo tú ves sus filas, y la vista no se podrá compartir por enlace.'
                  : 'Datos de Cortex: de sólo lectura.'
                : source?.sensitivity === 'internal'
                  ? 'Nombra gente del equipo: la vista no se podrá compartir por enlace.'
                  : undefined
            }
          >
            <SourceSelect
              sources={sources}
              value={ref}
              blockType={block.type}
              onChange={(next) => onChange(withSource(block, next))}
            />
          </Field>
          <TypeFields block={block} source={source} onChange={onChange} />
        </Section>
      )}

      {'filters' in block && Array.isArray(block.filters) && (
        <Section title="Filtros">
          <FiltersEditor
            source={source}
            filters={block.filters}
            max={8}
            onChange={(filters) => onChange({ ...block, filters } as ViewBlock, key('filters'))}
          />
        </Section>
      )}

      <Interaction
        block={block}
        source={source}
        editing={editing}
        onChange={onChange}
        onAllowEditing={onAllowEditing}
      />

      {block.type === 'form' && (
        <Section title="Formulario">
          <FieldChips
            label="Campos que pide"
            fields={fieldOptions(source).filter((f) => !f.builtin)}
            value={block.fields}
            max={20}
            emptyHint="Todos los campos de la tabla."
            onChange={(fields) => onChange({ ...block, fields })}
          />
          <Field label="Introducción">
            <textarea
              rows={3}
              maxLength={400}
              value={block.intro ?? ''}
              onChange={(e) =>
                onChange({ ...block, intro: e.target.value || undefined }, key('intro'))
              }
              className={INPUT}
            />
          </Field>
          <Field label="Texto del botón">
            <input
              maxLength={40}
              value={block.submitLabel}
              onChange={(e) => onChange({ ...block, submitLabel: e.target.value }, key('submit'))}
              className={INPUT}
            />
          </Field>
          <Field label="Mensaje al enviar">
            <input
              maxLength={200}
              value={block.successMessage}
              onChange={(e) =>
                onChange({ ...block, successMessage: e.target.value }, key('success'))
              }
              className={INPUT}
            />
          </Field>
        </Section>
      )}
    </div>
  );
}

function TypeFields({
  block,
  source,
  onChange,
}: {
  block: ViewBlock;
  source: EditorSource | undefined;
  onChange: Change;
}) {
  const fields = fieldOptions(source);
  const numeric = fields.filter(isNumericField);
  switch (block.type) {
    case 'metric':
      return (
        <>
          <AggregatePicker
            aggregate={block.aggregate}
            field={block.field}
            numeric={numeric}
            onChange={(aggregate, field) =>
              onChange({
                ...block,
                aggregate,
                field,
                format:
                  aggregate !== 'count' && numeric.find((f) => f.key === field)?.type === 'money'
                    ? 'money'
                    : block.format,
              })
            }
          />
          <Segmented
            label="Formato"
            value={block.format}
            options={FORMATS.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))}
            onChange={(format) => onChange({ ...block, format })}
          />
          <Field label="Meta (opcional)" hint="La cifra se pinta contra ella con una barra.">
            <NumberInput
              value={block.goal}
              onChange={(goal) => onChange({ ...block, goal }, `${block.id}:goal`)}
            />
          </Field>
          <ToneSwatches value={block.tone} onChange={(tone) => onChange({ ...block, tone })} />
          <Field label="Nota bajo la cifra (opcional)">
            <input
              maxLength={200}
              value={block.caption ?? ''}
              onChange={(e) =>
                onChange({ ...block, caption: e.target.value || undefined }, `${block.id}:caption`)
              }
              className={INPUT}
            />
          </Field>
        </>
      );
    case 'chart': {
      const groupType = fields.find((f) => f.key === block.groupBy)?.type;
      return (
        <>
          <Segmented
            label="Tipo de gráfico"
            value={block.chart}
            options={CHART_KINDS.map((c) => ({ value: c, label: CHART_LABEL[c] }))}
            onChange={(chart) => onChange({ ...block, chart })}
          />
          <Field label="Agrupar por">
            <FieldSelect
              fields={fields}
              value={block.groupBy}
              onChange={(groupBy) => groupBy && onChange({ ...block, groupBy })}
            />
          </Field>
          {groupType === 'date' && (
            <Segmented
              label="Fechas"
              value={block.bucket}
              options={BUCKETS.map((b) => ({ value: b, label: BUCKET_LABEL[b] }))}
              onChange={(bucket) => onChange({ ...block, bucket })}
            />
          )}
          {block.chart === 'line' && groupType !== 'date' && (
            <p className="text-micro text-amber">La línea se lee mejor agrupando por una fecha.</p>
          )}
          <AggregatePicker
            aggregate={block.aggregate}
            field={block.field}
            numeric={numeric}
            onChange={(aggregate, field) => onChange({ ...block, aggregate, field })}
          />
          <Segmented
            label="Formato"
            value={block.format}
            options={FORMATS.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))}
            onChange={(format) => onChange({ ...block, format })}
          />
          <Field label="Máximo de barras o puntos">
            <NumberInput
              min={2}
              max={24}
              value={block.limit}
              onChange={(limit) => onChange({ ...block, limit: limit ?? 12 }, `${block.id}:limit`)}
            />
          </Field>
          <ToneSwatches value={block.tone} onChange={(tone) => onChange({ ...block, tone })} />
        </>
      );
    }
    case 'table':
      return (
        <>
          <FieldChips
            label="Columnas"
            fields={fields}
            value={block.columns}
            max={10}
            emptyHint="Automáticas: el nombre y los primeros cinco campos."
            onChange={(columns) => onChange({ ...block, columns })}
          />
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
            <Field label="Ordenar por">
              <FieldSelect
                fields={fields}
                value={block.sort?.field}
                emptyLabel="Lo más reciente primero"
                onChange={(field) =>
                  onChange({
                    ...block,
                    sort: field ? { field, dir: block.sort?.dir ?? 'desc' } : undefined,
                  })
                }
              />
            </Field>
            {block.sort && (
              <Segmented
                label="Dirección"
                hideLabel
                size="sm"
                value={block.sort.dir}
                options={[
                  { value: 'desc', label: 'Mayor primero' },
                  { value: 'asc', label: 'Menor primero' },
                ]}
                onChange={(dir) =>
                  block.sort && onChange({ ...block, sort: { field: block.sort.field, dir } })
                }
              />
            )}
          </div>
          <Field label="Máximo de filas">
            <NumberInput
              min={1}
              max={200}
              value={block.limit}
              onChange={(limit) => onChange({ ...block, limit: limit ?? 50 }, `${block.id}:limit`)}
            />
          </Field>
          <Toggle
            label="Buscador"
            hint="Una caja para buscar dentro de la tabla."
            checked={block.searchable}
            onChange={(searchable) => onChange({ ...block, searchable })}
          />
        </>
      );
    case 'form':
      return null;
    default: {
      const loose = block as unknown as BoardLike;
      if (loose.type !== 'board' && loose.type !== 'zones') return null;
      const zones = loose.type === 'zones';
      const selects = fields.filter((f) => f.type === 'select');
      return (
        <>
          <Field
            label={zones ? 'Zonas según' : 'Columnas según'}
            hint={
              selects.length
                ? `Cada opción es ${zones ? 'una zona del plano' : 'una columna'}.`
                : 'Esta fuente no tiene un campo de opciones.'
            }
          >
            <FieldSelect
              fields={selects}
              value={loose.groupBy}
              onChange={(groupBy) =>
                groupBy &&
                onChange({
                  ...loose,
                  groupBy,
                  ...(zones ? { layout: [] } : {}),
                } as unknown as ViewBlock)
              }
            />
          </Field>
          <FieldChips
            label={zones ? 'Datos de cada ficha' : 'Datos de cada tarjeta'}
            fields={fields.filter((f) => f.key !== loose.groupBy && f.key !== 'label')}
            value={loose.cardFields}
            max={zones ? 2 : 4}
            emptyHint="Sólo el nombre de la fila."
            onChange={(cardFields) => onChange({ ...loose, cardFields } as unknown as ViewBlock)}
          />
          <Field label={zones ? 'Máximo de fichas por zona' : 'Máximo de tarjetas por columna'}>
            <NumberInput
              min={1}
              max={zones ? 40 : 60}
              value={loose.limit}
              onChange={(limit) =>
                onChange(
                  { ...loose, limit: limit ?? (zones ? 20 : 30) } as unknown as ViewBlock,
                  `${loose.id}:limit`,
                )
              }
            />
          </Field>
          {zones && (
            <p className="text-micro leading-relaxed text-ink-faint">
              Las zonas se acomodan solas en filas de tres. Para dibujarlas como tu bodega o tu
              plataforma, pídeselo a Cortex abajo: «pon el muelle 1 arriba a la izquierda».
            </p>
          )}
        </>
      );
    }
  }
}

function AggregatePicker({
  aggregate,
  field,
  numeric,
  onChange,
}: {
  aggregate: EditorAggregate;
  field: string | undefined;
  numeric: ReturnType<typeof fieldOptions>;
  onChange: (aggregate: EditorAggregate, field: string | undefined) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <Field label="Qué calcula">
        <select
          value={aggregate}
          onChange={(e) => {
            const next = e.target.value as EditorAggregate;
            onChange(next, next === 'count' ? undefined : (field ?? numeric[0]?.key));
          }}
          className={INPUT}
        >
          {AGGREGATES.map((a) => (
            <option key={a} value={a} disabled={a !== 'count' && numeric.length === 0}>
              {AGGREGATE_LABEL[a]}
            </option>
          ))}
        </select>
      </Field>
      {aggregate !== 'count' && (
        <Field label="De qué campo">
          <FieldSelect fields={numeric} value={field} onChange={(f) => onChange(aggregate, f)} />
        </Field>
      )}
    </div>
  );
}

const SWATCH: Record<EditorTone, string> = {
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  sky: 'bg-sky',
  rose: 'bg-rose',
};

function ToneSwatches({
  value,
  onChange,
}: { value: EditorTone; onChange: (t: EditorTone) => void }) {
  const name = useId();
  return (
    <fieldset>
      <legend className="field-label mb-1">Color</legend>
      <div className="flex gap-2">
        {TONES.map((t) => (
          <label
            key={t}
            title={TONE_LABEL[t]}
            className={clsx(
              'grid h-8 w-8 cursor-pointer place-items-center rounded-pill border-2 transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary/50',
              value === t ? 'border-ink' : 'border-transparent hover:border-border-strong',
            )}
          >
            <input
              type="radio"
              name={name}
              className="sr-only"
              checked={value === t}
              onChange={() => onChange(t)}
            />
            <span className={clsx('h-5 w-5 rounded-pill', SWATCH[t])} />
            <span className="sr-only">{TONE_LABEL[t]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Celdas editables, arrastrar y botones: sólo en tablas propias, y sólo si alguien tiene permiso. */
function Interaction({
  block,
  source,
  editing,
  onChange,
  onAllowEditing,
}: {
  block: ViewBlock;
  source: EditorSource | undefined;
  editing: Editing;
  onChange: Change;
  onAllowEditing: () => void;
}) {
  const loose = block as unknown as { type: string };
  const isTable = block.type === 'table';
  const isBoard = loose.type === 'board' || loose.type === 'zones';
  if (!isTable && !isBoard) return null;
  const readOnly = !source || source.readOnly;
  const fields = fieldOptions(source).filter((f) => !f.builtin);
  const board = block as unknown as BoardLike;
  const writes = isTable
    ? block.type === 'table' && (block.editable.length > 0 || block.actions.length > 0)
    : board.draggable || board.actions.length > 0;

  return (
    <Section title="Interacción">
      {readOnly ? (
        <p className="flex items-start gap-1.5 text-micro leading-relaxed text-ink-faint">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" />
          Esta fuente es de sólo lectura: sus filas no se editan desde una vista.
        </p>
      ) : (
        <>
          {block.type === 'table' && (
            <FieldChips
              label="Columnas que se editan en el sitio"
              fields={fields}
              value={block.editable}
              max={10}
              emptyHint="Ninguna: la tabla sólo se lee."
              onChange={(editable) => onChange({ ...block, editable })}
            />
          )}
          {isBoard && (
            <Toggle
              label={board.type === 'zones' ? 'Mover fichas entre zonas' : 'Arrastrar tarjetas'}
              hint="Mover una tarjeta cambia su campo de opciones."
              checked={board.draggable}
              onChange={(draggable) => onChange({ ...board, draggable } as unknown as ViewBlock)}
            />
          )}
          <div>
            <span className="field-label mb-1 block">Botones en cada fila</span>
            <ActionsEditor
              source={source}
              actions={isTable && block.type === 'table' ? block.actions : board.actions}
              onChange={(actions) =>
                onChange({ ...block, actions } as ViewBlock, `${block.id}:actions`)
              }
            />
          </div>
          {writes && editing === 'off' && (
            <div className="rounded-sm border border-amber/40 bg-amber-soft px-3 py-2 text-xs text-ink">
              <p>Nadie tiene permiso para editar esta vista todavía.</p>
              <button
                type="button"
                onClick={onAllowEditing}
                className="mt-1 font-semibold text-primary hover:underline"
              >
                Permitir que el equipo edite
              </button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
