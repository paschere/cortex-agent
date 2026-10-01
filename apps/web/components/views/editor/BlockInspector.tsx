'use client';

import {
  AGGREGATES,
  AGGREGATE_LABEL,
  BUCKETS,
  BUCKET_LABEL,
  CALENDAR_MODES,
  CALENDAR_MODE_LABEL,
  CHART_KINDS,
  CHART_LABEL,
  type EditorAggregate,
  type EditorTone,
  FORMATS,
  FORMAT_LABEL,
  GALLERY_COLUMNS,
  LINK_STYLES,
  LINK_STYLE_LABEL,
  MEDIA_ASPECTS,
  MEDIA_KINDS,
  MEDIA_KIND_LABEL,
  PERIODS,
  PERIOD_LABEL,
  RECORD_BLOCK_TYPES,
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
import { normalizeLayout } from '@/lib/views/zone-layout';
import type { RowAction, ViewBlock, ViewFilter } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlertTriangle, Lock, Plus } from 'lucide-react';
import { useId } from 'react';
import { ActionsEditor } from './ActionsEditor';
import { FiltersEditor } from './FiltersEditor';
import { ZoneDrawer } from './ZoneDrawer';
import {
  AddButton,
  Field,
  FieldChips,
  FieldSelect,
  INPUT,
  NumberInput,
  RemoveButton,
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
        {(block.type === 'media' || block.type === 'links') && (
          <Field label="Título (opcional)">
            <input
              value={block.title ?? ''}
              maxLength={120}
              onChange={(e) =>
                onChange({ ...block, title: e.target.value || undefined }, key('title'))
              }
              className={INPUT}
            />
          </Field>
        )}
        {'title' in block &&
          typeof block.title === 'string' &&
          block.type !== 'media' &&
          block.type !== 'links' && (
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
        {block.type === 'media' && <MediaFields block={block} onChange={onChange} />}
        {block.type === 'links' && <LinksFields block={block} onChange={onChange} />}
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

      <RecordSection block={block} source={source} onChange={onChange} />

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
  const dates = fields.filter(isDateField);
  const selects = fields.filter((f) => f.type === 'select');
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
          <Toggle
            label="Comparar con el período anterior"
            hint="La cifra pasa a ser la del período, con flecha y una línea de los últimos."
            checked={Boolean(block.compare)}
            disabled={!dates.length}
            onChange={(on) =>
              onChange(
                on
                  ? {
                      ...block,
                      compare: 'previous_period',
                      period: block.period ?? 'month',
                      dateField:
                        block.dateField ?? dates.find((f) => !f.builtin)?.key ?? dates[0]?.key,
                    }
                  : { ...block, compare: undefined },
              )
            }
          />
          {block.compare && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Según la fecha">
                  <FieldSelect
                    fields={dates}
                    value={block.dateField}
                    onChange={(dateField) => dateField && onChange({ ...block, dateField })}
                  />
                </Field>
                <Field label="Período">
                  <select
                    value={block.period ?? 'month'}
                    onChange={(e) =>
                      onChange({ ...block, period: e.target.value as (typeof PERIODS)[number] })
                    }
                    className={INPUT}
                  >
                    {PERIODS.map((p) => (
                      <option key={p} value={p}>
                        {PERIOD_LABEL[p]}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Segmented
                label="Subir es"
                value={block.goodWhen ?? 'up'}
                options={[
                  { value: 'up', label: 'Bueno (ventas)' },
                  { value: 'down', label: 'Malo (devoluciones)' },
                ]}
                onChange={(goodWhen) => onChange({ ...block, goodWhen })}
              />
            </>
          )}
        </>
      );
    case 'gallery':
      return (
        <>
          <Field label="Título de cada tarjeta">
            <FieldSelect
              fields={fields.filter((f) => !isDateField(f))}
              value={block.titleField}
              onChange={(titleField) => titleField && onChange({ ...block, titleField })}
            />
          </Field>
          <Field label="Subtítulo">
            <FieldSelect
              fields={fields}
              value={block.subtitleField}
              emptyLabel="Sin subtítulo"
              onChange={(subtitleField) => onChange({ ...block, subtitleField })}
            />
          </Field>
          <FieldChips
            label="Datos de cada tarjeta"
            fields={fields.filter((f) => f.key !== 'label')}
            value={block.metaFields}
            max={3}
            emptyHint="Sólo el título y el subtítulo."
            onChange={(metaFields) => onChange({ ...block, metaFields })}
          />
          <Field label="Etiqueta de color" hint="Cada opción con su color.">
            <FieldSelect
              fields={selects}
              value={block.badgeField}
              emptyLabel="Sin etiqueta"
              onChange={(badgeField) => onChange({ ...block, badgeField })}
            />
          </Field>
          <Field
            label="Foto"
            hint="Un campo de texto con la dirección https:// de la imagen. Las demás no se muestran."
          >
            <FieldSelect
              fields={fields.filter((f) => f.type === 'text' && !f.builtin)}
              value={block.imageField}
              emptyLabel="Sin foto"
              onChange={(imageField) => onChange({ ...block, imageField })}
            />
          </Field>
          <Segmented
            label="Tarjetas por fila"
            value={block.columns}
            options={GALLERY_COLUMNS.map((c) => ({ value: c, label: String(c) }))}
            onChange={(columns) => onChange({ ...block, columns })}
          />
          <SortPicker
            fields={fields}
            sort={block.sort}
            onChange={(sort) => onChange({ ...block, sort })}
          />
          <Field label="Máximo de tarjetas">
            <NumberInput
              min={1}
              max={48}
              value={block.limit}
              onChange={(limit) => onChange({ ...block, limit: limit ?? 12 }, `${block.id}:limit`)}
            />
          </Field>
        </>
      );
    case 'calendar':
      return (
        <>
          <Segmented
            label="Cómo se ve"
            value={block.mode}
            options={CALENDAR_MODES.map((m) => ({ value: m, label: CALENDAR_MODE_LABEL[m] }))}
            onChange={(mode) => onChange({ ...block, mode })}
          />
          <Field label="Fecha de cada evento">
            <FieldSelect
              fields={dates}
              value={block.dateField}
              onChange={(dateField) => dateField && onChange({ ...block, dateField })}
            />
          </Field>
          <Field label="Nombre de cada evento">
            <FieldSelect
              fields={fields.filter((f) => !isDateField(f))}
              value={block.labelField}
              onChange={(labelField) => labelField && onChange({ ...block, labelField })}
            />
          </Field>
          <Field label="Color según" hint="Un campo de opciones: cada opción con su color.">
            <FieldSelect
              fields={selects}
              value={block.colorField}
              emptyLabel="Un solo color"
              onChange={(colorField) => onChange({ ...block, colorField })}
            />
          </Field>
          {block.mode === 'agenda' && (
            <Field label="Días hacia adelante" hint="Contando hoy, hasta 60.">
              <NumberInput
                min={1}
                max={60}
                value={block.days}
                onChange={(days) => onChange({ ...block, days: days ?? 14 }, `${block.id}:days`)}
              />
            </Field>
          )}
        </>
      );
    case 'progress': {
      const groupOptions = selects.find((f) => f.key === block.groupBy)?.options ?? [];
      return (
        <>
          <Field label="Una barra por" hint="Sin agrupar, es una sola barra contra la meta.">
            <FieldSelect
              fields={fields.filter((f) => !isNumericField(f))}
              value={block.groupBy}
              emptyLabel="Sin agrupar: una sola barra"
              onChange={(groupBy) =>
                onChange({
                  ...block,
                  groupBy,
                  targets: [],
                  target: groupBy ? block.target : (block.target ?? 100),
                })
              }
            />
          </Field>
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
          <Field
            label={block.groupBy ? 'Meta común (opcional)' : 'Meta'}
            hint={
              block.groupBy
                ? 'Sin ninguna meta, cada barra se compara con la más grande.'
                : undefined
            }
          >
            <NumberInput
              min={0}
              value={block.target}
              onChange={(target) =>
                onChange(
                  { ...block, target: target && target > 0 ? target : undefined },
                  `${block.id}:target`,
                )
              }
            />
          </Field>
          {groupOptions.length > 0 && (
            <fieldset className="space-y-1.5">
              <legend className="field-label mb-1">Meta de cada grupo (opcional)</legend>
              {groupOptions.slice(0, 24).map((group) => {
                const current = block.targets.find((t) => t.group === group)?.target;
                return (
                  <div
                    key={group}
                    className="grid grid-cols-[minmax(0,1fr)_7rem] items-center gap-2"
                  >
                    <span className="truncate text-xs text-ink">{group}</span>
                    <NumberInput
                      ariaLabel={`Meta de ${group}`}
                      min={0}
                      value={current}
                      placeholder={block.target ? String(block.target) : '—'}
                      onChange={(target) =>
                        onChange(
                          {
                            ...block,
                            targets: [
                              ...block.targets.filter((t) => t.group !== group),
                              ...(target && target > 0 ? [{ group, target }] : []),
                            ],
                          },
                          `${block.id}:targets:${group}`,
                        )
                      }
                    />
                  </div>
                );
              })}
            </fieldset>
          )}
          <Segmented
            label="Formato"
            value={block.format}
            options={FORMATS.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))}
            onChange={(format) => onChange({ ...block, format })}
          />
          {block.groupBy && (
            <Field label="Máximo de barras">
              <NumberInput
                min={1}
                max={24}
                value={block.limit}
                onChange={(limit) => onChange({ ...block, limit: limit ?? 8 }, `${block.id}:limit`)}
              />
            </Field>
          )}
          <ToneSwatches value={block.tone} onChange={(tone) => onChange({ ...block, tone })} />
        </>
      );
    }
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
          <SortPicker
            fields={fields}
            sort={block.sort}
            onChange={(sort) => onChange({ ...block, sort })}
          />
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
            <div className="space-y-1.5">
              <ZoneDrawer
                zones={selects.find((f) => f.key === loose.groupBy)?.options ?? []}
                layout={normalizeLayout(
                  loose.layout,
                  selects.find((f) => f.key === loose.groupBy)?.options ?? [],
                )}
                onChange={(layout) => onChange({ ...loose, layout } as unknown as ViewBlock)}
              />
              <p className="text-micro leading-relaxed text-ink-faint">
                Sin dibujo, las zonas se acomodan solas en filas de tres. También puedes pedírselo a
                Cortex: «pon el muelle 1 arriba a la izquierda».
              </p>
            </div>
          )}
        </>
      );
    }
  }
}

