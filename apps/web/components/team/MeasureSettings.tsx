'use client';

import { clsx } from 'clsx';
import { Check, Eye, Loader2, Ruler, Table2, Unplug } from 'lucide-react';
import { useState, useTransition } from 'react';
import { Pill, Section, fieldClass, pillLink, pillPrimary } from './pieces';
import type { MappingDraft, MappingSuggestion, TeamActions, TrackerOption } from './types';

/**
 * «QUÉ SE MIDE» (sólo quien administra): conectar una tabla como trabajo,
 * qué tipos se miden y quién ve qué. Es la cara de `work.suggest_mapping` y
 * `work.configure`: la propuesta la hace Cortex, la decide una persona.
 */

type Visibility = 'self' | 'team' | 'all';

const VISIBILITY: Array<{ key: Visibility; title: string; body: string }> = [
  {
    key: 'self',
    title: 'Cada persona ve lo suyo',
    body: 'Quien administra ve a todo el equipo. Es lo recomendado.',
  },
  {
    key: 'team',
    title: 'Cada persona ve su equipo',
    body: 'Las cifras de quienes están en su mismo equipo (Operación, Cartera…).',
  },
  {
    key: 'all',
    title: 'Todos ven a todos',
    body: 'Las cifras de todo el equipo, sin señales con nombre.',
  },
];

type Note = { ok: boolean; text: string } | null;

function Result({ note }: { note: Note }) {
  return (
    <output
      aria-live="polite"
      className={clsx('block text-xs', !note && 'sr-only', note?.ok ? 'text-emerald' : 'text-rose')}
    >
      {note?.text ?? ''}
    </output>
  );
}

