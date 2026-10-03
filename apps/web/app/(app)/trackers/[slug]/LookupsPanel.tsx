'use client';

import { Sheet } from '@/components/datagrid/dialogs';
import { FilterPanel } from '@/components/datagrid/panels';
import {
  ghostButton,
  inputClass,
  primaryButton,
  selectClass,
} from '@/components/datagrid/primitives';
import type { GridColumn, GridView } from '@/components/datagrid/types';
import { formatDateTime } from '@/lib/datagrid/format';
import type {
  LookupCard,
  LookupCredentialOption,
  LookupDraft,
  LookupPreviewView,
  LookupState,
} from '@/lib/datagrid/lookups';
import { UPDATED_KEY, fieldKeyFrom } from '@/lib/datagrid/trackers';
import { isActiveFilter } from '@/lib/datagrid/view';
import { DOT_TONE, type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { LoaderCircle, Pause, Play, Plus, RefreshCw, ScanSearch, Trash2 } from 'lucide-react';
import { useId, useMemo, useRef, useState } from 'react';
import type { ActionResult, LookupActions } from '../types';

/**
 * «CONSULTAS AUTOMÁTICAS»: QUÉ SE PREGUNTA A UNA API, FILA POR FILA.
 *
 * El panel lista cada consulta de la tabla con lo que importa para no gastar de
 * más: cuántas consultas lleva hoy contra su tope, cuándo corre de nuevo y el
 * último error. El diálogo arma una nueva —la dirección con los campos de la
 * fila, qué se trae, a qué filas, cada cuánto y con qué tope— y la prueba con
 * UNA fila, mostrando lo que escribiría, antes de guardar.
 */

const STATE: Record<LookupState, { tone: StatusTone; label: string }> = {
  ok: { tone: 'emerald', label: 'Funcionando' },
  error: { tone: 'rose', label: 'Falló' },
  paused: { tone: 'neutral', label: 'En pausa' },
  capped: { tone: 'amber', label: 'Tope del día' },
  waiting: { tone: 'amber', label: 'Por arrancar' },
};

function when(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const min = Math.round((t - now) / 60_000);
  if (min <= 0) return 'en la próxima vuelta';
  if (min < 60) return `en ${min} min`;
  return formatDateTime(iso);
}

function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return 'nunca';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const min = Math.round((now - t) / 60_000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return `hace ${min} min`;
  return formatDateTime(iso);
}

export function LookupCardView({
  lookup,
  canManage,
  onUpdate,
}: {
  lookup: LookupCard;
  canManage: boolean;
  onUpdate: (
    id: string,
    patch: { enabled?: boolean; dailyCap?: number; runNow?: boolean },
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [cap, setCap] = useState(String(lookup.dailyCap));
  const capId = useId();
  const s = STATE[lookup.state];
  const pct = Math.min(100, Math.round((lookup.callsToday / Math.max(1, lookup.dailyCap)) * 100));
  const run = async (key: string, patch: Parameters<typeof onUpdate>[1]) => {
    setBusy(key);
    await onUpdate(lookup.id, patch);
    setBusy(null);
  };
  const capValue = Number(cap);
  const capChanged =
    Number.isInteger(capValue) &&
    capValue >= 1 &&
    capValue <= 100000 &&
    capValue !== lookup.dailyCap;
  return (
    <div
      className={clsx(
        'flex min-w-0 flex-1 basis-96 flex-col gap-2 rounded-card border bg-surface p-4 shadow-card',
        lookup.state === 'error' ? 'border-rose/30' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <ScanSearch className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-xs font-bold text-ink">{lookup.name}</span>
        <span className={chipClass(s.tone)}>
          <span className={clsx('h-1.5 w-1.5 rounded-full', DOT_TONE[s.tone])} aria-hidden />
          {s.label}
        </span>
      </div>
      <p className="text-micro text-ink-muted">
        Consulta {lookup.cadence}. A las filas donde: {lookup.filter.toLowerCase()}.
      </p>
      <p className="truncate font-mono text-micro text-ink-faint" title={lookup.url}>
        {lookup.url}
      </p>
      <p className="text-micro text-ink-muted">Escribe: {lookup.writes}.</p>
      <div>
        <div className="mb-1 flex items-baseline justify-between text-micro">
          <span className="font-semibold text-ink">
            Hoy <span className="tabular">{lookup.callsToday.toLocaleString('es-CO')}</span> de{' '}
            <span className="tabular">{lookup.dailyCap.toLocaleString('es-CO')}</span> consultas
          </span>
          <span className="text-ink-faint">tope por vuelta {lookup.perRunCap}</span>
        </div>
        {/* Las cifras de arriba ya dicen lo mismo: la barra es sólo para el ojo. */}
        <div className="h-1.5 overflow-hidden rounded-pill bg-surface-2" aria-hidden>
          <div
            className={clsx(
              'h-full rounded-pill',
              pct >= 100 ? 'bg-rose' : pct >= 80 ? 'bg-amber' : 'bg-primary',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <p className="text-micro text-ink-muted">
        Última vuelta{' '}
        <span className="tabular" suppressHydrationWarning>
          {ago(lookup.lastRunAt)}
        </span>
        {lookup.lastRunAt
          ? ` · ${lookup.lastCalls} consultas, ${lookup.lastUpdated} filas cambiaron`
          : ''}
        . Próxima{' '}
        <span className="tabular" suppressHydrationWarning>
          {lookup.nextRunAt ? when(lookup.nextRunAt) : 'en pausa'}
        </span>
        .
      </p>
      {lookup.lastError ? (
        <p className="rounded-sm bg-rose-soft px-2.5 py-1.5 text-micro font-semibold text-rose">
          {lookup.lastError}
        </p>
      ) : null}
      {canManage ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => run('toggle', { enabled: lookup.state === 'paused' })}
            className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-micro font-bold text-primary hover:bg-primary-soft disabled:opacity-50"
          >
            {busy === 'toggle' ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : lookup.state === 'paused' ? (
              <Play className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <Pause className="h-3.5 w-3.5" aria-hidden />
            )}
            {lookup.state === 'paused' ? 'Reanudar' : 'Pausar'}
          </button>
          {lookup.state !== 'paused' ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => run('now', { runNow: true })}
              className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-micro font-bold text-primary hover:bg-primary-soft disabled:opacity-50"
            >
              {busy === 'now' ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              )}
              Consultar ahora
            </button>
          ) : null}
          <span className="ml-auto flex items-center gap-1.5">
            <label htmlFor={capId} className="text-micro text-ink-muted">
              Tope diario
            </label>
            <input
              id={capId}
              type="number"
              min={1}
              max={100000}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className={clsx(inputClass, 'tabular h-8 w-24')}
            />
            {capChanged ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('cap', { dailyCap: capValue })}
                className="rounded-pill px-2.5 py-1 text-micro font-bold text-primary hover:bg-primary-soft disabled:opacity-50"
              >
                Guardar
              </button>
            ) : null}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function LookupsSection({
  lookups,
  canManage,
  actions,
  onNotice,
  onAdd,
  onChanged,
}: {
  lookups: LookupCard[];
  canManage: boolean;
  actions: LookupActions;
  onNotice: (notice: { tone: 'ok' | 'error'; text: string }) => void;
  onAdd: () => void;
  onChanged: () => void;
}) {
  const update = async (
    id: string,
    patch: { enabled?: boolean; dailyCap?: number; runNow?: boolean },
  ) => {
    const r = await actions.update(id, patch);
    onNotice(r.ok ? { tone: 'ok', text: r.message } : { tone: 'error', text: r.error });
    if (r.ok) onChanged();
  };
  return (
    <section aria-label="Consultas automáticas" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-bold text-ink">Consultas automáticas</h2>
        <span className="text-micro text-ink-faint">una consulta a una API por fila</span>
        {canManage ? (
          <button type="button" onClick={onAdd} className={clsx(ghostButton, 'ml-auto')}>
            <Plus className="h-4 w-4" aria-hidden />
            Agregar consulta
          </button>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-3">
        {lookups.map((l) => (
          <LookupCardView key={l.id} lookup={l} canManage={canManage} onUpdate={update} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Agregar consulta
// ---------------------------------------------------------------------------

interface MappingRow {
  path: string;
  /** Clave de una columna existente, o '__new' para crear una de texto. */
  field: string;
  label: string;
}

const EMPTY_VIEW: GridView = {
  filters: [],
  match: 'all',
  sort: [],
  hidden: [],
  layout: 'table',
};

const DEFAULT_URL_HINT = 'https://api.ejemplo.com/vuelos/{vuelo}/{fecha:YYYY-MM-DD}';

export function AddLookupDialog({
  open,
  onOpenChange,
  trackerId,
  trackerName,
  columns,
  credentials,
  actions,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  trackerId: string;
  trackerName: string;
  columns: GridColumn[];
  credentials: LookupCredentialOption[];
  actions: LookupActions;
  onDone: (message: string) => void;
}) {
  const tableColumns = useMemo(() => columns.filter((c) => c.key !== UPDATED_KEY), [columns]);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [mapping, setMapping] = useState<MappingRow[]>([{ path: '', field: '', label: '' }]);
  const [view, setView] = useState<GridView>(EMPTY_VIEW);
  const [interval, setIntervalMinutes] = useState('30');
  const [near, setNear] = useState(false);
  const [nearField, setNearField] = useState('');
  const [before, setBefore] = useState('120');
  const [after, setAfter] = useState('60');
  const [every, setEvery] = useState('5');
  const [outside, setOutside] = useState<'base' | 'skip'>('base');
  const [dailyCap, setDailyCap] = useState('1000');
  const [perRun, setPerRun] = useState('100');
  const [preview, setPreview] = useState<LookupPreviewView | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const ids = {
    name: useId(),
    url: useId(),
    cred: useId(),
    interval: useId(),
    near: useId(),
    cap: useId(),
    run: useId(),
  };

  const timeColumns = tableColumns.filter(
    (c) => c.type === 'date' || c.type === 'datetime' || c.type === 'text',
  );

  const insertToken = (token: string) => {
    const el = urlRef.current;
    const at = el?.selectionStart ?? url.length;
    const to = el?.selectionEnd ?? at;
    setUrl(`${url.slice(0, at)}${token}${url.slice(to)}`);
    setPreview(null);
    window.setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(at + token.length, at + token.length);
    }, 0);
  };

  const draft = (): LookupDraft | string => {
    if (!name.trim()) return 'Ponle un nombre a la consulta.';
    if (!/^https:\/\//i.test(url.trim())) return 'La dirección empieza con https://.';
    const taken = tableColumns.map((c) => c.key);
    const rows: LookupDraft['mapping'] = [];
    for (const m of mapping) {
      if (!m.path.trim() && !m.field) continue;
      if (!m.path.trim() || !m.field)
        return 'Cada renglón de «Qué traer» necesita el dato y la columna.';
      if (m.field === '__new') {
        if (!m.label.trim()) return 'Ponle nombre a la columna nueva.';
        const key = fieldKeyFrom(m.label, [...taken, ...rows.map((r) => r.field)]);
        rows.push({ path: m.path.trim(), field: key, label: m.label.trim() });
      } else rows.push({ path: m.path.trim(), field: m.field });
    }
    if (!rows.length) return 'Elige al menos un dato de la respuesta para traer.';
    const intervalN = Number(interval);
    if (!Number.isInteger(intervalN) || intervalN < 5 || intervalN > 1440)
      return 'El intervalo va de 5 a 1440 minutos.';
    const cap = Number(dailyCap);
    const run = Number(perRun);
    if (!Number.isInteger(cap) || cap < 1 || cap > 100000)
      return 'El tope diario va de 1 a 100.000 consultas.';
    if (!Number.isInteger(run) || run < 1 || run > 1000)
      return 'El tope por vuelta va de 1 a 1.000 consultas.';
    if (near && !nearField) return 'Elige la columna con la hora para la regla «cerca de».';
    const everyN = Number(every);
    if (near && (!Number.isInteger(everyN) || everyN < 5 || everyN > 1440))
      return 'Cerca de la hora, el intervalo va de 5 a 1440 minutos.';
    return {
      name: name.trim(),
      urlTemplate: url.trim(),
      credential: credential || null,
      mapping: rows,
      filter: { match: view.match ?? 'all', filters: view.filters.filter(isActiveFilter) },
      intervalMinutes: intervalN,
      near: near
        ? {
            field: nearField,
            beforeMinutes: Math.max(0, Math.min(1440, Math.round(Number(before) || 0))),
            afterMinutes: Math.max(0, Math.min(1440, Math.round(Number(after) || 0))),
            everyMinutes: everyN,
            outside,
          }
        : null,
      dailyCap: cap,
      perRunCap: run,
    };
  };

  const test = async () => {
    const d = draft();
    if (typeof d === 'string') return setError(d);
    setError(null);
    setBusy('test');
    const r: ActionResult<{ preview: LookupPreviewView }> = await actions.preview(trackerId, d);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    setPreview(r.preview);
  };

  const save = async () => {
    const d = draft();
    if (typeof d === 'string') return setError(d);
    setError(null);
    setBusy('save');
    const r = await actions.create(trackerId, d);
    setBusy(null);
    if (!r.ok) return setError(r.error);
    onDone(r.message);
    onOpenChange(false);
  };

  const credHost = credentials.find((c) => c.slug === credential)?.host;
  const field = 'field-label mb-1 block';
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title="Agregar consulta automática"
      description={`Pregunta a una API por cada fila de «${trackerName}» que cumpla el filtro y escribe la respuesta en la fila.`}
      side="right"
      footer={
        <>
          <button type="button" onClick={() => onOpenChange(false)} className={ghostButton}>
            Cancelar
          </button>
          <button type="button" disabled={busy !== null} onClick={test} className={ghostButton}>
            {busy === 'test' ? 'Probando…' : 'Probar con una fila'}
          </button>
          <button type="button" disabled={busy !== null} onClick={save} className={primaryButton}>
            {busy === 'save' ? 'Guardando…' : 'Guardar consulta'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div>
          <label htmlFor={ids.name} className={field}>
            Nombre
          </label>
          <input
            id={ids.name}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            placeholder="Ej.: Estado del vuelo"
            className={inputClass}
          />
        </div>

        <div>
          <label htmlFor={ids.url} className={field}>
            Dirección de la API
          </label>
          <input
            id={ids.url}
            ref={urlRef}
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setPreview(null);
            }}
            placeholder={DEFAULT_URL_HINT}
            spellCheck={false}
            className={clsx(inputClass, 'font-mono text-xs')}
          />
          <p className="mt-1 text-micro text-ink-faint">
            Toca una columna para ponerla en la dirección. Con formato: {'{fecha:YYYY-MM-DD}'},{' '}
            {'{vuelo:compact}'}. Si a una fila le falta un campo, no se consulta.
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {tableColumns.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() =>
                  insertToken(
                    c.type === 'date' || c.type === 'datetime'
                      ? `{${c.key}:YYYY-MM-DD}`
                      : `{${c.key}}`,
                  )
                }
                className="rounded-pill border border-border bg-surface-2 px-2.5 py-1 text-micro font-semibold text-ink hover:border-primary/40"
              >
                {c.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => insertToken('{hoy:YYYY-MM-DD}')}
              className="rounded-pill border border-primary/20 bg-primary-soft px-2.5 py-1 text-micro font-semibold text-primary-ink"
            >
              Hoy
            </button>
          </div>
        </div>

        <div>
          <label htmlFor={ids.cred} className={field}>
            Credencial
          </label>
          <select
            id={ids.cred}
            value={credential}
            onChange={(e) => {
              setCredential(e.target.value);
              setPreview(null);
            }}
            className={clsx(selectClass, 'w-full')}
          >
            <option value="">Sin llave (API pública)</option>
            {credentials.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name} · {c.host}
              </option>
            ))}
          </select>
          <p className="mt-1 text-micro text-ink-faint">
            {credHost
              ? `La llave sólo se envía a ${credHost}: la dirección tiene que ser de ese servidor.`
              : 'La llave vive cifrada en Herramientas propias (admin); aquí no se ve ni se copia.'}
          </p>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className={field}>Qué traer de la respuesta</legend>
          {mapping.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: un renglón no tiene identidad propia.
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <input
                value={m.path}
                onChange={(e) =>
                  setMapping((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, path: e.target.value } : r)),
                  )
                }
                aria-label="Dato de la respuesta"
                placeholder="arrival.estimated"
                spellCheck={false}
                className={clsx(inputClass, 'min-w-0 flex-1 font-mono text-xs')}
              />
              <span className="text-micro text-ink-faint">→</span>
              <select
                value={m.field}
                onChange={(e) =>
                  setMapping((rows) =>
                    rows.map((r, j) => (j === i ? { ...r, field: e.target.value } : r)),
                  )
                }
                aria-label="Columna donde se escribe"
                className={clsx(selectClass, 'min-w-0 flex-1')}
              >
                <option value="">Columna…</option>
                {tableColumns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
                <option value="__new">+ Columna nueva (texto)</option>
              </select>
              {m.field === '__new' ? (
                <input
                  value={m.label}
                  onChange={(e) =>
                    setMapping((rows) =>
                      rows.map((r, j) => (j === i ? { ...r, label: e.target.value } : r)),
                    )
                  }
                  aria-label="Nombre de la columna nueva"
                  placeholder="Nombre"
                  maxLength={60}
                  className={clsx(inputClass, 'w-full')}
                />
              ) : null}
              {mapping.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setMapping((rows) => rows.filter((_, j) => j !== i))}
                  className="grid h-8 w-8 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink"
                  aria-label="Quitar renglón"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              ) : null}
            </div>
          ))}
          {mapping.length < 10 ? (
            <button
              type="button"
              onClick={() => setMapping((rows) => [...rows, { path: '', field: '', label: '' }])}
              className={clsx(ghostButton, 'w-fit')}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Otro dato
            </button>
          ) : null}
        </fieldset>

        <div className="rounded-card border border-border p-3">
          <FilterPanel
            columns={tableColumns}
            view={view}
            setView={(update) => {
              setView(update);
              setPreview(null);
            }}
          />
          <p className="mt-3 text-micro text-ink-faint">
            El filtro también es la regla de parada: cuando una fila deja de cumplirlo (por ejemplo,
            «Estado no es ninguno de aterrizado»), ya no se consulta. Para «es hoy», usa «en los
            últimos … días» con 0.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <div>
            <label htmlFor={ids.interval} className={field}>
              Cada cuánto consulta cada fila (minutos, mínimo 5)
            </label>
            <input
              id={ids.interval}
              type="number"
              min={5}
              max={1440}
              value={interval}
              onChange={(e) => setIntervalMinutes(e.target.value)}
              className={clsx(inputClass, 'tabular w-28')}
            />
          </div>
          <label htmlFor={ids.near} className="flex items-center gap-2 text-xs text-ink-muted">
            <input
              id={ids.near}
              type="checkbox"
              checked={near}
              onChange={(e) => setNear(e.target.checked)}
            />
            Consultar más seguido cerca de una hora (por ejemplo, la llegada)
          </label>
          {near ? (
            <div className="flex flex-col gap-2 rounded-sm border border-border bg-surface-2/50 p-3">
              <select
                value={nearField}
                onChange={(e) => setNearField(e.target.value)}
                aria-label="Columna con la hora"
                className={clsx(selectClass, 'w-full')}
              >
                <option value="">Columna con la hora…</option>
                {timeColumns.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              <div className="flex flex-wrap items-center gap-2 text-micro text-ink-muted">
                Desde
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={before}
                  onChange={(e) => setBefore(e.target.value)}
                  aria-label="Minutos antes"
                  className={clsx(inputClass, 'tabular w-20')}
                />
                min antes hasta
                <input
                  type="number"
                  min={0}
                  max={1440}
                  value={after}
                  onChange={(e) => setAfter(e.target.value)}
                  aria-label="Minutos después"
                  className={clsx(inputClass, 'tabular w-20')}
                />
                min después, cada
                <input
                  type="number"
                  min={5}
                  max={1440}
                  value={every}
                  onChange={(e) => setEvery(e.target.value)}
                  aria-label="Cada cuántos minutos"
                  className={clsx(inputClass, 'tabular w-20')}
                />
                min.
              </div>
              <select
                value={outside}
                onChange={(e) => setOutside(e.target.value as 'base' | 'skip')}
                aria-label="Fuera de ese rato"
                className={clsx(selectClass, 'w-full')}
              >
                <option value="base">Fuera de ese rato: al intervalo de arriba</option>
                <option value="skip">Fuera de ese rato: no consultar</option>
              </select>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-4">
          <div>
            <label htmlFor={ids.cap} className={field}>
              Tope de consultas al día
            </label>
            <input
              id={ids.cap}
              type="number"
              min={1}
              max={100000}
              value={dailyCap}
              onChange={(e) => setDailyCap(e.target.value)}
              className={clsx(inputClass, 'tabular w-32')}
            />
          </div>
          <div>
            <label htmlFor={ids.run} className={field}>
              Tope por vuelta
            </label>
            <input
              id={ids.run}
              type="number"
              min={1}
              max={1000}
              value={perRun}
              onChange={(e) => setPerRun(e.target.value)}
              className={clsx(inputClass, 'tabular w-32')}
            />
          </div>
        </div>
        <p className="-mt-2 text-micro text-ink-faint">
          Al llegar al tope del día se detiene, te avisa una vez y sigue a medianoche (hora de
          Bogotá).
        </p>

        {preview ? (
          <output
            className={clsx(
              'block rounded-card border p-3 text-xs',
              preview.ok
                ? 'border-emerald/30 bg-emerald-soft/40'
                : 'border-rose/30 bg-rose-soft/40',
            )}
          >
            <p className="font-bold text-ink">
              {preview.ok
                ? `Así quedaría «${preview.rowLabel ?? 'la fila'}»`
                : (preview.message ?? 'La prueba no trajo nada.')}
            </p>
            {preview.url ? (
              <p className="mt-1 break-all font-mono text-micro text-ink-muted">{preview.url}</p>
            ) : null}
            {preview.fields.length ? (
              <ul className="mt-2 flex flex-col gap-1">
                {preview.fields.map((f) => (
                  <li key={f.label} className="text-micro">
                    <span className="font-semibold text-ink">{f.label}:</span>{' '}
                    <span className="text-ink-muted">{f.current ? `«${f.current}»` : 'vacío'}</span>{' '}
                    →{' '}
                    <span className="font-semibold text-ink">
                      {f.next ? `«${f.next}»` : 'sin dato'}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {preview.ok && preview.message ? (
              <p className="mt-1 text-micro text-ink-muted">{preview.message}</p>
            ) : null}
            <p className="mt-2 text-micro text-ink-faint">La prueba no escribe nada en la tabla.</p>
          </output>
        ) : null}

        {error ? (
          <p role="alert" className="text-micro font-semibold text-rose">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