const isDateField = (f: ReturnType<typeof fieldOptions>[number]) => f.type === 'date';

function SortPicker({
  fields,
  sort,
  onChange,
}: {
  fields: ReturnType<typeof fieldOptions>;
  sort: { field: string; dir: 'asc' | 'desc' } | undefined;
  onChange: (sort: { field: string; dir: 'asc' | 'desc' } | undefined) => void;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-2">
      <Field label="Ordenar por">
        <FieldSelect
          fields={fields}
          value={sort?.field}
          emptyLabel="Lo más reciente primero"
          onChange={(field) => onChange(field ? { field, dir: sort?.dir ?? 'desc' } : undefined)}
        />
      </Field>
      {sort && (
        <Segmented
          label="Dirección"
          hideLabel
          size="sm"
          value={sort.dir}
          options={[
            { value: 'desc', label: 'Mayor primero' },
            { value: 'asc', label: 'Menor primero' },
          ]}
          onChange={(dir) => onChange({ field: sort.field, dir })}
        />
      )}
    </div>
  );
}

type MediaBlock = Extract<ViewBlock, { type: 'media' }>;
type LinksBlock = Extract<ViewBlock, { type: 'links' }>;

/** Imagen o inserción: una dirección, nunca HTML. El servidor la valida en la vista previa. */
function MediaFields({ block, onChange }: { block: MediaBlock; onChange: Change }) {
  return (
    <>
      <Segmented
        label="Qué es"
        value={block.kind}
        options={MEDIA_KINDS.map((k) => ({ value: k, label: MEDIA_KIND_LABEL[k] }))}
        onChange={(kind) => onChange({ ...block, kind })}
      />
      <Field
        label="Dirección"
        hint={
          block.kind === 'embed'
            ? 'YouTube, Loom, «Insertar un mapa» de Google Maps, o Google Slides/Docs publicados en la web.'
            : 'La dirección https:// de la imagen.'
        }
      >
        <input
          type="url"
          inputMode="url"
          placeholder="https://"
          maxLength={1000}
          value={block.url ?? ''}
          onChange={(e) =>
            onChange({ ...block, url: e.target.value.trim() || undefined }, `${block.id}:url`)
          }
          className={INPUT}
        />
      </Field>
      {block.kind === 'image' && (
        <Field label="Qué muestra la imagen" hint="Para quien no la ve (lector de pantalla).">
          <input
            maxLength={200}
            value={block.alt ?? ''}
            onChange={(e) =>
              onChange({ ...block, alt: e.target.value || undefined }, `${block.id}:alt`)
            }
            className={INPUT}
          />
        </Field>
      )}
      <Field label="Pie (opcional)">
        <input
          maxLength={300}
          value={block.caption ?? ''}
          onChange={(e) =>
            onChange({ ...block, caption: e.target.value || undefined }, `${block.id}:caption`)
          }
          className={INPUT}
        />
      </Field>
      <Segmented
        label="Proporción"
        value={block.aspect}
        options={MEDIA_ASPECTS.map((a) => ({ value: a, label: a }))}
        onChange={(aspect) => onChange({ ...block, aspect })}
      />
    </>
  );
}

