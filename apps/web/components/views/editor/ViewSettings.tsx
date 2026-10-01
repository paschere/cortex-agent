'use client';

import {
  DENSITIES,
  DENSITY_LABEL,
  EDITING_LABEL,
  EDITING_MODES,
  type EditorFilterBarKind,
  type EditorTone,
  FILTER_BAR_KINDS,
  FILTER_BAR_KIND_LABEL,
  HEADER_LABEL,
  HEADER_STYLES,
  MAX_FILTER_BAR,
  MAX_VIEW_PAGES,
  REFRESH_CHOICES,
  REFRESH_LABEL,
  TONES,
  TONE_LABEL,
} from '@/lib/views/editor-shape';
import {
  type EditorDraft,
  type EditorProblem,
  type EditorSource,
  fieldOptions,
  newAlert,
  sourceOf,
  titleOf,
} from '@/lib/views/editor-spec';
import type { FilterBarItem, ViewAlert, ViewPage, ViewSpec } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlertTriangle, BellRing, Check, Filter, Layers, Plus } from 'lucide-react';
import { FiltersEditor } from './FiltersEditor';
import {
  AddButton,
  Field,
  FieldSelect,
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
 *
 * También: el aspecto (acento, densidad, cabecera con portada), la barra de
 * filtros de arriba (cada filtro sobre una fuente que algún bloque lee) y las
 * páginas (pestañas; cada una elige sus bloques, y los que no están en
 * ninguna salen en la primera).
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

      <AppearanceSection spec={spec} setSpec={setSpec} />

      <FilterBarSection spec={spec} sources={sources} setSpec={setSpec} />

      <PagesSection spec={spec} setSpec={setSpec} />

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

type SetSpec = (next: Partial<ViewSpec>, coalesce?: string) => void;

const SWATCH: Record<EditorTone, string> = {
  primary: 'bg-primary',
  emerald: 'bg-emerald',
  amber: 'bg-amber',
  sky: 'bg-sky',
  rose: 'bg-rose',
};

/** Acento, densidad y cabecera. Siempre tokens: nada de colores libres. */
function AppearanceSection({ spec, setSpec }: { spec: ViewSpec; setSpec: SetSpec }) {
  const theme = spec.theme ?? {};
  const accent = theme.accent ?? spec.accent;
  const setTheme = (next: Partial<NonNullable<ViewSpec['theme']>>, coalesce?: string) =>
    setSpec({ theme: { ...theme, ...next } }, coalesce);
  return (
    <Section title="Aspecto">
      <fieldset>
        <legend className="field-label mb-1">Color de acento</legend>
        <div className="flex gap-2">
          {TONES.map((t) => (
            <label
              key={t}
              title={TONE_LABEL[t]}
              className={clsx(
                'grid h-8 w-8 cursor-pointer place-items-center rounded-pill border-2 transition-colors duration-150 focus-within:ring-2 focus-within:ring-primary/50',
                accent === t ? 'border-ink' : 'border-transparent hover:border-border-strong',
              )}
            >
              <input
                type="radio"
                name="view-accent"
                className="sr-only"
                checked={accent === t}
                onChange={() => setTheme({ accent: t })}
              />
              <span className={clsx('h-5 w-5 rounded-pill', SWATCH[t])} />
              <span className="sr-only">{TONE_LABEL[t]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <Segmented
        label="Densidad"
        value={theme.density ?? 'comfortable'}
        options={DENSITIES.map((d) => ({ value: d, label: DENSITY_LABEL[d] }))}
        onChange={(density) => setTheme({ density })}
      />
      <Segmented
        label="Cabecera"
        value={theme.header ?? 'plain'}
        options={HEADER_STYLES.map((h) => ({ value: h, label: HEADER_LABEL[h] }))}
        onChange={(header) => setTheme({ header })}
      />
      {theme.header === 'hero' && (
        <Field label="Portada (opcional)" hint="La dirección https:// de una imagen ancha.">
          <input
            type="url"
            inputMode="url"
            placeholder="https://"
            maxLength={1000}
            value={theme.cover ?? ''}
            onChange={(e) => setTheme({ cover: e.target.value.trim() || undefined }, 'view:cover')}
            className={INPUT}
          />
        </Field>
      )}
    </Section>
  );
}

/** Las fuentes que algún bloque lee: un filtro sobre otra no tendría qué filtrar. */
function usedSources(spec: ViewSpec, sources: EditorSource[]): EditorSource[] {
  const used = new Set(spec.blocks.map(sourceOf).filter(Boolean) as string[]);
  return sources.filter((s) => used.has(s.slug));
}

function FilterBarSection({
  spec,
  sources,
  setSpec,
}: {
  spec: ViewSpec;
  sources: EditorSource[];
  setSpec: SetSpec;
}) {
  const bar = spec.filtersBar ?? [];
  const candidates = usedSources(spec, sources);
  const setBar = (next: FilterBarItem[], coalesce?: string) =>
    setSpec({ filtersBar: next.length ? next : undefined }, coalesce);
  const add = () => {
    const source = candidates[0];
    if (!source) return;
    const fields = fieldOptions(source);
    const field = fields.find((f) => f.type === 'select') ?? fields[0];
    const taken = new Set(bar.map((b) => b.id));
    let n = bar.length + 1;
    while (taken.has(`filtro_${n}`)) n++;
    setBar([
      ...bar,
      {
        id: `filtro_${n}`,
        label: field?.label.slice(0, 40) ?? 'Filtro',
        source: source.slug,
        field: field?.key ?? 'label',
        kind:
          field?.type === 'date' ? 'date_range' : field?.type === 'select' ? 'select' : 'search',
      },
    ]);
  };
  return (
    <Section
      title="Barra de filtros"
      action={
        <AddButton disabled={bar.length >= MAX_FILTER_BAR || !candidates.length} onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Agregar filtro
        </AddButton>
      }
    >
      {bar.length === 0 && (
        <p className="text-micro leading-relaxed text-ink-faint">
          Controles arriba de la vista («Sede», «Fechas», «Buscar cliente») que filtran todos los
          bloques de esa tabla a la vez. Quedan en el enlace, para compartir la vista filtrada.
        </p>
      )}
      {bar.map((item, i) => {
        const source = sources.find((s) => s.slug === item.source);
        const fields = fieldOptions(source).filter((f) =>
          item.kind === 'date_range' ? f.type === 'date' : f.type !== 'date',
        );
        const set = (next: Partial<FilterBarItem>, coalesce?: string) =>
          setBar(
            bar.map((b, j) => (j === i ? { ...b, ...next } : b)),
            coalesce,
          );
        return (
          <div
            key={item.id}
            className="space-y-2.5 rounded-sm border border-border bg-surface-2/60 p-2.5"
          >
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <input
                aria-label="Nombre del filtro"
                maxLength={40}
                value={item.label}
                onChange={(e) => set({ label: e.target.value }, `${item.id}:label`)}
                className={INPUT}
              />
              <RemoveButton
                label="Quitar este filtro"
                onClick={() => setBar(bar.filter((_, j) => j !== i))}
              />
            </div>
            <Field label="Tabla">
              <select
                value={item.source}
                onChange={(e) => {
                  const next = sources.find((s) => s.slug === e.target.value);
                  const first = fieldOptions(next).find((f) =>
                    item.kind === 'date_range' ? f.type === 'date' : f.type !== 'date',
                  );
                  set({ source: e.target.value, field: first?.key ?? 'label' });
                }}
                className={INPUT}
              >
                {!source && <option value={item.source}>{item.source} (no disponible)</option>}
                {candidates.map((s) => (
                  <option key={s.slug} value={s.slug}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Tipo">
                <select
                  value={item.kind}
                  onChange={(e) => {
                    const kind = e.target.value as EditorFilterBarKind;
                    const first = fieldOptions(source).find((f) =>
                      kind === 'date_range' ? f.type === 'date' : f.type !== 'date',
                    );
                    set({ kind, field: first?.key ?? item.field });
                  }}
                  className={INPUT}
                >
                  {FILTER_BAR_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {FILTER_BAR_KIND_LABEL[k]}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Campo">
                <FieldSelect
                  fields={fields}
                  value={item.field}
                  onChange={(field) => field && set({ field })}
                />
              </Field>
            </div>
          </div>
        );
      })}
    </Section>
  );
}

function PagesSection({ spec, setSpec }: { spec: ViewSpec; setSpec: SetSpec }) {
  const pages = spec.pages ?? [];
  const setPages = (next: ViewPage[], coalesce?: string) =>
    setSpec({ pages: next.length ? next : undefined }, coalesce);
  const add = () => {
    const taken = new Set(pages.map((p) => p.id));
    let n = pages.length + 1;
    while (taken.has(`pagina_${n}`)) n++;
    // La primera página nace con todos los bloques; las demás, vacías.
    const first: ViewPage[] = pages.length
      ? []
      : [{ id: 'resumen', title: 'Resumen', blockIds: spec.blocks.map((b) => b.id) }];
    setPages([...pages, ...first, { id: `pagina_${n}`, title: `Página ${n}`, blockIds: [] }]);
  };
  return (
    <Section
      title="Páginas"
      action={
        <AddButton disabled={pages.length >= MAX_VIEW_PAGES} onClick={add}>
          <Plus className="h-3.5 w-3.5" /> Agregar página
        </AddButton>
      }
    >
      {pages.length === 0 && (
        <p className="text-micro leading-relaxed text-ink-faint">
          Pestañas sobre la misma vista: «Resumen», «Detalle», «Por sede». Un bloque puede estar en
          varias; el que no esté en ninguna sale en la primera.
        </p>
      )}
      {pages.map((page, i) => {
        const set = (next: Partial<ViewPage>, coalesce?: string) =>
          setPages(
            pages.map((p, j) => (j === i ? { ...p, ...next } : p)),
            coalesce,
          );
        return (
          <div
            key={page.id}
            className="space-y-2 rounded-sm border border-border bg-surface-2/60 p-2.5"
          >
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 shrink-0 text-primary" aria-hidden />
              <input
                aria-label={`Nombre de la página ${i + 1}`}
                maxLength={40}
                value={page.title}
                onChange={(e) => set({ title: e.target.value }, `${page.id}:title`)}
                className={INPUT}
              />
              <RemoveButton
                label={`Quitar la página ${page.title}`}
                onClick={() => setPages(pages.filter((_, j) => j !== i))}
              />
            </div>
            <fieldset>
              <legend className="field-label mb-1">Bloques en esta página</legend>
              <ul className="space-y-1">
                {spec.blocks.map((b) => (
                  <li key={b.id}>
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink">
                      <input
                        type="checkbox"
                        checked={page.blockIds.includes(b.id)}
                        onChange={(e) =>
                          set({
                            blockIds: e.target.checked
                              ? [...page.blockIds, b.id]
                              : page.blockIds.filter((id) => id !== b.id),
                          })
                        }
                        className="h-4 w-4 accent-[rgb(var(--primary))]"
                      />
                      <span className="truncate">{titleOf(b)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </fieldset>
          </div>
        );
      })}
    </Section>
  );
}
