'use client';

import {
  CARD_CHIPS,
  CARD_CHIP_LABEL,
  TIMELINE_PARTS,
  TIMELINE_PART_LABEL,
} from '@/lib/views/editor-shape';
import { type EditorSource, type FieldOption, fieldOptions } from '@/lib/views/editor-spec';
import type { ViewBlock } from '@cortex/agent-tools';
import { Plus } from 'lucide-react';
import {
  AddButton,
  Field,
  FieldChips,
  FieldSelect,
  INPUT,
  NumberInput,
  RemoveButton,
  Segmented,
  Toggle,
} from './controls';

/**
 * Los controles de los tipos de pantalla nuevos en el inspector: la lista de
 * tarjetas con filtros rápidos y el detalle de un registro (secciones, galería,
 * relacionados con sus botones y línea de tiempo). Cada propiedad del spec
 * tiene su control con nombre de persona, igual que el resto del inspector.
 */

type Change = (next: ViewBlock, coalesce?: string) => void;
type Cards = Extract<ViewBlock, { type: 'cards' }>;
type Detail = Extract<ViewBlock, { type: 'detail' }>;

const isDate = (f: FieldOption) => f.type === 'date';
const text = (f: FieldOption) => !isDate(f);

export function CardsFields({
  block,
  source,
  onChange,
}: { block: Cards; source: EditorSource | undefined; onChange: Change }) {
  const fields = fieldOptions(source);
  const selects = fields.filter((f) => f.type === 'select');
  const dates = fields.filter(isDate);
  const own = fields.filter((f) => !f.builtin);
  const toggleChip = (chip: (typeof CARD_CHIPS)[number], on: boolean) => {
    const chips = on ? [...new Set([...block.chips, chip])] : block.chips.filter((c) => c !== chip);
    onChange({
      ...block,
      chips,
      // Hoy / semana necesitan una fecha; estado, un campo de opciones.
      dateField:
        on && (chip === 'today' || chip === 'week') && !block.dateField
          ? (dates.find((f) => !f.builtin)?.key ?? dates[0]?.key)
          : block.dateField,
      statusField:
        on && chip === 'status' && !block.statusField ? selects[0]?.key : block.statusField,
    });
  };
  return (
    <>
      <Field label="Título de cada tarjeta">
        <FieldSelect
          fields={fields.filter(text)}
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
      <Field label="Estado" hint="Un campo de opciones: chip con el color de cada opción.">
        <FieldSelect
          fields={selects}
          value={block.statusField}
          emptyLabel="Sin estado"
          onChange={(statusField) => onChange({ ...block, statusField })}
        />
      </Field>
      <Field
        label="Imagen"
        hint="Un campo de fotos, o de texto con la dirección https:// de la imagen."
      >
        <FieldSelect
          fields={own.filter((f) => f.type === 'text' || f.type === 'file')}
          value={block.imageField}
          emptyLabel="Sin imagen"
          onChange={(imageField) => onChange({ ...block, imageField })}
        />
      </Field>
      <FieldChips
        label="Datos de cada tarjeta"
        fields={fields.filter((f) => f.key !== 'label')}
        value={block.dataFields}
        max={4}
        emptyHint="Sólo el título y el estado."
        onChange={(dataFields) => onChange({ ...block, dataFields })}
      />
      <fieldset className="space-y-2">
        <legend className="field-label mb-1">Filtros rápidos (chips)</legend>
        {CARD_CHIPS.map((chip) => (
          <Toggle
            key={chip}
            label={CARD_CHIP_LABEL[chip]}
            hint={
              chip === 'mine'
                ? 'Lo que creó quien mira. No aparece en un enlace público.'
                : chip === 'status'
                  ? 'Un chip por cada opción del estado.'
                  : 'Sobre el campo de fecha de abajo.'
            }
            checked={block.chips.includes(chip)}
            disabled={
              (chip === 'status' && !selects.length) ||
              ((chip === 'today' || chip === 'week') && !dates.length)
            }
            onChange={(on) => toggleChip(chip, on)}
          />
        ))}
      </fieldset>
      {(block.chips.includes('today') || block.chips.includes('week')) && (
        <Field label="Fecha para hoy / esta semana">
          <FieldSelect
            fields={dates}
            value={block.dateField}
            onChange={(dateField) => dateField && onChange({ ...block, dateField })}
          />
        </Field>
      )}
      <Toggle
        label="Buscador"
        checked={block.searchable}
        onChange={(searchable) => onChange({ ...block, searchable })}
      />
      <Field label="Agrupar por" hint="Un título de grupo por cada valor.">
        <FieldSelect
          fields={own}
          value={block.groupBy}
          emptyLabel="Sin agrupar"
          onChange={(groupBy) => onChange({ ...block, groupBy })}
        />
      </Field>
      <FieldChips
        label="Orden que la persona puede elegir"
        fields={fields}
        value={block.sortOptions}
        max={4}
        emptyHint="Sin menú de orden."
        onChange={(sortOptions) => onChange({ ...block, sortOptions })}
      />
      <Segmented
        label="Cuando hay muchas"
        value={block.paging}
        options={[
          { value: 'more', label: 'Botón «Ver más»' },
          { value: 'infinite', label: 'Carga al final' },
        ]}
        onChange={(paging) => onChange({ ...block, paging })}
      />
      <div className="grid grid-cols-2 gap-2">
        <Field label="Por página">
          <NumberInput
            min={4}
            max={48}
            value={block.pageSize}
            onChange={(pageSize) =>
              onChange({ ...block, pageSize: pageSize ?? 12 }, `${block.id}:ps`)
            }
          />
        </Field>
        <Field label="Máximo">
          <NumberInput
            min={1}
            max={200}
            value={block.limit}
            onChange={(limit) => onChange({ ...block, limit: limit ?? 100 }, `${block.id}:lim`)}
          />
        </Field>
      </div>
    </>
  );
}

