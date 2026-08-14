'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelHead } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import clsx from 'clsx';
import { CircleSlash, Loader2, Plus, Target } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import { createGoal, retireGoal } from '../actions';
import type { ActionResult, GoalView, MetricOptionView, ReadingView } from './types';

/**
 * Metas, del lado del navegador.
 *
 * No calcula ni una cifra ni un veredicto: todo llega resuelto del servidor. Lo
 * único que decide aquí es qué se enseña y qué se pliega.
 *
 * LA PIEZA QUE IMPORTA ES EL SELECTOR. Una métrica que este espacio no puede
 * calcular sale en la lista, apagada, con el motivo debajo y sin forma de
 * elegirla. Ninguna de las tres cosas sobra:
 *   sale       — esconderla dejaría a alguien buscando una función que existe;
 *   apagada    — poder fijarla crearía una casilla vacía en el tablero;
 *   con motivo — «no disponible» sin un siguiente paso es una pared.
 */

interface Props {
  goals: GoalView[];
  options: MetricOptionView[];
}

export function GoalsBoard({ goals, options }: Props) {
  return (
    <div className="space-y-6">
      {goals.length === 0 ? <NoGoalsYet options={options} /> : null}
      {goals.map((goal) => (
        <GoalCard key={goal.id} goal={goal} />
      ))}
      <NewGoal options={options} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function NoGoalsYet({ options }: { options: MetricOptionView[] }) {
  const measurable = options.filter((o) => o.available);
  return (
    <Panel>
      <div className="px-5 py-8 text-center">
        <p className="text-base font-semibold text-ink">Todavía no hay ninguna meta fijada</p>
        <p className="mx-auto mt-1 max-w-[62ch] text-sm leading-relaxed text-ink-muted">
          {measurable.length > 0
            ? `Una meta es una frase como «la cartera no debe pasar de 45 días»: un número que alguien decide y contra el que Cortex compara la realidad cada período. Con los datos que ya hay aquí se pueden medir ${measurable.length} cosa(s) — están abajo.`
            : 'Una meta es un número que alguien decide y contra el que Cortex compara la realidad cada período. Ahora mismo este espacio todavía no tiene datos que alimenten ninguna: abajo está cada una con lo que le falta.'}
        </p>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function GoalCard({ goal }: { goal: GoalView }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [, startTransition] = useTransition();

  function retire() {
    setBusy(true);
    startTransition(async () => {
      const outcome = await retireGoal({ goalId: goal.id });
      setResult(outcome);
      setBusy(false);
    });
  }

  return (
    <Panel className="overflow-hidden">
      <PanelHead
        icon={<Target className="h-4 w-4" aria-hidden />}
        title={goal.label}
        right={
          <span className="text-xs text-ink-faint">
            {goal.cadenceLabel} · {goal.targetLabel}
          </span>
        }
      />

      <div className="flex flex-wrap items-end gap-x-10 gap-y-4 px-5 py-4">
        {/* EL PERÍODO CERRADO. Congelado, y por eso es el que se cita. */}
        <div>
          <p className="text-micro font-semibold uppercase tracking-[.08em] text-ink-faint">
            {goal.latest ? goal.latest.periodLabel : 'Sin período cerrado'}
          </p>
          <div className="mt-1 flex items-baseline gap-3">
            <span className="stat-num text-display font-semibold text-ink">
              {goal.latest ? goal.latest.display : '—'}
            </span>
            {goal.latest ? (
              <span className={chipClass(goal.latest.statusTone)}>{goal.latest.statusLabel}</span>
            ) : null}
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {goal.latest
              ? `Juzgado contra: ${goal.latest.judgedAgainst}. Congelado el ${goal.latest.frozenAt}.`
              : 'Se congela la primera lectura en cuanto cierre el período. No se rellena hacia atrás: un número calculado hoy y presentado como el del mes pasado no sería historia.'}
          </p>
        </div>

        {/* EL PERÍODO EN CURSO. Se marca porque cambia cada mañana. */}
        {goal.live ? (
          <div className="rounded-card border border-dashed border-border px-4 py-2">
            <p className="text-micro font-semibold uppercase tracking-[.08em] text-ink-faint">
              {goal.live.periodLabel} · en curso
            </p>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="stat-num text-lg font-semibold text-ink-muted">
                {goal.live.display}
              </span>
              <span className={chipClass(goal.live.statusTone)}>{goal.live.statusLabel}</span>
            </div>
            <p className="mt-1 text-micro text-ink-faint">
              Calculado ahora mismo y no guardado: cambiará mañana.
            </p>
          </div>
        ) : null}

        <div className="ml-auto flex flex-col items-end gap-2">
          <span className="text-xs text-ink-faint">
            Fijada por {goal.createdByName} el {goal.createdOn}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen((v) => !v)}>
              {open ? 'Ocultar histórico' : `Histórico (${goal.history.length})`}
            </Button>
            <Button variant="ghost" onClick={retire} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'Retirar'}
            </Button>
          </div>
        </div>
      </div>

      {goal.metricLabel == null ? (
        <p className="border-t border-border bg-amber-soft px-5 py-3 text-xs text-amber">
          Esta meta apunta a una métrica que ya no está en el catálogo
          {` («${goal.metricKey}»)`}. No se mide ni se avisa nada nuevo, y su histórico se queda tal
          como se congeló.
        </p>
      ) : null}

      {result ? (
        <p
          className={clsx(
            'border-t border-border px-5 py-3 text-xs',
            result.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
          )}
        >
          {result.ok ? result.note : result.error}
        </p>
      ) : null}

      {open ? <History rows={goal.history} live={goal.live?.method ?? null} /> : null}
    </Panel>
  );
}

// ---------------------------------------------------------------------------

function History({ rows, live }: { rows: ReadingView[]; live: string | null }) {
  if (rows.length === 0) {
    return (
      <div className="border-t border-border bg-surface-2 px-5 py-4 text-xs text-ink-muted">
        Todavía no hay ningún período cerrado.
        {live ? ` En lo que va del actual: ${live}` : ''}
      </div>
    );
  }
  return (
    <ul className="divide-y divide-border border-t border-border">
      {rows.map((row) => (
        <li key={row.id} className="px-5 py-3">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span className="min-w-[9rem] text-sm font-semibold text-ink">
              {row.periodLabel}
            </span>
            <span className="stat-num text-base font-semibold text-ink tabular">
              {row.display}
            </span>
            <span className={chipClass(row.statusTone)}>{row.statusLabel}</span>
            <span className="text-xs text-ink-faint">
              objetivo de entonces: {row.judgedAgainst} · {row.sampleSize} dato(s)
            </span>
          </div>
          {/*
            EL MÉTODO, ENTERO Y SIN RECORTAR. Es lo que alguien necesita para
            rehacer el número a mano meses después. Una cifra sin esta frase es
            una afirmación, y una afirmación no se audita: se cree o no se cree.
          */}
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">{row.method}</p>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------

function NewGoal({ options }: { options: MetricOptionView[] }) {
  const available = useMemo(() => options.filter((o) => o.available), [options]);
  const blocked = useMemo(() => options.filter((o) => !o.available), [options]);

  const [chosen, setChosen] = useState<string>(available[0]?.key ?? '');
  const [cadence, setCadence] = useState<'week' | 'month'>('month');
  const [target, setTarget] = useState<string>(String(available[0]?.suggestedTarget ?? ''));
  const [label, setLabel] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const spec = options.find((o) => o.key === chosen) ?? null;

  function pick(option: MetricOptionView) {
    setChosen(option.key);
    setTarget(String(option.suggestedTarget));
    setResult(null);
  }

  function submit() {
    const value = Number(target.replace(',', '.'));
    if (!spec || !Number.isFinite(value)) {
      setResult({ ok: false, error: 'Elige una métrica y escribe un número.' });
      return;
    }
    setBusy(true);
    startTransition(async () => {
      const outcome = await createGoal({
        metricKey: spec.key,
        cadence,
        targetValue: value,
        label: label.trim() || null,
      });
      setResult(outcome);
      setBusy(false);
      if (outcome.ok) setLabel('');
    });
  }

  return (
    <Panel>
      <PanelHead
        icon={<Plus className="h-4 w-4" aria-hidden />}
        title="Fijar una meta"
        right={
          <span className="text-xs text-ink-faint">
            {available.length} de {options.length} se pueden medir aquí
          </span>
        }
      />

      <div className="space-y-4 px-5 py-4">
        <fieldset>
          <legend className="text-xs font-semibold uppercase tracking-[.06em] text-ink-faint">
            Qué medir
          </legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {available.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => pick(option)}
                aria-pressed={chosen === option.key}
                className={clsx(
                  'rounded-card border px-4 py-3 text-left transition-colors',
                  chosen === option.key
                    ? 'border-primary bg-primary-soft'
                    : 'border-border bg-surface hover:bg-surface-2',
                )}
              >
                <span className="block text-sm font-semibold text-ink">{option.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  {option.blurb}
                </span>
                <span className="mt-1 block text-micro text-ink-faint">
                  {option.directionLabel} un número · fuente: {option.sourceSystem}
                </span>
              </button>
            ))}
          </div>

          {available.length === 0 ? (
            <p className="mt-2 rounded-card border border-amber/20 bg-amber-soft px-4 py-3 text-xs leading-relaxed text-amber">
              Este espacio de trabajo todavía no puede calcular ninguna meta. Abajo está cada una
              con lo que le falta — y esa es toda la lista: una meta sin datos detrás es una casilla
              vacía, y una casilla vacía resta más confianza de la que suma.
            </p>
          ) : null}

          {/*
            LAS QUE NO SE PUEDEN MEDIR, VISIBLES Y APAGADAS. Con su motivo, que
            es la mitad útil del rechazo.
          */}
          {blocked.length > 0 ? (
            <ul className="mt-3 space-y-2">
              {blocked.map((option) => (
                <li
                  key={option.key}
                  className="rounded-card border border-dashed border-border bg-surface-2 px-4 py-3 opacity-90"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-ink-muted">
                    <CircleSlash className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    {option.label}
                    <span className={chipClass('neutral')}>sin datos todavía</span>
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                    {option.reason}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </fieldset>

        {spec?.available ? (
          <div className="grid gap-3 sm:grid-cols-[8rem_10rem_minmax(0,1fr)_auto] sm:items-end">
            <label className="block" htmlFor="goal-target">
              <span className="mb-1 block text-xs font-semibold text-ink-muted">
                {spec.directionLabel}
              </span>
              <Input
                id="goal-target"
                inputMode="decimal"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                aria-label={`Objetivo en ${spec.unitLabel || 'unidades'}`}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-ink-muted">Cada</span>
              <select
                value={cadence}
                onChange={(e) => setCadence(e.target.value as 'week' | 'month')}
                className="h-10 w-full rounded-input border border-border bg-surface px-3 text-base text-ink"
              >
                <option value="month">mes</option>
                <option value="week">semana</option>
              </select>
            </label>
            <label className="block" htmlFor="goal-label">
              <span className="mb-1 block text-xs font-semibold text-ink-muted">
                Cómo llamarla (opcional)
              </span>
              <Input
                id="goal-label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder={spec.label}
              />
            </label>
            <Button onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : 'Fijar meta'}
            </Button>
          </div>
        ) : null}

        {result ? (
          <p
            className={clsx(
              'rounded-card px-4 py-3 text-xs leading-relaxed',
              result.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
            )}
          >
            {result.ok ? result.note : result.error}
          </p>
        ) : null}
      </div>
    </Panel>
  );
}
