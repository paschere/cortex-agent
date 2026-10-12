'use client';

import { saveTrackerFlowAction } from '@/lib/apps/flow-actions';
import {
  FLOW_REQUIREMENT_LABEL,
  type Flow as StateFlow,
  flowSchema,
  linearTransitions,
} from '@cortex/agent-tools/src/trackers/flow';
import { clsx } from 'clsx';
import { ArrowDown, ArrowRight, ArrowUp, GripVertical, Loader2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

/**
 * EL EDITOR DE UN FLUJO POR ESTADOS.
 *
 * Una lista de estados que se ordena arrastrando (o con las flechas), los
 * pasos entre ellos con los roles que pueden darlos, lo que hay que dejar para
 * entrar a cada estado (dato, foto, firma, comentario) y a qué roles se avisa
 * al entrar. Es lo mismo que Cortex arma con «agrega un flujo: …» en el chat:
 * los dos guardan el mismo JSON en el campo de estado, y el servidor hace
 * cumplir lo que se guarde aquí.
 */

export interface FlowEditorTable {
  slug: string;
  name: string;
  fields: Array<{ key: string; label: string; type: string; options?: string[] }>;
  flow: { field: string; def: StateFlow | FlowDefLike } | null;
}
type FlowDefLike = {
  states: string[];
  transitions?: Array<{ from: string; to: string; roles?: string[] }>;
  requirements?: Record<string, Array<{ kind: string; field: string }>>;
  notify?: Record<string, { roles: string[]; message?: string }>;
};

type Req = { kind: 'field' | 'photo' | 'signature' | 'comment'; field: string };
interface Model {
  field: string;
  states: string[];
  transitions: Array<{ from: string; to: string; roles: string[] }>;
  requirements: Record<string, Req[]>;
  notify: Record<string, { roles: string[]; message: string }>;
}

const BTN =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-40';
const BTN_PRIMARY =
  'inline-flex h-8 items-center justify-center gap-1.5 rounded-pill bg-primary px-3.5 text-xs font-semibold text-white shadow-card transition-all hover:bg-primary-strong disabled:opacity-50';
const INPUT =
  'h-8 rounded-pill border border-border bg-surface px-3 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-primary';

function initial(table: FlowEditorTable): Model {
  const selects = table.fields.filter((f) => f.type === 'select');
  const field =
    table.flow?.field ??
    selects.find((f) => /^(estado|status|etapa)$/.test(f.key))?.key ??
    selects[0]?.key ??
    '';
  const def = table.flow?.def as FlowDefLike | undefined;
  const states = def?.states ?? selects.find((f) => f.key === field)?.options?.slice(0, 12) ?? [];
  return {
    field,
    states,
    transitions: def
      ? (def.transitions ?? []).map((t) => ({ from: t.from, to: t.to, roles: t.roles ?? [] }))
      : linearTransitions(states),
    requirements: Object.fromEntries(
      Object.entries(def?.requirements ?? {}).map(([k, v]) => [k, v as Req[]]),
    ),
    notify: Object.fromEntries(
      Object.entries(def?.notify ?? {}).map(([k, v]) => [
        k,
        { roles: v.roles, message: v.message ?? '' },
      ]),
    ),
  };
}

/** ¿Los pasos son los de «uno tras otro» (sin saltos extra)? Entonces al reordenar se rehacen solos. */
function isLinear(states: string[], t: Model['transitions']): boolean {
  return t.every((x) => states.indexOf(x.to) === states.indexOf(x.from) + 1);
}

function move<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return list;
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item as T);
  return next;
}

