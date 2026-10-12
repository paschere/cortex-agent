'use client';

import { saveTablerosAction, suggestTablerosAction } from '@/lib/apps/phase6-actions';
import type { Tablero, Widget } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Plus,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type AppEditorData, BTN_PRIMARY, BTN_SECONDARY, CARD, ErrorLine, INPUT } from './shared';

/**
 * «TABLEROS» (0225): una pantalla de indicadores por rol. Cifras con su
 * micrográfico y cambio, un gráfico con rangos y zoom, el reparto por estado,
 * un ranking y «mis pendientes». Cada rol ve SÓLO sus filas (el mismo scope de
 * las demás pantallas) y un widget sobre una tabla sin permiso desaparece.
 * Los cambios caen en el borrador: los usuarios los ven al publicar.
 */

const KIND_LABEL: Record<Widget['kind'], string> = {
  kpi: 'Cifra',
  chart: 'Gráfico en el tiempo',
  status: 'Reparto por estado',
  ranking: 'Ranking',
  pending: 'Pendientes',
};
const OPS: Array<{ value: string; label: string; valueless?: boolean }> = [
  { value: 'eq', label: 'es igual a' },
  { value: 'neq', label: 'es distinto de' },
  { value: 'contains', label: 'contiene' },
  { value: 'gt', label: 'mayor que' },
  { value: 'lt', label: 'menor que' },
  { value: 'empty', label: 'está vacío', valueless: true },
  { value: 'not_empty', label: 'tiene valor', valueless: true },
  { value: 'before_today', label: 'fecha ya pasó', valueless: true },
  { value: 'after_today', label: 'fecha futura', valueless: true },
  { value: 'last_days', label: 'en los últimos (días)' },
];
const SELECT = `${INPUT} pr-7`;
const BUILTIN = [
  { key: 'created_at', label: 'Fecha de creación', type: 'date' },
  { key: 'updated_at', label: 'Última actualización', type: 'date' },
];

function slugId(base: string, taken: string[]): string {
  const root =
    base
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24) || 'tablero';
  const start = /^[a-z]/.test(root) ? root : `t_${root}`;
  if (!taken.includes(start)) return start;
  for (let i = 2; i < 99; i++) if (!taken.includes(`${start}_${i}`)) return `${start}_${i}`;
  return `${start}_${Date.now() % 100000}`;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: el control llega como hijo
    <label className="flex min-w-0 flex-col gap-1 text-micro font-semibold text-ink-muted">
      {label}
      {children}
    </label>
  );
}