export function DetailFields({
  block,
  source,
  sources,
  onChange,
}: {
  block: Detail;
  source: EditorSource | undefined;
  sources: EditorSource[];
  onChange: Change;
}) {
  const fields = fieldOptions(source);
  const own = fields.filter((f) => !f.builtin);
  const selects = fields.filter((f) => f.type === 'select');
  const files = own.filter((f) => f.type === 'file');
  const set = (patch: Partial<Detail>, coalesce?: string) =>
    onChange({ ...block, ...patch } as ViewBlock, coalesce);
  const timelineOn = block.timeline !== false;
  const shown = block.timeline ? block.timeline.show : [...TIMELINE_PARTS];

  return (
    <>
      <Field label="Título del registro">
        <FieldSelect
          fields={fields.filter(text)}
          value={block.titleField}
          onChange={(titleField) => titleField && set({ titleField })}
        />
      </Field>
      <Field label="Subtítulo">
        <FieldSelect
          fields={fields}
          value={block.subtitleField}
          emptyLabel="Sin subtítulo"
          onChange={(subtitleField) => set({ subtitleField })}
        />
      </Field>
      <Field label="Estado" hint="Un campo de opciones: chip de color en la cabecera.">
        <FieldSelect
          fields={selects}
          value={block.statusField}
          emptyLabel="Sin estado"
          onChange={(statusField) => set({ statusField })}
        />
      </Field>

      <fieldset className="space-y-3">
        <legend className="field-label mb-1">Secciones de campos</legend>
        {block.sections.length === 0 && (
          <p className="text-micro text-ink-faint">
            Sin secciones: todos los campos en una sola (dentro de Cortex; por enlace público,
            ninguno).
          </p>
        )}
        {block.sections.map((section, i) => (
          <div
            key={`${section.title}-${i}`}
            className="space-y-2 rounded-sm border border-border p-2.5"
          >
            <div className="flex items-center gap-2">
              <input
                aria-label="Nombre de la sección"
                maxLength={60}
                value={section.title}
                onChange={(e) =>
                  set(
                    {
                      sections: block.sections.map((s, j) =>
                        j === i ? { ...s, title: e.target.value } : s,
                      ),
                    },
                    `${block.id}:sec${i}`,
                  )
                }
                className={INPUT}
              />
              <RemoveButton
                label="Quitar la sección"
                onClick={() => set({ sections: block.sections.filter((_, j) => j !== i) })}
              />
            </div>
            <FieldChips
              label="Campos"
              fields={own}
              value={section.fields}
              max={12}
              emptyHint="Elige al menos un campo."
              onChange={(next) =>
                set({
                  sections: block.sections.map((s, j) => (j === i ? { ...s, fields: next } : s)),
                })
              }
            />
          </div>
        ))}
        {block.sections.length < 6 && (
          <AddButton
            onClick={() =>
              set({
                sections: [
                  ...block.sections,
                  {
                    title: `Sección ${block.sections.length + 1}`,
                    fields: own.slice(0, 3).map((f) => f.key),
                  },
                ],
              })
            }
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar sección
          </AddButton>
        )}
      </fieldset>

      <FieldChips
        label="Fotos y documentos (galería)"
        fields={files}
        value={block.gallery}
        max={4}
        emptyHint={files.length ? 'Sin galería.' : 'La tabla no tiene campos de archivos.'}
        onChange={(gallery) => set({ gallery })}
      />

      <fieldset className="space-y-3">
        <legend className="field-label mb-1">Registros relacionados</legend>
        {block.related.map((rel, i) => {
          const other = sources.find((s) => s.slug === rel.tracker);
          const otherFields = fieldOptions(other);
          const patch = (p: Partial<(typeof block.related)[number]>, coalesce?: string) =>
            set({ related: block.related.map((r, j) => (j === i ? { ...r, ...p } : r)) }, coalesce);
          return (
            <div key={rel.id} className="space-y-2 rounded-sm border border-border p-2.5">
              <div className="flex items-center gap-2">
                <input
                  aria-label="Título de la lista"
                  maxLength={60}
                  value={rel.title}
                  onChange={(e) => patch({ title: e.target.value }, `${block.id}:rel${i}`)}
                  className={INPUT}
                />
                <RemoveButton
                  label="Quitar la lista"
                  onClick={() => set({ related: block.related.filter((_, j) => j !== i) })}
                />
              </div>
              <Field label="De la tabla">
                <select
                  value={rel.tracker}
                  onChange={(e) =>
                    patch({ tracker: e.target.value, field: 'label', columns: [], actions: [] })
                  }
                  className={INPUT}
                >
                  {sources
                    .filter((s) => !s.opaque)
                    .map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Segmented
                label="Se relacionan por"
                value={rel.match}
                options={[
                  { value: 'relation', label: 'Un campo relación' },
                  { value: 'value', label: 'Un valor común' },
                ]}
                onChange={(match) =>
                  patch({
                    match,
                    parentField: match === 'value' ? (rel.parentField ?? 'label') : undefined,
                  })
                }
              />
              <Field
                label={
                  rel.match === 'relation' ? 'Campo relación de esa tabla' : 'Campo de esa tabla'
                }
                hint={
                  rel.match === 'relation'
                    ? `Apunta a ${source?.name ?? 'este registro'}.`
                    : 'Su valor tiene que ser igual al del campo de este registro.'
                }
              >
                <FieldSelect
                  fields={
                    rel.match === 'relation'
                      ? otherFields.filter((f) => f.type === 'relation')
                      : otherFields.filter((f) => f.type !== 'file')
                  }
                  value={rel.field}
                  onChange={(field) => field && patch({ field })}
                />
              </Field>
              {rel.match === 'value' && (
                <Field label="Campo de este registro">
                  <FieldSelect
                    fields={fields.filter((f) => f.type !== 'file')}
                    value={rel.parentField}
                    onChange={(parentField) => parentField && patch({ parentField })}
                  />
                </Field>
              )}
              <FieldChips
                label="Columnas"
                fields={otherFields.filter((f) => !f.builtin || f.key === 'label')}
                value={rel.columns}
                max={4}
                emptyHint="Las primeras tres."
                onChange={(columns) => patch({ columns })}
              />
              <Field label="Máximo de filas">
                <NumberInput
                  min={1}
                  max={30}
                  value={rel.limit}
                  onChange={(limit) => patch({ limit: limit ?? 10 }, `${block.id}:rl${i}`)}
                />
              </Field>
            </div>
          );
        })}
        {block.related.length < 4 && (
          <AddButton
            onClick={() => {
              const other = sources.find((s) => s.slug !== block.tracker && !s.opaque) ?? source;
              const rel = fieldOptions(other).find((f) => f.type === 'relation');
              set({
                related: [
                  ...block.related,
                  {
                    id: `lista${block.related.length + 1}`,
                    title: other?.name ?? 'Relacionados',
                    tracker: other?.slug ?? block.tracker,
                    field: rel?.key ?? 'label',
                    match: rel ? 'relation' : 'value',
                    parentField: rel ? undefined : 'label',
                    columns: [],
                    limit: 10,
                    actions: [],
                  },
                ],
              });
            }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar lista relacionada
          </AddButton>
        )}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="field-label mb-1">Línea de tiempo</legend>
        <Toggle
          label="Mostrar la historia del registro"
          hint="Sólo cuenta los campos que las secciones muestran."
          checked={timelineOn}
          onChange={(on) => set({ timeline: on ? undefined : false })}
        />
        {timelineOn &&
          TIMELINE_PARTS.map((part) => (
            <Toggle
              key={part}
              label={TIMELINE_PART_LABEL[part]}
              hint={
                part === 'automations'
                  ? 'Sólo para quien es del equipo, nunca para clientes.'
                  : undefined
              }
              checked={shown.includes(part)}
              onChange={(on) => {
                const next = on ? [...new Set([...shown, part])] : shown.filter((p) => p !== part);
                if (!next.length) return;
                const limit = block.timeline ? block.timeline.limit : 30;
                set({ timeline: { show: next, limit } });
              }}
            />
          ))}
      </fieldset>
    </>
  );
}
