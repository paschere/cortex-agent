'use client';

import {
  DAY_NAME,
  HOUR_STEPS,
  MODE_LABEL,
  type PickerMode,
  type ScheduleDraft,
  type SchedulePicker,
  WEEK_CHIPS,
  describeDraft,
  formatRun,
  nextRunsForDraft,
  searchTimezones,
  todayIn,
  tzLabel,
  withPicker,
  withRawCron,
} from '@/lib/schedule-picker';
import { CHIP_BASE, CHIP_INTERACTIVE } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { AlarmClock, ChevronDown, Globe, Search } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';

const INPUT =
  'rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10';

const MODES: PickerMode[] = ['daily', 'weekdays', 'days', 'weekly', 'monthly', 'hourly', 'once'];

const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0'));

/**
 * El selector de horario de una rutina: «Cada día», «Días hábiles», chips de
 * días, «Cada mes el día…», «Cada X horas» o «Una sola vez», más la hora, la
 * zona (por defecto «Hora de Colombia») y, debajo, la frase de lo que
 * significa y las próximas tres ejecuciones.
 *
 * Controlado: el estado vive en un `ScheduleDraft` (lib/schedule-picker.ts),
 * que también decide qué se guarda (`resolveDraft`). «Avanzado: expresión
 * cron» va y vuelve con el selector: lo que se escribe allí se refleja en los
 * controles cuando cabe en ellos, y si no cabe, manda la expresión.
 *
 * `allowOnce={false}` esconde «Una sola vez» donde no se puede guardar.
 */