function WidgetForm({
  w,
  data,
  onChange,
}: {
  w: Widget;
  data: AppEditorData;
  onChange: (next: Widget) => void;
}) {
  const tracker = data.homeTrackers.find((t) => t.slug === w.source);
  const fields = tracker?.fields ?? [];
  const numeric = fields.filter((f) => f.type === 'number' || f.type === 'money');
  const dates = [...fields.filter((f) => f.type === 'date'), ...BUILTIN];
  const selects = fields.filter((f) => f.type === 'select');
  const set = (patch: Record<string, unknown>) => onChange({ ...w, ...patch } as Widget);
  const filters = w.filters ?? [];
  return (
    <div className="grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
      <Field label="Título">
        <input
          className={INPUT}
          value={w.title}
          maxLength={80}
          onChange={(e) => set({ title: e.target.value })}
        />
      </Field>
      <Field label="Tabla">
        <select
          className={SELECT}
          value={w.source}
          onChange={(e) => set({ source: e.target.value, field: undefined, filters: [] })}
        >
          {data.homeTrackers.map((t) => (
            <option key={t.slug} value={t.slug}>
              {t.name}
            </option>
          ))}
        </select>
      </Field>

      {(w.kind === 'kpi' || w.kind === 'chart' || w.kind === 'ranking') && (
        <>
          <Field label="Qué calcula">
            <select
              className={SELECT}
              value={w.aggregate}
              onChange={(e) => set({ aggregate: e.target.value })}
            >
              <option value="count">Cuántos registros</option>
              <option value="sum">Suma de un campo</option>
              {w.kind === 'kpi' && <option value="avg">Promedio de un campo</option>}
            </select>
          </Field>
          {w.aggregate !== 'count' && (
            <Field label="Campo numérico">
              <select
                className={SELECT}
                value={w.field ?? ''}
                onChange={(e) => set({ field: e.target.value || undefined })}
              >
                <option value="">Elige…</option>
                {numeric.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </>
      )}
      {w.kind === 'kpi' && (
        <>
          <Field label="Período">
            <select
              className={SELECT}
              value={w.period}
              onChange={(e) => set({ period: e.target.value })}
            >
              <option value="day">Hoy vs. ayer</option>
              <option value="week">Esta semana vs. la anterior</option>
              <option value="month">Este mes vs. el anterior</option>
              <option value="all">Todo lo que cumpla (sin período)</option>
            </select>
          </Field>
          <Field label="Subir es…">
            <select
              className={SELECT}
              value={w.goodWhen}
              onChange={(e) => set({ goodWhen: e.target.value })}
            >
              <option value="up">Bueno (ventas, entregas)</option>
              <option value="down">Malo (atrasos, devoluciones)</option>
            </select>
          </Field>
          <Field label="Meta (opcional)">
            <input
              className={INPUT}
              type="number"
              value={w.goal ?? ''}
              onChange={(e) =>
                set({ goal: e.target.value === '' ? undefined : Number(e.target.value) })
              }
            />
          </Field>
        </>
      )}
      {(w.kind === 'kpi' || w.kind === 'chart' || w.kind === 'pending') && (
        <Field label="Fecha que usa">
          <select
            className={SELECT}
            value={w.dateField ?? ''}
            onChange={(e) => set({ dateField: e.target.value || undefined })}
          >
            <option value="">{w.kind === 'pending' ? 'Ninguna' : 'Fecha de creación'}</option>
            {dates.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      {w.kind === 'chart' && (
        <Field label="Los registros se llaman">
          <input
            className={INPUT}
            placeholder="guías, facturas…"
            maxLength={30}
            value={w.noun ?? ''}
            onChange={(e) => set({ noun: e.target.value || undefined })}
          />
        </Field>
      )}
      {w.kind === 'status' && (
        <Field label="Campo de opciones">
          <select
            className={SELECT}
            value={w.field}
            onChange={(e) => set({ field: e.target.value })}
          >
            <option value="">Elige…</option>
            {selects.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      {w.kind === 'ranking' && (
        <>
          <Field label="Agrupar por">
            <select
              className={SELECT}
              value={w.groupBy}
              onChange={(e) => set({ groupBy: e.target.value })}
            >
              <option value="">Elige…</option>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cuántos mostrar">
            <input
              className={INPUT}
              type="number"
              min={2}
              max={10}
              value={w.limit}
              onChange={(e) =>
                set({ limit: Math.min(10, Math.max(2, Number(e.target.value) || 6)) })
              }
            />
          </Field>
        </>
      )}
      {w.kind === 'pending' && (
        <>
          <Field label="Segundo renglón">
            <select
              className={SELECT}
              value={w.subtitleField ?? ''}
              onChange={(e) => set({ subtitleField: e.target.value || undefined })}
            >
              <option value="">Ninguno</option>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Cuántos mostrar">
            <input
              className={INPUT}
              type="number"
              min={1}
              max={10}
              value={w.limit}
              onChange={(e) =>
                set({ limit: Math.min(10, Math.max(1, Number(e.target.value) || 5)) })
              }
            />
          </Field>
        </>
      )}

      <Field label="Ancho">
        <select
          className={SELECT}
          value={w.width ?? ''}
          onChange={(e) => set({ width: e.target.value || undefined })}
        >
          <option value="">Automático</option>
          <option value="third">Un tercio</option>
          <option value="half">La mitad</option>
          <option value="full">Todo el ancho</option>
        </select>
      </Field>
      <Field label="Al tocarlo abre">
        <select
          className={SELECT}
          value={w.screen ?? ''}
          onChange={(e) => set({ screen: e.target.value || undefined })}
        >
          <option value="">Nada</option>
          {data.screens.map((s) => (
            <option key={s.slug} value={s.slug}>
              {s.title}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Solo lo mío">
        <select
          className={SELECT}
          value={w.mine ? (w.mine.by === 'creator' ? 'creator' : `field:${w.mine.field}`) : ''}
          onChange={(e) => {
            const v = e.target.value;
            set({
              mine: !v
                ? undefined
                : v === 'creator'
                  ? { by: 'creator' }
                  : { by: 'field', field: v.slice(6) },
            });
          }}
        >
          <option value="">No: todo lo que el rol puede ver</option>
          <option value="creator">Lo que yo registré</option>
          {fields
            .filter((f) => f.type === 'text' || f.type === 'select')
            .map((f) => (
              <option key={f.key} value={`field:${f.key}`}>
                Donde «{f.label}» soy yo
              </option>
            ))}
        </select>
      </Field>

      <div className="space-y-2 sm:col-span-2">
        <div className="flex items-center justify-between">
          <span className="text-micro font-semibold text-ink-muted">Filtros</span>
          <button
            type="button"
            className="text-xs font-semibold text-primary hover:underline"
            disabled={filters.length >= 6}
            onClick={() =>
              set({
                filters: [...filters, { field: fields[0]?.key ?? 'label', op: 'eq', value: '' }],
              })
            }
          >
            + Filtro
          </button>
        </div>
        {filters.map((f, i) => {
          const op = OPS.find((o) => o.value === f.op);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: filas sin id propio
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select
                className={SELECT}
                value={f.field}
                onChange={(e) =>
                  set({
                    filters: filters.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)),
                  })
                }
              >
                {[{ key: 'label', label: 'Nombre' }, ...fields, ...BUILTIN].map((x) => (
                  <option key={x.key} value={x.key}>
                    {x.label}
                  </option>
                ))}
              </select>
              <select
                className={SELECT}
                value={f.op}
                onChange={(e) =>
                  set({
                    filters: filters.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)),
                  })
                }
              >
                {OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {!op?.valueless && (
                <input
                  className={clsx(INPUT, 'w-36')}
                  value={f.value ?? ''}
                  placeholder="valor"
                  onChange={(e) =>
                    set({
                      filters: filters.map((x, j) =>
                        j === i ? { ...x, value: e.target.value } : x,
                      ),
                    })
                  }
                />
              )}
              <button
                type="button"
                aria-label="Quitar filtro"
                className="text-ink-faint hover:text-rose"
                onClick={() => set({ filters: filters.filter((_, j) => j !== i) })}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function newWidget(kind: Widget['kind'], source: string, taken: string[]): Widget {
  let n = 1;
  while (taken.includes(`${kind}${n}`)) n++;
  const base = { id: `${kind}${n}`, title: KIND_LABEL[kind], source, filters: [] };
  switch (kind) {
    case 'kpi':
      return {
        ...base,
        kind,
        aggregate: 'count',
        period: 'month',
        goodWhen: 'up',
        tone: 'primary',
      };
    case 'chart':
      return { ...base, kind, aggregate: 'count', goodWhen: 'up', tone: 'primary' };
    case 'status':
      return { ...base, kind, field: '' };
    case 'ranking':
      return { ...base, kind, groupBy: '', aggregate: 'count', limit: 6, tone: 'primary' };
    case 'pending':
      return { ...base, kind, limit: 5 };
  }
}

export function TablerosTab({ data }: { data: AppEditorData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [tableros, setTableros] = useState<Tablero[]>(data.dashboards ?? []);
  const [open, setOpen] = useState<string | null>(null);
  const firstTracker = data.homeTrackers[0]?.slug ?? '';

  function edit(next: Tablero[]) {
    setSaved(false);
    setTableros(next);
  }
  function patch(id: string, change: Partial<Tablero>) {
    edit(tableros.map((t) => (t.id === id ? { ...t, ...change } : t)));
  }
  function save() {
    setError(null);
    start(async () => {
      const res = await saveTablerosAction(data.app.id, tableros);
      if (!res.ok) return setError(res.error);
      setSaved(true);
      router.refresh();
    });
  }
  function suggest() {
    setError(null);
    start(async () => {
      const res = await suggestTablerosAction(data.app.id);
      if (!res.ok) return setError(res.error);
      edit(res.tableros);
      setOpen(res.tableros[0]?.id ?? null);
    });
  }

  return (
    <div className="space-y-4">
      <div className={clsx(CARD, 'space-y-1')}>
        <h3 className="text-sm font-semibold text-ink">Tableros por rol</h3>
        <p className="text-xs text-ink-muted">
          Una pantalla de indicadores para cada rol: «lo mío hoy» para el operario, «equipo y
          atrasos» para el supervisor, «indicadores» para gerencia. Cada quien ve sólo sus filas.
          Los cambios quedan en el borrador hasta que publiques.
        </p>
      </div>

      {tableros.length === 0 && (
        <div className="rounded-card border border-dashed border-border-strong bg-surface px-4 py-8 text-center text-sm text-ink-muted">
          Todavía no hay tableros.{' '}
          <button
            type="button"
            className="font-semibold text-primary hover:underline"
            onClick={suggest}
          >
            Sugerir uno por rol
          </button>
        </div>
      )}

      {tableros.map((t) => {
        const isOpen = open === t.id;
        return (
          <section key={t.id} className={clsx(CARD, 'space-y-3')}>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-label={isOpen ? 'Cerrar' : 'Abrir'}
                onClick={() => setOpen(isOpen ? null : t.id)}
                className="text-ink-faint hover:text-ink"
              >
                {isOpen ? (
                  <ChevronDown className="h-4 w-4" aria-hidden />
                ) : (
                  <ChevronRight className="h-4 w-4" aria-hidden />
                )}
              </button>
              <input
                className={clsx(INPUT, 'min-w-48 flex-1 font-semibold')}
                value={t.title}
                maxLength={60}
                aria-label="Nombre del tablero"
                onChange={(e) => patch(t.id, { title: e.target.value })}
              />
              <span className="text-xs text-ink-faint">{t.widgets.length} widgets</span>
              <button
                type="button"
                aria-label="Quitar tablero"
                className="text-ink-faint hover:text-rose"
                onClick={() => edit(tableros.filter((x) => x.id !== t.id))}
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-micro font-semibold text-ink-muted">Lo ven:</span>
              {data.roles.map((r) => {
                const on = t.roles.includes(r.key);
                return (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      patch(t.id, {
                        roles: on ? t.roles.filter((k) => k !== r.key) : [...t.roles, r.key],
                      })
                    }
                    className={clsx(
                      'rounded-pill border px-2.5 py-1 text-xs font-semibold transition-colors',
                      on
                        ? 'border-primary bg-primary-soft text-primary-ink'
                        : 'border-border text-ink-muted hover:text-ink',
                    )}
                  >
                    {r.name}
                  </button>
                );
              })}
              {t.roles.length === 0 && (
                <span className="text-xs text-ink-faint">todos los roles</span>
              )}
            </div>

            {isOpen && (
              <div className="space-y-2">
                {t.widgets.map((w, i) => (
                  <details
                    key={w.id}
                    className="rounded-card border border-border bg-surface-2/40 px-3 py-2"
                  >
                    <summary className="flex cursor-pointer items-center gap-2 text-sm">
                      <span className="rounded-pill bg-primary-soft px-2 py-0.5 text-micro font-semibold text-primary-ink">
                        {KIND_LABEL[w.kind]}
                      </span>
                      <span className="min-w-0 flex-1 truncate font-semibold text-ink">
                        {w.title}
                      </span>
                      <span className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label="Subir"
                          disabled={i === 0}
                          className="text-ink-faint hover:text-ink disabled:opacity-30"
                          onClick={(e) => {
                            e.preventDefault();
                            const ws = [...t.widgets];
                            const [x] = ws.splice(i, 1);
                            if (x) ws.splice(i - 1, 0, x);
                            patch(t.id, { widgets: ws });
                          }}
                        >
                          <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          aria-label="Bajar"
                          disabled={i === t.widgets.length - 1}
                          className="text-ink-faint hover:text-ink disabled:opacity-30"
                          onClick={(e) => {
                            e.preventDefault();
                            const ws = [...t.widgets];
                            const [x] = ws.splice(i, 1);
                            if (x) ws.splice(i + 1, 0, x);
                            patch(t.id, { widgets: ws });
                          }}
                        >
                          <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        <button
                          type="button"
                          aria-label="Quitar widget"
                          className="text-ink-faint hover:text-rose"
                          onClick={(e) => {
                            e.preventDefault();
                            patch(t.id, { widgets: t.widgets.filter((x) => x.id !== w.id) });
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </span>
                    </summary>
                    <div className="mt-3">
                      <WidgetForm
                        w={w}
                        data={data}
                        onChange={(next) =>
                          patch(t.id, { widgets: t.widgets.map((x) => (x.id === w.id ? next : x)) })
                        }
                      />
                    </div>
                  </details>
                ))}
                {t.widgets.length < 12 && (
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-micro font-semibold text-ink-muted">Añadir:</span>
                    {(Object.keys(KIND_LABEL) as Widget['kind'][]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        className={BTN_SECONDARY}
                        onClick={() =>
                          patch(t.id, {
                            widgets: [
                              ...t.widgets,
                              newWidget(
                                k,
                                firstTracker,
                                t.widgets.map((w) => w.id),
                              ),
                            ],
                          })
                        }
                      >
                        <Plus className="h-3 w-3" aria-hidden /> {KIND_LABEL[k]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        );
      })}

      <ErrorLine error={error} />
      <div className="flex flex-wrap items-center gap-2">
        {tableros.length < 6 && (
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={() => {
              const id = slugId(
                'tablero',
                tableros.map((t) => t.id),
              );
              edit([
                ...tableros,
                { id, title: 'Tablero nuevo', description: '', roles: [], widgets: [] },
              ]);
              setOpen(id);
            }}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Tablero nuevo
          </button>
        )}
        <button type="button" className={BTN_SECONDARY} disabled={pending} onClick={suggest}>
          <Sparkles className="h-3.5 w-3.5" aria-hidden /> Sugerir uno por rol
        </button>
        <button type="button" className={BTN_PRIMARY} disabled={pending} onClick={save}>
          Guardar tableros
        </button>
        {saved && (
          <span className="text-xs font-semibold text-emerald">Guardado en el borrador</span>
        )}
      </div>
    </div>
  );
}
