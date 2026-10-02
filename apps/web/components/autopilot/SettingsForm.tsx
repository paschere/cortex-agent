'use client';

import { Panel } from '@/components/ui/panel';
import type { SettingsView } from '@/lib/autopilot/screen';
import { endSentence } from '@/lib/autopilot/text';
import { clsx } from 'clsx';
import { CalendarOff, KeyRound, Loader2, Power, Settings2, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import type { AutopilotActions, AutopilotSettingsInput } from './types';

/**
 * CÓMO TRABAJA EL PILOTO: el interruptor, el nivel de cada área, cuándo corre
 * y sus topes. Lo cambia quien administra o es dueño de la empresa; los demás
 * lo ven.
 */

const DAYS: Array<{ n: number; short: string; long: string }> = [
  { n: 1, short: 'L', long: 'lunes' },
  { n: 2, short: 'M', long: 'martes' },
  { n: 3, short: 'X', long: 'miércoles' },
  { n: 4, short: 'J', long: 'jueves' },
  { n: 5, short: 'V', long: 'viernes' },
  { n: 6, short: 'S', long: 'sábado' },
  { n: 7, short: 'D', long: 'domingo' },
];

const LEVEL_HINT = {
  avisar: 'Sólo te cuento lo que vi.',
  proponer: 'Te lo dejo listo para aprobar.',
  hacer: 'Hago lo rutinario; lo demás te lo propongo.',
} as const;

const HOURS = Array.from({ length: 24 }, (_, h) => h);

function hourOption(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${h < 12 ? 'a. m.' : 'p. m.'}`;
}

const fieldClass =
  'min-h-10 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-primary focus:ring-2 focus:ring-primary/15 disabled:opacity-60';

export function SettingsForm({
  view,
  actions,
  canEdit,
}: {
  view: SettingsView;
  actions: AutopilotActions;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [levels, setLevels] = useState(
    Object.fromEntries(view.areas.map((a) => [a.area, a.level])) as Record<
      string,
      'avisar' | 'proponer' | 'hacer'
    >,
  );
  const [runHour, setRunHour] = useState(view.runHour);
  const [runDays, setRunDays] = useState(view.runDays);
  const [skipHolidays, setSkipHolidays] = useState(view.skipHolidays);
  const [quietDays, setQuietDays] = useState(view.quietDays);
  const [newQuiet, setNewQuiet] = useState('');
  const [maxExternal, setMaxExternal] = useState(view.maxExternalMessages);
  const [maxActions, setMaxActions] = useState(view.maxActionsPerRun);
  const [maxAmount, setMaxAmount] = useState(view.maxAmountReferenced);
  const [notifyEmail, setNotifyEmail] = useState(view.notifyEmail);

  const dirty = useMemo(
    () =>
      view.areas.some((a) => levels[a.area] !== a.level) ||
      runHour !== view.runHour ||
      runDays.join() !== view.runDays.join() ||
      skipHolidays !== view.skipHolidays ||
      quietDays.join() !== view.quietDays.join() ||
      maxExternal !== view.maxExternalMessages ||
      maxActions !== view.maxActionsPerRun ||
      maxAmount !== view.maxAmountReferenced ||
      notifyEmail !== view.notifyEmail,
    [
      view,
      levels,
      runHour,
      runDays,
      skipHolidays,
      quietDays,
      maxExternal,
      maxActions,
      maxAmount,
      notifyEmail,
    ],
  );

  const send = (input: AutopilotSettingsInput) =>
    start(async () => {
      const r = await actions.save(input);
      setNote({ ok: r.ok, text: r.note });
      if (r.ok) router.refresh();
    });

  const save = () =>
    send({
      areaLevels: levels,
      runHour,
      runDays,
      skipHolidays,
      quietDays,
      maxExternalMessages: maxExternal,
      maxActionsPerRun: maxActions,
      maxAmountReferenced: maxAmount,
      notifyEmail,
    });

  const toggleDay = (n: number) =>
    setRunDays((d) => (d.includes(n) ? d.filter((x) => x !== n) : [...d, n].sort()));

  const disabled = !canEdit || pending;

  return (
    <div className="space-y-4">
      {/* EL INTERRUPTOR. Arriba de todo y solo: apagarlo es inmediato. */}
      <Panel className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span
              className={clsx(
                'mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-sm',
                view.enabled ? 'bg-emerald-soft text-emerald' : 'bg-surface-2 text-ink-faint',
              )}
            >
              <Power className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-lg font-extrabold text-ink">
                {view.enabled ? 'Encendido' : 'Apagado'}
              </p>
              <p className="text-sm text-ink-muted">
                {view.enabled
                  ? `Próxima corrida: ${endSentence(view.nextRunLabel)} Actúo en nombre de ${view.actorLabel ?? 'quien lo encendió'}.`
                  : 'No hago nada solo hasta que lo enciendas. Puedes probarlo antes sin que haga nada.'}
              </p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={view.enabled}
            aria-label={
              view.enabled ? 'Apagar el piloto automático' : 'Encender el piloto automático'
            }
            disabled={disabled}
            onClick={() => send({ enabled: !view.enabled })}
            className={clsx(
              'inline-flex min-h-10 items-center gap-2 rounded-pill px-5 py-2 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              view.enabled
                ? 'border border-rose/30 bg-surface text-rose hover:bg-rose-soft'
                : 'cortex-primary-button bg-primary text-white hover:bg-primary-strong',
            )}
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {view.enabled ? 'Apagar ya' : 'Encender el piloto'}
          </button>
        </div>
        {view.enabled && (
          <p className="mt-3 text-xs text-ink-faint">
            Apagarlo detiene en ese mismo instante lo que esté haciendo: lo que falte queda
            «omitido».
          </p>
        )}
      </Panel>

      <Panel className="p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
              <Settings2 className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-extrabold text-ink">Qué hago en cada área</h2>
              <p className="mt-0.5 max-w-xl text-xs text-ink-muted">
                Nunca muevo plata solo. Un correo a un cliente sólo sale sin tu clic si un mandato
                lo permite también sin nadie mirando. Lo demás, como lo decidas aquí.
              </p>
            </div>
          </div>
          <Link
            href="/admin/mandates"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 py-1.5 text-xs font-semibold text-ink hover:bg-surface-2"
          >
            <KeyRound className="h-3.5 w-3.5" aria-hidden />
            Lo que puedo hacer sin preguntar
          </Link>
        </div>

        <ul className="divide-y divide-border">
          {view.areas.map((a) => (
            <li
              key={a.area}
              className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="text-sm font-bold text-ink">{a.label}</p>
                <p className="text-xs text-ink-muted">{a.hint}</p>
              </div>
              <fieldset className="shrink-0" disabled={disabled}>
                <legend className="sr-only">Nivel de {a.label}</legend>
                <div className="inline-flex rounded-pill border border-border bg-surface-2 p-0.5">
                  {a.levels.map((l) => {
                    const active = levels[a.area] === l.level;
                    return (
                      <button
                        key={l.level}
                        type="button"
                        title={l.disabled ? 'En pagos nunca hago nada solo.' : LEVEL_HINT[l.level]}
                        aria-pressed={active}
                        disabled={l.disabled || disabled}
                        onClick={() => setLevels((s) => ({ ...s, [a.area]: l.level }))}
                        className={clsx(
                          'min-h-8 rounded-pill px-3 py-1 text-xs font-semibold transition-colors disabled:cursor-not-allowed',
                          active
                            ? 'bg-surface text-primary-ink shadow-card'
                            : 'text-ink-muted hover:text-ink',
                          l.disabled && 'opacity-40',
                        )}
                      >
                        {l.label}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            </li>
          ))}
        </ul>

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <fieldset disabled={disabled} className="space-y-3">
            <legend className="text-sm font-extrabold text-ink">Cuándo corro</legend>
            <label className="block text-xs font-semibold text-ink-muted">
              Hora (Bogotá)
              <select
                className={clsx(fieldClass, 'mt-1')}
                value={runHour}
                onChange={(e) => setRunHour(Number(e.target.value))}
              >
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {hourOption(h)}
                  </option>
                ))}
              </select>
            </label>
            <div>
              <p className="text-xs font-semibold text-ink-muted">Días</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {DAYS.map((d) => {
                  const on = runDays.includes(d.n);
                  return (
                    <button
                      key={d.n}
                      type="button"
                      aria-pressed={on}
                      aria-label={d.long}
                      title={d.long}
                      onClick={() => toggleDay(d.n)}
                      disabled={disabled || (on && runDays.length === 1)}
                      className={clsx(
                        'grid h-9 w-9 place-items-center rounded-full border text-xs font-bold transition-colors',
                        on
                          ? 'border-primary bg-primary-soft text-primary-ink'
                          : 'border-border bg-surface text-ink-muted hover:border-border-strong',
                      )}
                    >
                      {d.short}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={skipHolidays}
                onChange={(e) => setSkipHolidays(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              No correr en festivos de Colombia
            </label>
            <div>
              <p className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
                <CalendarOff className="h-3.5 w-3.5" aria-hidden />
                Días sin piloto (cierres, vacaciones colectivas)
              </p>
              <div className="mt-1 flex gap-2">
                <input
                  type="date"
                  className={fieldClass}
                  value={newQuiet}
                  onChange={(e) => setNewQuiet(e.target.value)}
                  aria-label="Agregar un día sin piloto"
                />
                <button
                  type="button"
                  disabled={disabled || !newQuiet || quietDays.includes(newQuiet)}
                  onClick={() => {
                    setQuietDays((q) => [...q, newQuiet].sort());
                    setNewQuiet('');
                  }}
                  className="inline-flex min-h-10 shrink-0 items-center rounded-pill border border-border-strong bg-surface px-4 text-xs font-semibold text-ink hover:bg-surface-2 disabled:opacity-50"
                >
                  Agregar
                </button>
              </div>
              {quietDays.length > 0 && (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                  {quietDays.map((d) => (
                    <li
                      key={d}
                      className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface-2 px-2.5 py-0.5 text-xs text-ink-muted"
                    >
                      {d}
                      <button
                        type="button"
                        aria-label={`Quitar ${d}`}
                        onClick={() => setQuietDays((q) => q.filter((x) => x !== d))}
                        className="text-ink-faint hover:text-rose"
                      >
                        <X className="h-3 w-3" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </fieldset>

          <fieldset disabled={disabled} className="space-y-3">
            <legend className="text-sm font-extrabold text-ink">Topes del día</legend>
            <label className="block text-xs font-semibold text-ink-muted">
              Cosas que hago solo por corrida
              <input
                type="number"
                min={1}
                max={100}
                className={clsx(fieldClass, 'mt-1')}
                value={maxActions}
                onChange={(e) =>
                  setMaxActions(Math.max(1, Math.min(100, Number(e.target.value) || 1)))
                }
              />
            </label>
            <label className="block text-xs font-semibold text-ink-muted">
              Mensajes que salen de la empresa sin tu clic
              <input
                type="number"
                min={0}
                max={50}
                className={clsx(fieldClass, 'mt-1')}
                value={maxExternal}
                onChange={(e) =>
                  setMaxExternal(Math.max(0, Math.min(50, Number(e.target.value) || 0)))
                }
              />
            </label>
            <label className="block text-xs font-semibold text-ink-muted">
              Plata mencionada en lo que hago solo ({view.currency})
              <input
                type="number"
                min={0}
                step={100000}
                className={clsx(fieldClass, 'mt-1')}
                value={maxAmount}
                onChange={(e) => setMaxAmount(Math.max(0, Number(e.target.value) || 0))}
              />
            </label>
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                checked={notifyEmail}
                onChange={(e) => setNotifyEmail(e.target.checked)}
                className="h-4 w-4"
              />
              Además de la campana, mandarme el resumen por correo
            </label>
            <p className="text-xs text-ink-faint">
              Lo que no cabe en un tope no se pierde: queda en «Necesita tu decisión».
            </p>
          </fieldset>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border pt-4">
          {canEdit ? (
            <button
              type="button"
              onClick={save}
              disabled={disabled || !dirty}
              className="cortex-primary-button inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-5 py-1.5 text-xs font-bold text-white transition-colors hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Guardar cambios
            </button>
          ) : (
            <p className="text-xs text-ink-muted">
              Sólo un administrador o el dueño de la empresa cambia esto.
            </p>
          )}
          {note && (
            <p
              role={note.ok ? 'status' : 'alert'}
              className={clsx('text-xs font-semibold', note.ok ? 'text-emerald' : 'text-rose')}
            >
              {note.text}
            </p>
          )}
        </div>
      </Panel>
    </div>
  );
}