/** Los botones de navegación: hasta ocho, cada uno a una ruta de Cortex o a una página https. */
function LinksFields({ block, onChange }: { block: LinksBlock; onChange: Change }) {
  const set = (i: number, patch: Partial<LinksBlock['links'][number]>) =>
    onChange(
      { ...block, links: block.links.map((l, j) => (j === i ? { ...l, ...patch } : l)) },
      `${block.id}:links:${i}`,
    );
  return (
    <>
      <Segmented
        label="Estilo"
        value={block.style}
        options={LINK_STYLES.map((s) => ({ value: s, label: LINK_STYLE_LABEL[s] }))}
        onChange={(style) => onChange({ ...block, style })}
      />
      <div className="space-y-2">
        <span className="field-label block">Botones</span>
        {block.links.map((link, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: los botones no tienen id; el orden es su identidad.
            key={i}
            className="space-y-2 rounded-sm border border-border bg-surface-2/60 p-2.5"
          >
            <div className="flex items-center gap-2">
              <input
                aria-label={`Texto del botón ${i + 1}`}
                maxLength={40}
                value={link.label}
                onChange={(e) => set(i, { label: e.target.value })}
                className={INPUT}
              />
              <RemoveButton
                label={`Quitar el botón ${link.label || i + 1}`}
                onClick={() =>
                  block.links.length > 1 &&
                  onChange({ ...block, links: block.links.filter((_, j) => j !== i) })
                }
              />
            </div>
            <input
              aria-label={`Destino del botón ${i + 1}`}
              placeholder="/views/cartera o https://…"
              maxLength={1000}
              value={link.href}
              onChange={(e) => set(i, { href: e.target.value.trim() })}
              className={INPUT}
            />
            <input
              aria-label={`Descripción del botón ${i + 1}`}
              placeholder="Una línea (opcional)"
              maxLength={120}
              value={link.description ?? ''}
              onChange={(e) => set(i, { description: e.target.value || undefined })}
              className={INPUT}
            />
            <select
              aria-label={`Color del botón ${i + 1}`}
              value={link.tone}
              onChange={(e) => set(i, { tone: e.target.value as EditorTone })}
              className={INPUT}
            >
              {TONES.map((t) => (
                <option key={t} value={t}>
                  {TONE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
        ))}
        <AddButton
          disabled={block.links.length >= 8}
          onClick={() =>
            onChange({
              ...block,
              links: [...block.links, { label: 'Nuevo botón', href: '/views', tone: 'primary' }],
            })
          }
        >
          <Plus className="h-3.5 w-3.5" /> Agregar botón
        </AddButton>
      </div>
    </>
  );
}

type RecordLike = {
  id: string;
  type: string;
  openRecord?: boolean;
  detailFields?: string[];
};

/** La ficha de una fila: si se abre y qué campos muestra. */
function RecordSection({
  block,
  source,
  onChange,
}: {
  block: ViewBlock;
  source: EditorSource | undefined;
  onChange: Change;
}) {
  if (!(RECORD_BLOCK_TYPES as readonly string[]).includes(block.type)) return null;
  const loose = block as unknown as RecordLike;
  const on = loose.openRecord !== false;
  return (
    <Section title="Ficha de cada fila">
      <Toggle
        label="Abrir la ficha al tocar una fila"
        hint="Un panel con todos los campos, sus botones y cuándo cambió."
        checked={on}
        onChange={(next) =>
          onChange({ ...block, openRecord: next ? undefined : false } as ViewBlock)
        }
      />
      {on && (
        <FieldChips
          label="Campos de la ficha"
          fields={fieldOptions(source).filter((f) => !f.builtin)}
          value={loose.detailFields ?? []}
          max={16}
          emptyHint={
            source?.readOnly
              ? 'Los primeros ocho campos. Por enlace, sólo los que el bloque ya muestra.'
              : 'Todos los campos. Por enlace, sólo los que el bloque ya muestra.'
          }
          onChange={(detailFields) =>
            onChange({
              ...block,
              detailFields: detailFields.length ? detailFields : undefined,
            } as ViewBlock)
          }
        />
      )}
    </Section>
  );
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

/**
 * Celdas editables, campos que se editan en la ficha, arrastrar y botones:
 * sólo en tablas propias, y sólo si alguien tiene permiso.
 */
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
  const loose = block as unknown as {
    type: string;
    draggable?: boolean;
    actions?: RowAction[];
    recordEditable?: string[];
    openRecord?: boolean;
  };
  const isBoard = loose.type === 'board' || loose.type === 'zones';
  if (!(RECORD_BLOCK_TYPES as readonly string[]).includes(loose.type)) return null;
  const readOnly = !source || source.readOnly;
  const fields = fieldOptions(source).filter((f) => !f.builtin);
  const board = block as unknown as BoardLike;
  const actions = loose.actions ?? [];
  const recordEditable = loose.recordEditable ?? [];
  const writes =
    actions.length > 0 ||
    recordEditable.length > 0 ||
    (block.type === 'table' && block.editable.length > 0) ||
    (isBoard && board.draggable);

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
          {loose.openRecord !== false && (
            <FieldChips
              label="Campos que se editan en la ficha"
              fields={fields}
              value={recordEditable}
              max={12}
              emptyHint="Ninguno: la ficha sólo se lee."
              onChange={(next) =>
                onChange({
                  ...block,
                  recordEditable: next.length ? next : undefined,
                } as ViewBlock)
              }
            />
          )}
          <div>
            <span className="field-label mb-1 block">Botones en cada fila</span>
            <ActionsEditor
              source={source}
              actions={actions}
              onChange={(next) =>
                onChange({ ...block, actions: next } as ViewBlock, `${block.id}:actions`)
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
