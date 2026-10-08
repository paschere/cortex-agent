'use client';

import { saveHomeAction } from '@/lib/apps/appearance-actions';
import type { AppHome, HomeCard } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  type AppEditorData,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  ErrorLine,
  INPUT,
  SCREEN_ICONS,
} from './shared';

/**
 * «INICIO» (0215): la primera pantalla de la app, hecha de tarjetas por rol.
 *
 * Tres clases, ninguna más:
 *   - Contador: «Hoy llegan {n} vuelos» sobre una tabla con filtros.
 *   - Pendientes: «{n} guías duplicadas por corregir», con las primeras filas y
 *     un enlace a la lista (ya filtrada, si la pantalla tiene barra de filtros).
 *   - Acceso directo: «Registrar atención» → una pantalla.
 *
 * Las cifras respetan lo que cada rol puede VER: se calculan con el mismo
 * scope de filas de la pantalla. Una tarjeta sobre una tabla que el rol no lee
 * no aparece. En un filtro de fecha puedes escribir {hoy}, {ayer} o {manana}.
 */

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
  { value: 'next_days', label: 'en los próximos (días)' },
  { value: 'last_days', label: 'en los últimos (días)' },
];

const TONES: Array<{ value: HomeCard['tone']; label: string }> = [
  { value: 'primary', label: 'Color de la app' },
  { value: 'emerald', label: 'Verde' },
  { value: 'amber', label: 'Ámbar' },
  { value: 'sky', label: 'Celeste' },
  { value: 'rose', label: 'Rojo' },
];

const BUILTIN = [
  { key: 'label', label: 'Nombre de la fila' },
  { key: 'created_at', label: 'Fecha de creación' },
  { key: 'updated_at', label: 'Última actualización' },
];

type Card = HomeCard;

function newId(cards: Card[], prefix: string): string {
  for (let i = cards.length + 1; i < 99; i++) {
    const id = `${prefix}${i}`;
    if (!cards.some((c) => c.id === id)) return id;
  }
  return `${prefix}${Date.now()}`;
}