export function MeasureSettings({
  trackers,
  workTypes,
  measuredTypes,
  visibility,
  actions,
}: {
  trackers: TrackerOption[];
  workTypes: string[];
  measuredTypes: string[] | null;
  visibility: Visibility;
  actions: Pick<TeamActions, 'suggestMapping' | 'configure'>;
}) {
  return (
    <div className="space-y-6">
      <MappingWizard trackers={trackers} actions={actions} />
      <div className="grid gap-6 lg:grid-cols-2">
        <MeasuredTypes types={workTypes} initial={measuredTypes} configure={actions.configure} />
        <VisibilityChoice initial={visibility} configure={actions.configure} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conectar una tabla
// ---------------------------------------------------------------------------

function singular(name: string): string {
  const w = name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && w.length > 3) return w.slice(0, -1);
  return w;
}

function MappingWizard({
  trackers,
  actions,
}: {
  trackers: TrackerOption[];
  actions: Pick<TeamActions, 'suggestMapping' | 'configure'>;
}) {
  const [slug, setSlug] = useState<string | null>(null);
  const [draft, setDraft] = useState<MappingDraft | null>(null);
  const [suggestion, setSuggestion] = useState<Extract<MappingSuggestion, { ok: true }> | null>(
    null,
  );
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const tracker = trackers.find((t) => t.slug === slug) ?? null;
  const mapped = trackers.filter((t) => t.mappedAs);

  const choose = (t: TrackerOption) => {
    setSlug(t.slug);
    setDraft(null);
    setSuggestion(null);
    setNote(null);
    start(async () => {
      const r = await actions.suggestMapping({ tracker: t.slug });
      if (!r.ok) {
        setNote({ ok: false, text: r.error });
        return;
      }
      setSuggestion(r);
      const firstText = t.fields.find((f) => f.type === 'text' || f.type === 'select');
      setDraft({
        tracker: t.slug,
        workType: t.mappedAs ?? singular(t.name),
        assigneeField: r.mapping?.assigneeField ?? firstText?.key ?? '',
        statusField: r.mapping?.statusField ?? null,
        doneValues: r.mapping?.doneValues ?? [],
        cancelledValues: r.mapping?.cancelledValues ?? [],
        dueField: r.mapping?.dueField ?? null,
        quantityField: r.mapping?.quantityField ?? null,
        unit: r.mapping?.unit ?? null,
        titleField: r.mapping?.titleField ?? null,
      });
    });
  };

  const fieldsOf = (types: string[]) => tracker?.fields.filter((f) => types.includes(f.type)) ?? [];
  const statusField = tracker?.fields.find((f) => f.key === draft?.statusField) ?? null;
  const set = (patch: Partial<MappingDraft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  const save = () =>
    draft &&
    start(async () => {
      const r = await actions.configure({ mapTracker: draft });
      setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
    });

  const select = (
    label: string,
    value: string | null,
    options: Array<{ key: string; label: string }>,
    onChange: (v: string | null) => void,
    opts: { required?: boolean; hint?: string } = {},
  ) => (
    <label className="block">
      <span className="field-label">{label}</span>
      <select
        className={clsx(fieldClass, 'mt-1')}
        value={value ?? ''}
        required={opts.required}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {!opts.required && <option value="">— Ninguno —</option>}
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      {opts.hint && <span className="mt-1 block text-micro text-ink-muted">{opts.hint}</span>}
    </label>
  );

  return (
    <Section
      id="conectar"
      title="Conectar una tabla como trabajo"
      subtitle="Elige la tabla donde ya llevan el trabajo; Cortex propone qué campo es el responsable, el estado y la fecha, y tú lo confirmas."
      icon={<Table2 className="h-4 w-4" aria-hidden />}
    >
      {trackers.length === 0 ? (
        <p className="text-sm text-ink-muted">
          Todavía no hay tablas en este espacio. Crea una desde Datos o pídesela a Cortex en el
          chat, y vuelve aquí para conectarla.
        </p>
      ) : (
        <ol className="space-y-5">
          <li>
            <p className="mb-2 text-sm font-bold text-ink">1. Elige la tabla</p>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {trackers.map((t) => (
                <button
                  key={t.slug}
                  type="button"
                  disabled={pending}
                  onClick={() => choose(t)}
                  aria-pressed={slug === t.slug}
                  className={clsx(
                    'flex items-start justify-between gap-2 rounded-sm border px-3 py-2.5 text-left transition-colors',
                    slug === t.slug
                      ? 'border-primary bg-primary-soft'
                      : 'border-border bg-surface hover:border-border-strong',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-ink">{t.name}</span>
                    <span className="tabular text-micro text-ink-muted">
                      {t.rowCount} filas · {t.fields.length} campos
                    </span>
                  </span>
                  {t.mappedAs && <Pill tone="emerald">{t.mappedAs}</Pill>}
                </button>
              ))}
            </div>
          </li>

          {pending && !draft && (
            <li className="flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Leyendo la tabla…
            </li>
          )}

          {tracker && draft && (
            <li>
              <p className="mb-1 text-sm font-bold text-ink">2. Confirma los campos</p>
              {suggestion && !suggestion.mapping && (
                <p className="mb-2 text-xs text-amber">
                  No encontré un campo que diga claramente quién responde: elige uno.
                </p>
              )}
              {suggestion && suggestion.candidates.length > 0 && (
                <p className="mb-2 text-xs text-ink-muted">
                  Responsable propuesto: {suggestion.candidates[0]?.label} —{' '}
                  {suggestion.candidates[0]?.reason}
                </p>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                {select(
                  'Responsable',
                  draft.assigneeField,
                  fieldsOf(['text', 'select']),
                  (v) => set({ assigneeField: v ?? '' }),
                  { required: true, hint: 'El nombre o correo de quien responde.' },
                )}
                {select(
                  'Estado',
                  draft.statusField,
                  fieldsOf(['text', 'select']),
                  (v) => set({ statusField: v, doneValues: [], cancelledValues: [] }),
                  { hint: 'Sin estado, una fila está abierta hasta que tenga fecha de cierre.' },
                )}
                {select('Vence', draft.dueField, fieldsOf(['date', 'text']), (v) =>
                  set({ dueField: v }),
                )}
                {select(
                  'Cantidad producida',
                  draft.quantityField,
                  fieldsOf(['number', 'money']),
                  (v) => set({ quantityField: v }),
                )}
              </div>
              {statusField && (
                <fieldset className="mt-3">
                  <legend className="field-label">
                    ¿Qué valores de «{statusField.label}» son hecho?
                  </legend>
                  {statusField.options?.length ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {statusField.options.map((o) => {
                        const on = draft.doneValues.includes(o);
                        return (
                          <button
                            key={o}
                            type="button"
                            aria-pressed={on}
                            onClick={() =>
                              set({
                                doneValues: on
                                  ? draft.doneValues.filter((v) => v !== o)
                                  : [...draft.doneValues, o],
                              })
                            }
                            className={clsx(
                              'inline-flex items-center gap-1 rounded-pill border px-3 py-1 text-xs font-semibold',
                              on
                                ? 'border-emerald/30 bg-emerald-soft text-emerald'
                                : 'border-border bg-surface text-ink-muted hover:text-ink',
                            )}
                          >
                            {on && <Check className="h-3 w-3" aria-hidden />}
                            {o}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <input
                      className={clsx(fieldClass, 'mt-1')}
                      placeholder="Entregado, Cerrado"
                      value={draft.doneValues.join(', ')}
                      onChange={(e) =>
                        set({
                          doneValues: e.target.value
                            .split(',')
                            .map((v) => v.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  )}
                </fieldset>
              )}
              {draft.quantityField && (
                <label className="mt-3 block max-w-xs">
                  <span className="field-label">Unidad de la cantidad</span>
                  <input
                    className={clsx(fieldClass, 'mt-1')}
                    placeholder="guías, COP, pedidos"
                    value={draft.unit ?? ''}
                    onChange={(e) => set({ unit: e.target.value.trim() || null })}
                  />
                </label>
              )}

              <p className="mb-1 mt-5 text-sm font-bold text-ink">3. ¿Qué tipo de trabajo es?</p>
              <label className="block max-w-xs">
                <span className="field-label">Tipo de trabajo, en singular</span>
                <input
                  className={clsx(fieldClass, 'mt-1')}
                  placeholder="despacho"
                  value={draft.workType}
                  onChange={(e) => set({ workType: e.target.value })}
                />
                <span className="mt-1 block text-micro text-ink-muted">
                  Así se compara peras con peras: despachos con despachos.
                </span>
              </label>

              <div className="mt-5 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  disabled={pending || !draft.assigneeField || !draft.workType.trim()}
                  onClick={save}
                  className={pillPrimary}
                >
                  {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                  Conectar y cargar
                </button>
                <span className="text-xs text-ink-muted">
                  Lee las filas de {tracker.name} ahora y cada día. No cambia la tabla.
                </span>
              </div>
            </li>
          )}
        </ol>
      )}
      <div className="mt-3">
        <Result note={note} />
      </div>

      {mapped.length > 0 && (
        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-2 text-sm font-bold text-ink">Tablas conectadas</p>
          <ul className="space-y-2">
            {mapped.map((t) => (
              <li key={t.slug} className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-ink">
                  {t.name} <span className="text-ink-muted">como «{t.mappedAs}»</span>
                </span>
                <UnmapButton slug={t.slug} name={t.name} configure={actions.configure} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function UnmapButton({
  slug,
  name,
  configure,
}: {
  slug: string;
  name: string;
  configure: TeamActions['configure'];
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  if (note?.ok) return <span className="text-xs text-emerald">{note.text}</span>;
  return (
    <span className="flex flex-wrap items-center gap-2">
      {confirming ? (
        <>
          <span className="text-xs text-ink-muted">
            Se deja de medir {name} y se borra su registro (la tabla no se toca).
          </span>
          <button
            type="button"
            disabled={pending}
            className={clsx(pillLink, 'text-rose')}
            onClick={() =>
              start(async () => {
                const r = await configure({ unmapTracker: slug });
                setNote(r.ok ? { ok: true, text: 'Desconectada.' } : { ok: false, text: r.error });
              })
            }
          >
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Sí, desconectar
          </button>
          <button type="button" className={pillLink} onClick={() => setConfirming(false)}>
            Cancelar
          </button>
        </>
      ) : (
        <button type="button" className={pillLink} onClick={() => setConfirming(true)}>
          <Unplug className="h-3.5 w-3.5" aria-hidden />
          Desconectar
        </button>
      )}
      <Result note={note} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Qué tipos se miden
// ---------------------------------------------------------------------------

function MeasuredTypes({
  types,
  initial,
  configure,
}: {
  types: string[];
  initial: string[] | null;
  configure: TeamActions['configure'];
}) {
  const [all, setAll] = useState(initial === null);
  const [chosen, setChosen] = useState<Set<string>>(new Set(initial ?? types));
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  const known = [...new Set([...types, ...(initial ?? [])])].sort((a, b) =>
    a.localeCompare(b, 'es'),
  );
  return (
    <Section
      id="tipos"
      title="Qué tipos se miden"
      subtitle="Lo que no se mide no se guarda ni aparece en las cifras."
      icon={<Ruler className="h-4 w-4" aria-hidden />}
    >
      <label className="flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="h-4 w-4 accent-primary"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
        />
        Medir todo tipo de trabajo
      </label>
      {!all && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {known.length === 0 && (
            <p className="text-xs text-ink-muted">Todavía no hay tipos de trabajo registrados.</p>
          )}
          {known.map((t) => {
            const on = chosen.has(t);
            return (
              <button
                key={t}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setChosen((prev) => {
                    const next = new Set(prev);
                    if (on) next.delete(t);
                    else next.add(t);
                    return next;
                  })
                }
                className={clsx(
                  'inline-flex items-center gap-1 rounded-pill border px-3 py-1 text-xs font-semibold',
                  on
                    ? 'border-primary/30 bg-primary-soft text-primary-ink'
                    : 'border-border bg-surface text-ink-muted hover:text-ink',
                )}
              >
                {on && <Check className="h-3 w-3" aria-hidden />}
                {t}
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending || (!all && chosen.size === 0)}
          className={pillLink}
          onClick={() =>
            start(async () => {
              const r = await configure({ measuredTypes: all ? null : [...chosen] });
              setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
            })
          }
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Guardar
        </button>
        <Result note={note} />
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Quién ve qué
// ---------------------------------------------------------------------------

function VisibilityChoice({
  initial,
  configure,
}: {
  initial: Visibility;
  configure: TeamActions['configure'];
}) {
  const [value, setValue] = useState<Visibility>(initial);
  const [pending, start] = useTransition();
  const [note, setNote] = useState<Note>(null);
  return (
    <Section
      id="visibilidad"
      title="Quién ve qué"
      subtitle="Cada persona siempre ve todo lo que se mide de ella; quien administra, a todo el equipo."
      icon={<Eye className="h-4 w-4" aria-hidden />}
    >
      <fieldset className="space-y-2">
        <legend className="sr-only">Visibilidad del trabajo del equipo</legend>
        {VISIBILITY.map((v) => (
          <label
            key={v.key}
            className={clsx(
              'flex cursor-pointer items-start gap-3 rounded-sm border px-3 py-2.5',
              value === v.key
                ? 'border-primary bg-primary-soft'
                : 'border-border hover:border-border-strong',
            )}
          >
            <input
              type="radio"
              name="visibilidad"
              className="mt-1 h-4 w-4 accent-primary"
              checked={value === v.key}
              onChange={() => setValue(v.key)}
            />
            <span>
              <span className="block text-sm font-semibold text-ink">{v.title}</span>
              <span className="block text-xs text-ink-muted">{v.body}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending || value === initial}
          className={pillLink}
          onClick={() =>
            start(async () => {
              const r = await configure({ teamVisibility: value });
              setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
            })
          }
        >
          {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Guardar
        </button>
        <Result note={note} />
      </div>
    </Section>
  );
}