export function SchedulePickerField({
  value,
  onChange,
  allowOnce = true,
  idPrefix,
}: {
  value: ScheduleDraft;
  onChange: (next: ScheduleDraft) => void;
  allowOnce?: boolean;
  idPrefix?: string;
}) {
  const autoId = useId();
  const id = idPrefix ?? autoId;
  const { picker, timezone } = value;
  const [advancedOpen, setAdvancedOpen] = useState(value.custom);
  const [tzOpen, setTzOpen] = useState(false);

  // Las fechas dependen del reloj: se calculan después de montar para que el
  // HTML del servidor y el del navegador coincidan.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  // Una expresión escrita a mano que no cabe en el selector deja «Avanzado» abierto.
  useEffect(() => {
    if (value.custom) setAdvancedOpen(true);
  }, [value.custom]);

  const runs = useMemo(() => (now ? nextRunsForDraft(value, now, 3) : []), [value, now]);
  const sentence = describeDraft(value);
  const set = (patch: Partial<SchedulePicker>) =>
    onChange(withPicker(value, { ...picker, ...patch }));
  const modes = allowOnce ? MODES : MODES.filter((m) => m !== 'once');

  return (
    <div className="space-y-3">
      {/* ¿Con qué frecuencia? */}
      <fieldset disabled={value.custom} className={clsx(value.custom && 'opacity-50')}>
        <legend className="field-label mb-1.5">¿Cuándo corre?</legend>
        <div className="flex flex-wrap gap-1.5">
          {modes.map((mode) => {
            const active = !value.custom && picker.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={active}
                onClick={() => set({ mode })}
                className={clsx(
                  CHIP_BASE,
                  CHIP_INTERACTIVE,
                  'px-3 py-1 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  active
                    ? 'border-primary/30 bg-primary-soft text-primary-ink'
                    : 'border-border bg-surface text-ink-muted hover:text-ink',
                )}
              >
                {MODE_LABEL[mode]}
              </button>
            );
          })}
        </div>

        {/* Lo que depende del modo, y la hora. */}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {picker.mode === 'days' && (
            <div className="w-full">
              <span className="field-label mb-1.5 block">Días</span>
              <div className="flex flex-wrap gap-1.5">
                {WEEK_CHIPS.map((chip) => {
                  const on = picker.days.includes(chip.day);
                  return (
                    <button
                      key={chip.day}
                      type="button"
                      aria-pressed={on}
                      aria-label={chip.name}
                      title={chip.name}
                      onClick={() =>
                        set({
                          days: on
                            ? picker.days.filter((d) => d !== chip.day)
                            : [...picker.days, chip.day],
                        })
                      }
                      className={clsx(
                        'grid h-9 w-9 place-items-center rounded-full border text-xs font-bold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                        on
                          ? 'border-primary bg-primary text-white'
                          : 'border-border bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      {chip.short}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {picker.mode === 'weekly' && (
            <label className="flex min-w-[150px] flex-1 flex-col gap-1">
              <span className="field-label">El día</span>
              <select
                value={picker.weekday}
                onChange={(e) => set({ weekday: Number(e.target.value) })}
                className={INPUT}
              >
                {WEEK_CHIPS.map((c) => (
                  <option key={c.day} value={c.day}>
                    {DAY_NAME[c.day]}
                  </option>
                ))}
              </select>
            </label>
          )}

          {picker.mode === 'monthly' && (
            <label className="flex min-w-[150px] flex-1 flex-col gap-1">
              <span className="field-label">El día del mes</span>
              <select
                value={picker.monthDay}
                onChange={(e) => set({ monthDay: Number(e.target.value) })}
                className={clsx(INPUT, 'tabular')}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
          )}

          {picker.mode === 'hourly' && (
            <>
              <label className="flex min-w-[130px] flex-1 flex-col gap-1">
                <span className="field-label">Cada</span>
                <select
                  value={picker.everyHours}
                  onChange={(e) => set({ everyHours: Number(e.target.value) })}
                  className={INPUT}
                >
                  {HOUR_STEPS.map((h) => (
                    <option key={h} value={h}>
                      {h === 1 ? '1 hora' : `${h} horas`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-[130px] flex-1 flex-col gap-1">
                <span className="field-label">En el minuto</span>
                <select
                  value={picker.time.split(':')[1] ?? '00'}
                  onChange={(e) =>
                    set({ time: `${picker.time.split(':')[0] || '00'}:${e.target.value}` })
                  }
                  className={clsx(INPUT, 'tabular')}
                >
                  {MINUTES.includes(picker.time.split(':')[1] ?? '00') ? null : (
                    <option value={picker.time.split(':')[1]}>{picker.time.split(':')[1]}</option>
                  )}
                  {MINUTES.map((m) => (
                    <option key={m} value={m}>
                      {m === '00' ? 'en punto (:00)' : `:${m}`}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}

          {picker.mode === 'once' && (
            <label className="flex min-w-[160px] flex-1 flex-col gap-1">
              <span className="field-label">Fecha</span>
              <input
                type="date"
                value={picker.date}
                min={now ? todayIn(timezone, now) : undefined}
                onChange={(e) => set({ date: e.target.value })}
                className={clsx(INPUT, 'tabular')}
              />
            </label>
          )}

          {picker.mode !== 'hourly' && (
            <label className="flex min-w-[130px] flex-1 flex-col gap-1">
              <span className="field-label">Hora</span>
              <input
                type="time"
                value={picker.time}
                onChange={(e) => set({ time: e.target.value })}
                className={clsx(INPUT, 'tabular')}
              />
            </label>
          )}
        </div>
      </fieldset>

      {/* Zona horaria: casi siempre Colombia, así que se dice y no se pregunta. */}
      <div className="text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <Globe className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
          <span className="font-semibold text-ink">{tzLabel(timezone)}</span>
          <button
            type="button"
            onClick={() => setTzOpen(!tzOpen)}
            aria-expanded={tzOpen}
            aria-controls={`${id}-tz`}
            className="rounded-pill px-1.5 py-0.5 font-semibold text-primary transition-colors hover:bg-primary-soft focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {tzOpen ? 'listo' : 'cambiar zona'}
          </button>
        </span>
        {tzOpen && (
          <TimezonePicker
            id={`${id}-tz`}
            value={timezone}
            onChange={(tz) => {
              onChange({ ...value, timezone: tz });
              setTzOpen(false);
            }}
          />
        )}
      </div>

      {/* Lo que significa, en una frase, y las próximas tres veces. */}
      <div
        className="rounded-card border border-primary/20 bg-primary-soft/60 px-3 py-2.5"
        aria-live="polite"
      >
        <p className="flex items-start gap-1.5 text-sm font-semibold text-ink">
          <AlarmClock className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <span>
            {sentence}
            <span className="font-normal text-ink-muted"> · {tzLabel(timezone)}</span>
          </span>
        </p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5 pl-[22px] text-micro text-ink-muted">
          {now === null ? null : runs.length > 0 ? (
            <>
              <span>{runs.length === 1 ? 'Correrá:' : 'Próximas:'}</span>
              {runs.map((run) => (
                <span
                  key={run.toISOString()}
                  className="rounded-pill border border-border bg-surface px-2 py-0.5 font-semibold tabular-nums text-ink"
                >
                  {formatRun(run, timezone)}
                </span>
              ))}
            </>
          ) : value.custom ? (
            <span>
              No puedo calcular las próximas ejecuciones de esta expresión; se validará al guardar.
            </span>
          ) : (
            <span>Aún no hay una próxima ejecución con este horario.</span>
          )}
        </div>
      </div>

      {/* Para quien prefiere escribir cron. */}
      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          aria-expanded={advancedOpen}
          aria-controls={`${id}-cron`}
          className="inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-micro font-semibold text-ink-faint transition-colors hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <ChevronDown
            className={clsx('h-3.5 w-3.5 transition-transform', advancedOpen && 'rotate-180')}
            aria-hidden
          />
          Avanzado: expresión cron
        </button>
        {advancedOpen && (
          <div id={`${id}-cron`} className="mt-1.5 space-y-1.5">
            <input
              aria-label="Expresión cron"
              value={picker.mode === 'once' && !value.custom ? '' : value.rawCron}
              onChange={(e) => onChange(withRawCron(value, e.target.value))}
              spellCheck={false}
              placeholder="0 9 * * 1-5"
              className={clsx(INPUT, 'w-full font-mono')}
            />
            <p className="text-micro text-ink-faint">
              {value.custom ? (
                <>
                  Este horario no cabe en el selector, así que manda la expresión.{' '}
                  <button
                    type="button"
                    onClick={() => onChange(withPicker(value, picker))}
                    className="font-semibold text-primary underline-offset-2 hover:underline"
                  >
                    Volver al selector
                  </button>
                </>
              ) : picker.mode === 'once' ? (
                'Una sola vez no usa cron. Escribe una expresión para volverla recurrente.'
              ) : (
                'Minuto, hora, día del mes, mes y día de la semana. Lo que escribas aquí se refleja arriba.'
              )}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Buscador de zonas: escribe «méx», «españa» o «nueva york». */
export function TimezonePicker({
  id,
  value,
  onChange,
}: {
  id: string;
  value: string;
  onChange: (tz: string) => void;
}) {
  const [query, setQuery] = useState('');
  const matches = searchTimezones(query);
  return (
    <div id={id} className="mt-2 rounded-card border border-border bg-surface p-2 shadow-card">
      <label className="relative block">
        <span className="sr-only">Buscar zona horaria</span>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <input
          // biome-ignore lint/a11y/noAutofocus: the search only appears after asking to change the zone
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Busca un país o ciudad"
          className={clsx(INPUT, 'w-full py-1.5 pl-8')}
        />
      </label>
      <ul className="scroll-slim mt-1.5 max-h-48 overflow-auto" aria-label="Zonas horarias">
        {matches.map((z) => (
          <li key={z.tz}>
            <button
              type="button"
              onClick={() => onChange(z.tz)}
              aria-current={z.tz === value}
              className={clsx(
                'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-xs transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                z.tz === value ? 'bg-primary-soft text-primary-ink' : 'text-ink hover:bg-surface-2',
              )}
            >
              <span className="font-semibold">{z.label}</span>
              <span className="font-mono text-micro text-ink-faint">{z.tz}</span>
            </button>
          </li>
        ))}
        {matches.length === 0 && (
          <li className="px-2 py-1.5 text-xs text-ink-faint">Ninguna zona coincide.</li>
        )}
      </ul>
    </div>
  );
}