function RoleChips({
  roles,
  value,
  onChange,
  empty,
}: {
  roles: Array<{ key: string; name: string }>;
  value: string[];
  onChange: (v: string[]) => void;
  empty: string;
}) {
  if (roles.length === 0)
    return <span className="text-micro text-ink-faint">Sin roles definidos en la app.</span>;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {roles.map((r) => {
        const on = value.includes(r.key);
        return (
          <button
            key={r.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== r.key) : [...value, r.key])}
            className={clsx(
              'inline-flex min-h-8 items-center rounded-pill border px-2.5 text-micro font-semibold transition-colors',
              on
                ? 'border-primary/50 bg-primary-soft text-primary-ink'
                : 'border-border bg-surface text-ink-muted hover:text-ink',
            )}
          >
            {r.name}
          </button>
        );
      })}
      {value.length === 0 && <span className="text-micro text-ink-faint">{empty}</span>}
    </div>
  );
}

export function FlowEditor({
  table,
  roles,
  save = saveTrackerFlowAction,
  onSaved,
}: {
  table: FlowEditorTable;
  roles: Array<{ key: string; name: string }>;
  save?: typeof saveTrackerFlowAction;
  onSaved?: () => void;
}) {
  const [m, setM] = useState<Model>(() => initial(table));
  const [draggingAt, setDraggingAt] = useState<number | null>(null);
  const [newState, setNewState] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const selects = table.fields.filter((f) => f.type === 'select');
  const labelOf = (key: string) => table.fields.find((f) => f.key === key)?.label ?? key;
  const fileFields = table.fields.filter((f) => f.type === 'file');
  const textFields = table.fields.filter((f) => f.type === 'text' || f.type === 'longtext');
  const otherFields = table.fields.filter((f) => f.key !== m.field);

  const dirty = useMemo(() => JSON.stringify(m) !== JSON.stringify(initial(table)), [m, table]);

  function edit(next: Partial<Model>) {
    setSaved(false);
    setM((cur) => ({ ...cur, ...next }));
  }

  function reorder(from: number, to: number) {
    const states = move(m.states, from, to);
    if (states === m.states) return;
    // Los pasos «uno tras otro» se rehacen en el nuevo orden, conservando los roles de cada destino.
    const keepRoles = new Map(m.transitions.map((t) => [t.to, t.roles]));
    edit({
      states,
      transitions: isLinear(m.states, m.transitions)
        ? linearTransitions(states).map((t) => ({ ...t, roles: keepRoles.get(t.to) ?? [] }))
        : m.transitions,
    });
  }

  function addState() {
    const name = newState.trim();
    if (!name || m.states.includes(name) || m.states.length >= 12) return;
    const states = [...m.states, name];
    edit({
      states,
      transitions: isLinear(m.states, m.transitions)
        ? [
            ...m.transitions,
            ...(m.states.length
              ? [{ from: m.states[m.states.length - 1] as string, to: name, roles: [] }]
              : []),
          ]
        : m.transitions,
    });
    setNewState('');
  }

  function removeState(state: string) {
    const states = m.states.filter((s) => s !== state);
    const rest = m.transitions.filter((t) => t.from !== state && t.to !== state);
    edit({
      states,
      transitions: isLinear(m.states, m.transitions) ? linearTransitions(states) : rest,
      requirements: Object.fromEntries(Object.entries(m.requirements).filter(([k]) => k !== state)),
      notify: Object.fromEntries(Object.entries(m.notify).filter(([k]) => k !== state)),
    });
  }

  function payload() {
    return {
      slug: table.slug,
      field: m.field,
      addOptions: m.states,
      flow: {
        states: m.states,
        transitions: m.transitions,
        requirements: Object.fromEntries(
          Object.entries(m.requirements).filter(([, v]) => v.length > 0),
        ),
        notify: Object.fromEntries(
          Object.entries(m.notify)
            .filter(([, v]) => v.roles.length > 0)
            .map(([k, v]) => [
              k,
              { roles: v.roles, ...(v.message.trim() ? { message: v.message.trim() } : {}) },
            ]),
        ),
      },
    };
  }

  const check = flowSchema.safeParse(payload().flow);
  const problem =
    m.states.length < 2
      ? 'Un flujo necesita al menos dos estados.'
      : !check.success
        ? (check.error.issues[0]?.message ?? 'El flujo no es válido.')
        : null;

  async function run(remove: boolean) {
    setBusy(true);
    setError(null);
    const p = payload();
    const res = await save({
      slug: p.slug,
      field: p.field,
      flow: remove ? null : p.flow,
      addOptions: remove ? [] : p.addOptions,
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setSaved(true);
    onSaved?.();
  }

  if (selects.length === 0)
    return (
      <p className="rounded-card border border-dashed border-border-strong p-4 text-xs text-ink-muted">
        «{table.name}» no tiene un campo de opciones para usar como estado. Pídele a Cortex que
        agregue uno («agrega un campo Estado con las opciones…»).
      </p>
    );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
          Campo del estado
          <select
            value={m.field}
            onChange={(e) => edit({ field: e.target.value })}
            className={clsx(INPUT, 'pr-6')}
          >
            {selects.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        {table.flow ? (
          <span className="rounded-pill bg-emerald-soft px-2.5 py-1 text-micro font-semibold text-emerald">
            Flujo activo
          </span>
        ) : (
          <span className="rounded-pill bg-surface-2 px-2.5 py-1 text-micro font-semibold text-ink-muted">
            Sin flujo: el estado cambia libremente
          </span>
        )}
      </div>

      <section aria-label="Estados">
        <h4 className="mb-2 text-xs font-bold text-ink">Estados, en orden</h4>
        <ol className="space-y-1.5">
          {m.states.map((s, i) => (
            <li
              key={s}
              draggable
              onDragStart={() => setDraggingAt(i)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (draggingAt !== null) reorder(draggingAt, i);
                setDraggingAt(null);
              }}
              onDragEnd={() => setDraggingAt(null)}
              className={clsx(
                'flex items-center gap-2 rounded-card border border-border bg-surface px-2.5 py-1.5',
                draggingAt === i && 'opacity-50',
              )}
            >
              <GripVertical className="h-4 w-4 shrink-0 cursor-grab text-ink-faint" aria-hidden />
              <span className="tabular w-5 shrink-0 text-center font-mono text-micro text-ink-faint">
                {i + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{s}</span>
              {i === 0 && <span className="text-micro text-ink-faint">donde nace cada fila</span>}
              <button
                type="button"
                aria-label={`Subir ${s}`}
                disabled={i === 0}
                onClick={() => reorder(i, i - 1)}
                className="grid h-8 w-8 place-items-center rounded-pill text-ink-muted hover:bg-surface-2 disabled:opacity-30"
              >
                <ArrowUp className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`Bajar ${s}`}
                disabled={i === m.states.length - 1}
                onClick={() => reorder(i, i + 1)}
                className="grid h-8 w-8 place-items-center rounded-pill text-ink-muted hover:bg-surface-2 disabled:opacity-30"
              >
                <ArrowDown className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                aria-label={`Quitar ${s}`}
                onClick={() => removeState(s)}
                className="grid h-8 w-8 place-items-center rounded-pill text-ink-muted hover:bg-rose-soft hover:text-rose"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ol>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={newState}
            onChange={(e) => setNewState(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              addState();
            }}
            placeholder="Nuevo estado"
            aria-label="Nuevo estado"
            className={clsx(INPUT, 'w-48')}
            maxLength={80}
          />
          <button
            type="button"
            onClick={addState}
            disabled={!newState.trim() || m.states.length >= 12}
            className={BTN}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar
          </button>
        </div>
      </section>

      <section aria-label="Pasos y quién los da">
        <h4 className="mb-1 text-xs font-bold text-ink">Pasos y quién los da</h4>
        <p className="mb-2 text-micro text-ink-muted">
          Sin roles marcados, cualquiera que pueda editar la fila da el paso. Con roles, sólo ellos
          (y quien administra).
        </p>
        <ul className="space-y-1.5">
          {m.transitions.map((t, i) => (
            <li
              key={`${t.from}>${t.to}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card border border-border bg-surface px-3 py-2"
            >
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink">
                {t.from} <ArrowRight className="h-3 w-3 text-ink-faint" aria-hidden /> {t.to}
              </span>
              <div className="min-w-0 flex-1">
                <RoleChips
                  roles={roles}
                  value={t.roles}
                  empty="Cualquiera"
                  onChange={(v) =>
                    edit({
                      transitions: m.transitions.map((x, j) => (j === i ? { ...x, roles: v } : x)),
                    })
                  }
                />
              </div>
              <button
                type="button"
                aria-label={`Quitar el paso ${t.from} a ${t.to}`}
                onClick={() => edit({ transitions: m.transitions.filter((_, j) => j !== i) })}
                className="grid h-8 w-8 place-items-center rounded-pill text-ink-muted hover:bg-rose-soft hover:text-rose"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
          {m.transitions.length === 0 && (
            <li className="text-xs text-ink-muted">Todavía no hay pasos entre estados.</li>
          )}
        </ul>
        <AddTransition
          states={m.states}
          existing={m.transitions}
          onAdd={(t) => edit({ transitions: [...m.transitions, { ...t, roles: [] }] })}
          onReset={() => edit({ transitions: linearTransitions(m.states) })}
        />
      </section>

      <section aria-label="Qué se pide al entrar">
        <h4 className="mb-1 text-xs font-bold text-ink">
          Qué hay que dejar para entrar a un estado
        </h4>
        <ul className="space-y-2">
          {m.states.map((s) => {
            const reqs = m.requirements[s] ?? [];
            return (
              <li key={s} className="rounded-card border border-border bg-surface px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-ink">Entrar a «{s}»</span>
                  <button
                    type="button"
                    disabled={reqs.length >= 5}
                    onClick={() => {
                      const field =
                        fileFields[0]?.key ?? textFields[0]?.key ?? otherFields[0]?.key ?? '';
                      edit({
                        requirements: {
                          ...m.requirements,
                          [s]: [...reqs, { kind: fileFields[0] ? 'photo' : 'comment', field }],
                        },
                      });
                    }}
                    className={BTN}
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden /> Pedir algo
                  </button>
                </div>
                {reqs.map((r, i) => {
                  const options =
                    r.kind === 'photo' || r.kind === 'signature'
                      ? fileFields
                      : r.kind === 'comment'
                        ? textFields
                        : otherFields;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: filas editables sin id propio
                    <div key={i} className="mt-2 flex flex-wrap items-center gap-2">
                      <select
                        value={r.kind}
                        aria-label="Qué se pide"
                        onChange={(e) => {
                          const kind = e.target.value as Req['kind'];
                          const pool =
                            kind === 'photo' || kind === 'signature'
                              ? fileFields
                              : kind === 'comment'
                                ? textFields
                                : otherFields;
                          edit({
                            requirements: {
                              ...m.requirements,
                              [s]: reqs.map((x, j) =>
                                j === i
                                  ? {
                                      kind,
                                      field: pool.some((f) => f.key === x.field)
                                        ? x.field
                                        : (pool[0]?.key ?? ''),
                                    }
                                  : x,
                              ),
                            },
                          });
                        }}
                        className={INPUT}
                      >
                        {(Object.keys(FLOW_REQUIREMENT_LABEL) as Req['kind'][]).map((k) => (
                          <option key={k} value={k}>
                            {FLOW_REQUIREMENT_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      <span className="text-micro text-ink-faint">se guarda en</span>
                      <select
                        value={r.field}
                        aria-label="Dónde se guarda"
                        onChange={(e) =>
                          edit({
                            requirements: {
                              ...m.requirements,
                              [s]: reqs.map((x, j) =>
                                j === i ? { ...x, field: e.target.value } : x,
                              ),
                            },
                          })
                        }
                        className={INPUT}
                      >
                        {options.length === 0 && (
                          <option value="">No hay un campo de este tipo</option>
                        )}
                        {options.map((f) => (
                          <option key={f.key} value={f.key}>
                            {f.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        aria-label="Quitar este requisito"
                        onClick={() =>
                          edit({
                            requirements: {
                              ...m.requirements,
                              [s]: reqs.filter((_, j) => j !== i),
                            },
                          })
                        }
                        className="grid h-8 w-8 place-items-center rounded-pill text-ink-muted hover:bg-rose-soft hover:text-rose"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ul>
        {fileFields.length === 0 && (
          <p className="mt-2 text-micro text-ink-muted">
            Para pedir foto o firma la tabla necesita un campo de archivo; pídele a Cortex que lo
            agregue.
          </p>
        )}
      </section>

      <section aria-label="A quién se avisa">
        <h4 className="mb-1 text-xs font-bold text-ink">A quién se avisa al entrar</h4>
        <p className="mb-2 text-micro text-ink-muted">
          Llega por la campana a los roles marcados. WhatsApp o correo se arman aparte, con tu
          confirmación.
        </p>
        <ul className="space-y-2">
          {m.states.map((s) => {
            const n = m.notify[s] ?? { roles: [], message: '' };
            return (
              <li
                key={s}
                className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-card border border-border bg-surface px-3 py-2"
              >
                <span className="w-32 shrink-0 text-xs font-semibold text-ink">{s}</span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <RoleChips
                    roles={roles}
                    value={n.roles}
                    empty="Nadie"
                    onChange={(v) => edit({ notify: { ...m.notify, [s]: { ...n, roles: v } } })}
                  />
                  {n.roles.length > 0 && (
                    <input
                      value={n.message}
                      onChange={(e) =>
                        edit({ notify: { ...m.notify, [s]: { ...n, message: e.target.value } } })
                      }
                      placeholder={`{{nombre}} pasó a ${s}`}
                      aria-label={`Mensaje al entrar a ${s}`}
                      className={clsx(INPUT, 'w-full')}
                      maxLength={300}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      {(problem || error) && (
        <p role="alert" className="text-xs font-semibold text-rose">
          {error ?? problem}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy || !dirty || problem !== null}
          onClick={() => run(false)}
          className={BTN_PRIMARY}
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Guardar flujo
        </button>
        {table.flow && (
          <button type="button" disabled={busy} onClick={() => run(true)} className={BTN}>
            Quitar el flujo
          </button>
        )}
        {saved && <span className="text-xs font-semibold text-emerald">Guardado</span>}
        <span className="text-micro text-ink-faint">
          {labelOf(m.field)} · {m.states.length} estados
        </span>
      </div>
    </div>
  );
}

function AddTransition({
  states,
  existing,
  onAdd,
  onReset,
}: {
  states: string[];
  existing: Array<{ from: string; to: string }>;
  onAdd: (t: { from: string; to: string }) => void;
  onReset: () => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const dup = existing.some((t) => t.from === from && t.to === to);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <select
        value={from}
        onChange={(e) => setFrom(e.target.value)}
        aria-label="Desde"
        className={INPUT}
      >
        <option value="">Desde…</option>
        {states.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <ArrowRight className="h-3 w-3 text-ink-faint" aria-hidden />
      <select
        value={to}
        onChange={(e) => setTo(e.target.value)}
        aria-label="Hasta"
        className={INPUT}
      >
        <option value="">Hasta…</option>
        {states.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <button
        type="button"
        disabled={!from || !to || from === to || dup}
        onClick={() => {
          onAdd({ from, to });
          setFrom('');
          setTo('');
        }}
        className={BTN}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar paso
      </button>
      <button
        type="button"
        onClick={onReset}
        className="text-xs font-semibold text-primary hover:underline"
      >
        Rehacer uno tras otro
      </button>
    </div>
  );
}