export function HomeTab({ data }: { data: AppEditorData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [enabled, setEnabled] = useState(data.home?.enabled ?? false);
  const [greeting, setGreeting] = useState(data.home?.greeting ?? true);
  const [cards, setCards] = useState<Card[]>(data.home?.cards ?? []);
  const firstTracker = data.homeTrackers[0]?.slug ?? '';
  const firstScreen = data.screens[0]?.slug ?? '';

  function patch(index: number, change: Partial<Card>) {
    setSaved(false);
    setCards((all) => all.map((c, i) => (i === index ? ({ ...c, ...change } as Card) : c)));
  }
  function add(kind: Card['kind']) {
    setSaved(false);
    setCards((all) => {
      if (all.length >= 8) return all;
      if (kind === 'shortcut')
        return [
          ...all,
          {
            id: newId(all, 'acceso'),
            kind,
            roles: [],
            tone: 'primary',
            label: 'Registrar',
            screen: firstScreen,
          },
        ];
      return [
        ...all,
        kind === 'counter'
          ? {
              id: newId(all, 'cifra'),
              kind,
              roles: [],
              tone: 'primary',
              source: firstTracker,
              filters: [],
              text: 'Hay {n} registros',
            }
          : {
              id: newId(all, 'pendiente'),
              kind,
              roles: [],
              tone: 'amber',
              source: firstTracker,
              filters: [],
              text: '{n} por revisar',
              zeroText: 'Todo al día',
            },
      ];
    });
  }
  function move(index: number, by: -1 | 1) {
    setSaved(false);
    setCards((all) => {
      const to = index + by;
      if (to < 0 || to >= all.length) return all;
      const next = [...all];
      const [item] = next.splice(index, 1);
      if (item) next.splice(to, 0, item);
      return next;
    });
  }

  function save() {
    setError(null);
    start(async () => {
      const home: AppHome = { enabled, greeting, cards };
      const res = await saveHomeAction(data.app.id, home);
      if (!res.ok) return setError(res.error);
      setSaved(true);
      router.refresh();
    });
  }

  const label = 'text-micro font-semibold uppercase tracking-field text-ink-faint';
  const select =
    'h-8 rounded-pill border border-border bg-surface px-2.5 text-xs text-ink outline-none focus:border-primary';

  return (
    <div className="space-y-4">
      <section className={clsx(CARD, 'space-y-3')}>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-ink">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setSaved(false);
              }}
              className="h-4 w-4 accent-primary"
            />
            La app abre en «Inicio»
          </label>
          <label className="flex min-h-11 items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              checked={greeting}
              onChange={(e) => {
                setGreeting(e.target.checked);
                setSaved(false);
              }}
              className="h-4 w-4 accent-primary"
            />
            Saludo con el nombre y la fecha
          </label>
        </div>
        <p className="text-xs text-ink-muted">
          «Inicio» es una pantalla más del menú, la primera. Cada persona ve sólo las tarjetas de su
          rol, con cifras de lo que su rol puede ver. También puedes pedirle a Cortex en el chat:
          «agrega al inicio una tarjeta con los vuelos de hoy».
        </p>
      </section>

      {cards.length === 0 && (
        <p className="rounded-card border border-dashed border-border-strong bg-surface px-4 py-6 text-center text-sm text-ink-muted">
          Aún no hay tarjetas. Agrega un contador, una lista de pendientes o un acceso directo.
        </p>
      )}

      {cards.map((card, i) => (
        <section key={card.id} className={clsx(CARD, 'space-y-3')}>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-ink">
              {card.kind === 'counter'
                ? 'Contador'
                : card.kind === 'pending'
                  ? 'Pendientes'
                  : 'Acceso directo'}
            </h3>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="Subir tarjeta"
                disabled={i === 0}
                onClick={() => move(i, -1)}
                className="grid h-9 w-9 place-items-center rounded-pill text-ink-faint hover:text-ink disabled:opacity-30"
              >
                <ArrowUp className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                aria-label="Bajar tarjeta"
                disabled={i === cards.length - 1}
                onClick={() => move(i, 1)}
                className="grid h-9 w-9 place-items-center rounded-pill text-ink-faint hover:text-ink disabled:opacity-30"
              >
                <ArrowDown className="h-4 w-4" aria-hidden />
              </button>
              <button
                type="button"
                aria-label="Quitar tarjeta"
                onClick={() => {
                  setSaved(false);
                  setCards((all) => all.filter((_, j) => j !== i));
                }}
                className="grid h-9 w-9 place-items-center rounded-pill text-rose hover:bg-rose-soft"
              >
                <Trash2 className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>

          {card.kind === 'shortcut' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className={label}>Texto</span>
                <input
                  value={card.label}
                  maxLength={40}
                  onChange={(e) => patch(i, { label: e.target.value })}
                  className={clsx(INPUT, 'w-full')}
                />
              </label>
              <label className="block space-y-1">
                <span className={label}>Abre la pantalla</span>
                <select
                  value={card.screen}
                  onChange={(e) => patch(i, { screen: e.target.value })}
                  className={clsx(select, 'w-full')}
                >
                  {data.screens.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block space-y-1">
                <span className={label}>Pista (opcional)</span>
                <input
                  value={card.hint ?? ''}
                  maxLength={80}
                  onChange={(e) => patch(i, { hint: e.target.value })}
                  className={clsx(INPUT, 'w-full')}
                />
              </label>
              <label className="block space-y-1">
                <span className={label}>Ícono</span>
                <select
                  value={card.icon ?? 'ClipboardPlus'}
                  onChange={(e) => patch(i, { icon: e.target.value })}
                  className={clsx(select, 'w-full')}
                >
                  {SCREEN_ICONS.map((ic) => (
                    <option key={ic.name} value={ic.name}>
                      {ic.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : (
            <CountFields
              card={card}
              data={data}
              select={select}
              label={label}
              onChange={(change) => patch(i, change)}
            />
          )}

          <div className="space-y-1">
            <span className={label}>Quién la ve (sin marcar = todos los roles)</span>
            <div className="flex flex-wrap gap-1.5">
              {data.roles.map((r) => {
                const on = card.roles.includes(r.key);
                return (
                  <button
                    key={r.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      patch(i, {
                        roles: on ? card.roles.filter((k) => k !== r.key) : [...card.roles, r.key],
                      })
                    }
                    className={clsx(
                      'inline-flex min-h-9 items-center rounded-pill border px-3 text-xs font-semibold transition-colors',
                      on
                        ? 'border-primary bg-primary-soft text-primary-ink'
                        : 'border-border bg-surface text-ink-muted hover:text-ink',
                    )}
                  >
                    {r.name}
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        {(
          [
            ['counter', 'Contador'],
            ['pending', 'Pendientes'],
            ['shortcut', 'Acceso directo'],
          ] as const
        ).map(([kind, text]) => (
          <button
            key={kind}
            type="button"
            disabled={cards.length >= 8 || (kind !== 'shortcut' && !firstTracker) || !firstScreen}
            onClick={() => add(kind)}
            className={BTN_SECONDARY}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> {text}
          </button>
        ))}
      </div>

      <ErrorLine error={error} />
      <div className="flex items-center gap-3">
        <button type="button" disabled={pending} onClick={save} className={BTN_PRIMARY}>
          Guardar inicio
        </button>
        {saved && <output className="text-xs font-medium text-emerald">Guardado.</output>}
      </div>
    </div>
  );
}

function CountFields({
  card,
  data,
  select,
  label,
  onChange,
}: {
  card: Extract<Card, { kind: 'counter' | 'pending' }>;
  data: AppEditorData;
  select: string;
  label: string;
  onChange: (change: Partial<Card>) => void;
}) {
  const tracker = data.homeTrackers.find((t) => t.slug === card.source);
  const fields = [...BUILTIN, ...(tracker?.fields ?? [])];
  const bar = card.screen ? (data.screenFilters[card.screen] ?? []) : [];
  const filters = card.filters;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className={label}>Cuenta las filas de</span>
          <select
            value={card.source}
            onChange={(e) => onChange({ source: e.target.value, filters: [] })}
            className={clsx(select, 'w-full')}
          >
            {data.homeTrackers.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className={label}>Color</span>
          <select
            value={card.tone}
            onChange={(e) => onChange({ tone: e.target.value as HomeCard['tone'] })}
            className={clsx(select, 'w-full')}
          >
            {TONES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="space-y-1.5">
        <span className={label}>Solo las filas donde…</span>
        {filters.map((f, j) => {
          const op = OPS.find((o) => o.value === f.op);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: los filtros no tienen id y se editan en su sitio
            <div key={j} className="flex flex-wrap items-center gap-1.5">
              <select
                value={f.field}
                onChange={(e) =>
                  onChange({
                    filters: filters.map((x, k) => (k === j ? { ...x, field: e.target.value } : x)),
                  })
                }
                className={select}
                aria-label="Campo"
              >
                {fields.map((fl) => (
                  <option key={fl.key} value={fl.key}>
                    {fl.label}
                  </option>
                ))}
              </select>
              <select
                value={f.op}
                onChange={(e) =>
                  onChange({
                    filters: filters.map((x, k) =>
                      k === j ? { ...x, op: e.target.value as typeof f.op } : x,
                    ),
                  })
                }
                className={select}
                aria-label="Condición"
              >
                {OPS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {!op?.valueless && (
                <input
                  value={String(f.value ?? '')}
                  onChange={(e) =>
                    onChange({
                      filters: filters.map((x, k) =>
                        k === j ? { ...x, value: e.target.value } : x,
                      ),
                    })
                  }
                  placeholder="{hoy}, Pendiente, 3…"
                  aria-label="Valor"
                  className={clsx(INPUT, 'w-36')}
                />
              )}
              <button
                type="button"
                aria-label="Quitar filtro"
                onClick={() => onChange({ filters: filters.filter((_, k) => k !== j) })}
                className="grid h-8 w-8 place-items-center rounded-pill text-ink-faint hover:text-rose"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          );
        })}
        {filters.length < 6 && (
          <button
            type="button"
            onClick={() =>
              onChange({
                filters: [...filters, { field: fields[0]?.key ?? 'label', op: 'eq', value: '' }],
              })
            }
            className={BTN_SECONDARY}
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Filtro
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className={label}>Texto con la cifra ({'{n}'})</span>
          <input
            value={card.text}
            maxLength={120}
            onChange={(e) => onChange({ text: e.target.value })}
            placeholder="Hoy llegan {n} vuelos"
            className={clsx(INPUT, 'w-full')}
          />
        </label>
        <label className="block space-y-1">
          <span className={label}>Texto si es cero</span>
          <input
            value={card.zeroText ?? ''}
            maxLength={120}
            onChange={(e) => onChange({ zeroText: e.target.value })}
            placeholder="Aún no hay vuelos hoy"
            className={clsx(INPUT, 'w-full')}
          />
        </label>
        <label className="block space-y-1">
          <span className={label}>Al tocarla abre</span>
          <select
            value={card.screen ?? ''}
            onChange={(e) =>
              onChange({
                screen: e.target.value || undefined,
                openFilterId: undefined,
                openFilterValue: undefined,
              })
            }
            className={clsx(select, 'w-full')}
          >
            <option value="">Nada</option>
            {data.screens.map((s) => (
              <option key={s.slug} value={s.slug}>
                {s.title}
              </option>
            ))}
          </select>
        </label>
        {bar.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            <label className="block space-y-1">
              <span className={label}>Ya filtrada por</span>
              <select
                value={card.openFilterId ?? ''}
                onChange={(e) => onChange({ openFilterId: e.target.value || undefined })}
                className={clsx(select, 'w-full')}
              >
                <option value="">Sin filtro</option>
                {bar.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className={label}>Valor</span>
              <input
                value={card.openFilterValue ?? ''}
                maxLength={120}
                disabled={!card.openFilterId}
                onChange={(e) => onChange({ openFilterValue: e.target.value || undefined })}
                className={clsx(INPUT, 'w-full')}
              />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
