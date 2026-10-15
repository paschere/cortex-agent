'use client';

import { chipClass } from '@/lib/status-chip';
import {
  NEED_KEYS,
  NEED_LABEL,
  type NeedKey,
  type TaskTemplate,
  fillPrompt,
  needMet,
  titleWith,
} from '@/lib/task-templates/shape';
import { Clock, Loader2, MessageSquare, Plus, Sparkles, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

const INITIAL_SHOWN = 6;

const input =
  'min-h-9 w-full rounded-input border border-border-strong bg-surface px-2.5 text-sm text-ink placeholder:text-ink-faint';
const primaryBtn =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-pill bg-primary px-4 text-sm font-semibold text-white transition-colors hover:bg-primary-ink disabled:opacity-60 motion-reduce:transition-none';
const ghostBtn =
  'inline-flex min-h-9 items-center justify-center gap-1.5 rounded-pill bg-surface-2 px-3 text-xs font-semibold text-ink transition-colors hover:bg-border disabled:opacity-50 motion-reduce:transition-none';

function Card({
  tpl,
  connected,
  canManage,
  fixture,
  onRemoved,
}: {
  tpl: TaskTemplate;
  connected: readonly string[];
  canManage: boolean;
  fixture: boolean;
  onRemoved: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { prompt, missing } = fillPrompt(tpl.prompt, values);
  const needsFields = tpl.fields.length > 0;

  async function start() {
    if (missing.length > 0) {
      setError(`Falta: ${missing.join(', ')}.`);
      return;
    }
    if (fixture) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, title: titleWith(tpl.title, values) }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        task?: { id: string };
      };
      if (!res.ok || !body.task) {
        setError(typeof body.error === 'string' ? body.error : 'No se pudo empezar la tarea.');
        return;
      }
      window.location.assign(`/tareas/${body.task.id}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (fixture) return onRemoved(tpl.id);
    const res = await fetch(`/api/tasks/templates/${tpl.id}`, { method: 'DELETE' });
    if (res.ok) onRemoved(tpl.id);
    else setError('No se pudo quitar la plantilla.');
  }

  const chatHref = `/chat?prompt=${encodeURIComponent(prompt.slice(0, 3800))}`;

  return (
    <li className="flex flex-col rounded-card border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-balance text-sm font-semibold leading-snug text-ink">
          {titleWith(tpl.title)}
        </h3>
        {tpl.source === 'company' && <span className={chipClass('primary')}>De la empresa</span>}
      </div>
      <p className="mt-1.5 text-sm leading-snug text-ink-muted">{tpl.summary}</p>
      <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Qué necesita">
        {tpl.needs.length === 0 ? (
          <li className={chipClass('neutral')}>No necesita conexiones</li>
        ) : (
          tpl.needs.map((n) => {
            const met = needMet(n, connected);
            return (
              <li
                key={n}
                className={chipClass(met === false ? 'amber' : met ? 'emerald' : 'neutral')}
              >
                {NEED_LABEL[n]}
                {met === false && <span className="sr-only"> (sin conectar)</span>}
              </li>
            );
          })
        )}
      </ul>
      <p className="tabular mt-2 flex items-center gap-1.5 text-xs text-ink-faint">
        <Clock className="h-3.5 w-3.5" aria-hidden /> Unos {tpl.minutes} min
      </p>

      {open && needsFields && (
        <div className="mt-3 flex flex-col gap-2">
          {tpl.fields.map((f) => (
            <label key={f.key} className="flex flex-col gap-1 text-xs font-semibold text-ink">
              {f.label}
              <input
                className={input}
                value={values[f.key] ?? ''}
                placeholder={f.placeholder}
                maxLength={200}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 pt-4">
        {needsFields && !open ? (
          <button type="button" className={primaryBtn} onClick={() => setOpen(true)}>
            <Sparkles className="h-4 w-4" aria-hidden /> Empezar
          </button>
        ) : (
          <button type="button" className={primaryBtn} disabled={busy} onClick={() => void start()}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden />
            )}
            Empezar tarea
          </button>
        )}
        <Link href={chatHref} className={ghostBtn}>
          <MessageSquare className="h-3.5 w-3.5" aria-hidden /> Abrir en el chat
        </Link>
        {tpl.source === 'company' && canManage && (
          <button
            type="button"
            className={`${ghostBtn} ml-auto`}
            onClick={() => void remove()}
            aria-label={`Quitar la plantilla ${tpl.title}`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </button>
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs text-rose" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

function AddTemplate({
  fixture,
  onAdded,
}: {
  fixture: boolean;
  onAdded: (t: TaskTemplate) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [prompt, setPrompt] = useState('');
  const [minutes, setMinutes] = useState(10);
  const [needs, setNeeds] = useState<NeedKey[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (fixture) {
        setError('En la maqueta no se guarda.');
        return;
      }
      const res = await fetch('/api/tasks/templates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, summary, prompt, minutes, needs }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        template?: TaskTemplate;
      };
      if (!res.ok || !body.template) {
        setError(body.error ?? 'No se pudo guardar.');
        return;
      }
      onAdded(body.template);
      setOpen(false);
      setTitle('');
      setSummary('');
      setPrompt('');
      setNeeds([]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className={ghostBtn} onClick={() => setOpen(true)}>
        <Plus className="h-3.5 w-3.5" aria-hidden /> Agregar una plantilla de la empresa
      </button>
    );
  }
  return (
    <div className="rounded-card border border-border bg-surface p-4 shadow-card">
      <h3 className="text-sm font-semibold text-ink">Nueva plantilla de la empresa</h3>
      <p className="mt-1 text-xs text-ink-muted">
        Es un pedido ya escrito: lo verá todo el equipo y se manda como cualquier tarea. Usa{' '}
        {'{{así}}'} para los datos que cada persona debe completar.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink sm:col-span-2">
          Título
          <input
            className={input}
            value={title}
            maxLength={90}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink sm:col-span-2">
          Qué hace
          <input
            className={input}
            value={summary}
            maxLength={280}
            onChange={(e) => setSummary(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink sm:col-span-2">
          El pedido
          <textarea
            className={`${input} min-h-28 py-2`}
            value={prompt}
            maxLength={6000}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink">
          Minutos estimados
          <input
            className={input}
            type="number"
            min={1}
            max={120}
            value={minutes}
            onChange={(e) => setMinutes(Number(e.target.value))}
          />
        </label>
        <fieldset className="flex flex-col gap-1 text-xs font-semibold text-ink">
          <legend className="mb-1">Qué necesita</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 font-normal">
            {NEED_KEYS.map((n) => (
              <label key={n} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={needs.includes(n)}
                  onChange={(e) =>
                    setNeeds((cur) => (e.target.checked ? [...cur, n] : cur.filter((x) => x !== n)))
                  }
                />
                {NEED_LABEL[n]}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      {error && (
        <p className="mt-2 text-xs text-rose" role="alert">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button type="button" className={primaryBtn} disabled={busy} onClick={() => void save()}>
          {busy && (
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
          )}
          Guardar plantilla
        </button>
        <button type="button" className={ghostBtn} onClick={() => setOpen(false)}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

/**
 * «EMPEZAR UNA TAREA»: la galería de tareas listas. Cada tarjeta dice qué hace,
 * qué necesita (conectado o no) y cuánto tarda; «Empezar» pide los datos que
 * falten y lanza la tarea en segundo plano; «Abrir en el chat» la deja escrita
 * en el compositor para ajustarla antes.
 */
export function TaskGallery({
  templates,
  connected,
  canManage,
  fixture = false,
}: {
  templates: TaskTemplate[];
  connected: string[];
  canManage: boolean;
  fixture?: boolean;
}) {
  const [items, setItems] = useState(templates);
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, INITIAL_SHOWN);
  return (
    <section aria-labelledby="gallery-title" className="mb-8">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="gallery-title" className="title-display !text-2xl">
            Empezar una tarea
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Elige una, completa lo que falte y Cortex la hace por su cuenta. Lo que mueve plata o
            escribe afuera siempre espera tu visto bueno.
          </p>
        </div>
        {canManage && (
          <AddTemplate fixture={fixture} onAdded={(t) => setItems((cur) => [t, ...cur])} />
        )}
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {shown.map((t) => (
          <Card
            key={t.id}
            tpl={t}
            connected={connected}
            canManage={canManage}
            fixture={fixture}
            onRemoved={(id) => setItems((cur) => cur.filter((x) => x.id !== id))}
          />
        ))}
      </ul>
      {items.length > INITIAL_SHOWN && (
        <button type="button" className={`${ghostBtn} mt-3`} onClick={() => setAll((v) => !v)}>
          {all ? 'Ver menos' : `Ver las ${items.length} plantillas`}
        </button>
      )}
    </section>
  );
}
