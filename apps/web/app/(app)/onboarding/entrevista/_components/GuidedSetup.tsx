'use client';

import { VoiceDictation } from '@/components/chat/VoiceDictation';
import { Panel } from '@/components/ui/panel';
import { Provenance } from '@/components/ui/provenance';
import {
  type Handoff,
  HANDOFF_COPY,
  KIND_COPY,
  MAX_QUESTIONS,
  type OutOfScope,
  type SetupItem,
  type SetupKind,
  itemFields,
  undoability,
} from '@/lib/guided-setup-shape';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  ArrowRight,
  Ban,
  BookOpen,
  Building2,
  CalendarClock,
  Check,
  Clock,
  CornerDownLeft,
  Loader2,
  Route,
  RotateCcw,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { applySelection, discardPlan, undoAll, undoItem } from '../actions';

/**
 * LA PANTALLA QUE CONVIERTE UNA CONVERSACIÓN EN CONFIGURACIÓN.
 *
 * ===========================================================================
 * TRES MOMENTOS, UNA PÁGINA, Y NINGUNO SE SALTA
 * ===========================================================================
 *   Hablando   Cuentas cómo funciona la empresa. Cortex pregunta poco.
 *   El plan    Ves exactamente qué se va a crear, dónde, y con qué datos.
 *              Nada existe todavía. Marcas y desmarcas.
 *   El recibo  Lo creado, con enlace a su módulo y un botón para deshacerlo.
 *
 * El segundo momento es la razón de ser de todo esto. Una herramienta que
 * escucha y crea sola llena el producto de cosas que nadie pidió, y quien las
 * encuentre la semana entrante va a tener que borrarlas una por una — que es la
 * forma más eficiente de enseñarle a alguien a no confiar en lo que este
 * producto crea. Así que el plan muestra los CAMPOS, no un resumen de los
 * campos: la fecha exacta, la hora exacta, los pasos con sus paradas. Aprobar
 * algo que no se ve completo no es aprobar.
 *
 * ===========================================================================
 * TRES LISTAS, Y LAS DOS ÚLTIMAS NO SON UN DESCARGO
 * ===========================================================================
 * Debajo de lo que se va a crear van «esto no se configura hablando» y «esto
 * todavía no lo puedo hacer». No están en letra pequeña ni detrás de un
 * desplegable: van en la misma columna, con el mismo tamaño de letra. Este
 * producto se vende sobre no afirmar lo que no puede sostener, y el onboarding
 * es el peor sitio posible para romper esa promesa — es la primera impresión, y
 * es donde más barato sale mentir.
 */

const ICON: Record<SetupKind, ReactNode> = {
  commitment: <CalendarClock className="h-4 w-4" />,
  routine: <Clock className="h-4 w-4" />,
  flow: <Route className="h-4 w-4" />,
  client: <Building2 className="h-4 w-4" />,
  space: <BookOpen className="h-4 w-4" />,
};

interface Turn {
  role: 'person' | 'cortex';
  text: string;
  at: string;
}

type Phase = 'talking' | 'plan' | 'done';

interface Props {
  sessionId: string | null;
  phase: Phase;
  transcript: Turn[];
  askedCount: number;
  summary: string | null;
  items: SetupItem[];
  handoffs: Handoff[];
  outOfScope: OutOfScope[];
  firstName: string;
}

export function GuidedSetup(props: Props) {
  const router = useRouter();

  const [sessionId, setSessionId] = useState(props.sessionId);
  const [phase, setPhase] = useState<Phase>(props.phase);
  const [turns, setTurns] = useState<Turn[]>(props.transcript);
  const [asked, setAsked] = useState(props.askedCount);
  const [summary, setSummary] = useState(props.summary);
  const [items, setItems] = useState(props.items);
  const [handoffs, setHandoffs] = useState(props.handoffs);
  const [outOfScope, setOutOfScope] = useState(props.outOfScope);

  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textRef = useRef('');
  textRef.current = text;
  const tail = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase === 'talking' && turns.length > 0) {
      tail.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [turns.length, phase]);

  async function send(message: string, finish: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    const at = new Date().toISOString();
    if (message) setTurns((prev) => [...prev, { role: 'person', text: message, at }]);
    setText('');

    try {
      const res = await fetch('/api/onboarding/interview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message, finish }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? 'No pude seguir ahora mismo.');

      setSessionId(data.sessionId);
      if (data.status === 'interviewing') {
        setAsked(data.askedCount);
        setTurns((prev) => [
          ...prev,
          {
            role: 'cortex',
            text: [data.note, data.question].filter(Boolean).join(' '),
            at: new Date().toISOString(),
          },
        ]);
      } else {
        setSummary(data.summary);
        setItems(data.items ?? []);
        setHandoffs(data.handoffs ?? []);
        setOutOfScope(data.outOfScope ?? []);
        setPhase('plan');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No pude seguir ahora mismo.');
      // Se devuelve lo escrito para que no haya que volver a escribirlo.
      if (message) setText(message);
      setTurns((prev) => prev.filter((t) => !(t.role === 'person' && t.at === at)));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const message = text.trim();
    if (message.length === 0) return;
    void send(message, false);
  }

  if (phase === 'plan') {
    return (
      <Plan
        sessionId={sessionId as string}
        summary={summary}
        items={items}
        handoffs={handoffs}
        outOfScope={outOfScope}
        onApplied={(next) => {
          setItems(next);
          setPhase('done');
        }}
        onDiscarded={() => router.push('/onboarding/entrevista?nueva=1')}
      />
    );
  }

  if (phase === 'done') {
    return (
      <Receipt
        sessionId={sessionId as string}
        items={items}
        handoffs={handoffs}
        outOfScope={outOfScope}
        onChange={setItems}
      />
    );
  }

  const opening = turns.length === 0;

  return (
    <div className="space-y-5">
      {opening ? (
        <Panel className="overflow-hidden">
          <div className="hero-mesh px-6 py-8 sm:px-8 sm:py-10">
            <p className="text-micro font-semibold uppercase tracking-field text-white/60">
              Puesta en marcha
            </p>
            <h2 className="mt-2 max-w-2xl text-xl font-semibold leading-tight text-white sm:text-display">
              {props.firstName}, cuéntame cómo trabajan.
            </h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-white/80">
              Qué hace la empresa, qué se les vence, qué revisan cada semana, qué se les enreda.
              Como se lo contarías a alguien que entra mañana. Con eso te propongo qué dejar
              configurado, y tú decides qué se crea.
            </p>
          </div>
        </Panel>
      ) : (
        <Transcript turns={turns} />
      )}

      <div ref={tail} />

      <form onSubmit={onSubmit}>
        <div
          className={clsx(
            'rounded-card border bg-surface shadow-card transition-colors',
            busy ? 'border-border' : 'border-border focus-within:border-border-strong',
          )}
        >
          <label htmlFor="entrevista-texto" className="sr-only">
            Cuéntale a Cortex cómo funciona tu empresa
          </label>
          <textarea
            id="entrevista-texto"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSubmit(e);
            }}
            rows={opening ? 5 : 3}
            disabled={busy}
            placeholder={
              opening
                ? 'Somos una empresa de… y lo que más nos cuesta es…'
                : 'Responde con lo que sepas. Si no sabes, dilo y seguimos.'
            }
            className="w-full resize-none bg-transparent px-4 pt-4 text-base leading-relaxed text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
          />
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 pb-3 pt-1">
            <div className="flex items-center gap-2">
              <VoiceDictation
                disabled={busy}
                getBaseText={() => textRef.current}
                onText={setText}
              />
              <span className="text-micro text-ink-faint">o dicta, si es más fácil</span>
            </div>
            <button
              type="submit"
              disabled={busy || text.trim().length === 0}
              className="inline-flex items-center gap-2 rounded-pill bg-primary px-4 py-2 text-xs font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px disabled:pointer-events-none disabled:opacity-40 motion-reduce:transform-none motion-reduce:transition-none"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CornerDownLeft className="h-3.5 w-3.5" />
              )}
              {busy ? 'Pensando' : 'Enviar'}
            </button>
          </div>
        </div>
      </form>

      {error && <p className="text-xs text-rose">{error}</p>}

      {/*
        El contador está a la vista a propósito. Lo que mata estas herramientas
        no es la primera pregunta, es no saber cuántas faltan: decir «máximo 5»
        desde el principio es la diferencia entre una conversación y un
        formulario disfrazado.
      */}
      {asked > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-ink-faint">
            <span className="tabular">
              {asked} de máximo {MAX_QUESTIONS}
            </span>{' '}
            preguntas. Paro apenas tenga con qué proponerte algo.
          </span>
          <button
            type="button"
            onClick={() => void send('Ya con esto, muéstrame lo que tienes.', true)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline disabled:opacity-40"
          >
            Ya, muéstrame lo que tienes
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * El hilo, leído como una transcripción y no como un chat. Quien habla va en el
 * margen, en pequeño, porque en el plan que viene después cada propuesta cita
 * lo que dijo la persona — y una cita necesita que se sepa quién dijo qué.
 */
function Transcript({ turns }: { turns: Turn[] }) {
  return (
    <Panel className="p-5 sm:p-6">
      <ol className="space-y-5">
        {turns.map((turn, i) => (
          <li
            key={`${turn.at}-${i}`}
            className="grid gap-1 sm:grid-cols-[58px_1fr] sm:gap-4"
          >
            <div className="field-label pt-1 sm:text-right">
              {turn.role === 'person' ? 'Tú' : 'Cortex'}
            </div>
            <p
              className={clsx(
                'text-sm leading-relaxed',
                turn.role === 'person'
                  ? 'text-ink'
                  : 'border-l-2 border-primary/25 pl-3.5 font-medium text-ink sm:border-l-0 sm:pl-0',
              )}
            >
              {turn.text}
            </p>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// El plan
// ---------------------------------------------------------------------------

function Plan({
  sessionId,
  summary,
  items,
  handoffs,
  outOfScope,
  onApplied,
  onDiscarded,
}: {
  sessionId: string;
  summary: string | null;
  items: SetupItem[];
  handoffs: Handoff[];
  outOfScope: OutOfScope[];
  onApplied: (items: SetupItem[]) => void;
  onDiscarded: () => void;
}) {
  const proposed = items.filter((i) => i.status === 'proposed');
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(proposed.map((i) => i.id)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function create() {
    setBusy(true);
    setError(null);
    const report = await applySelection(sessionId, [...chosen]);
    setBusy(false);
    if (!report.ok) {
      setError(report.error ?? 'No se pudo crear.');
      return;
    }
    onApplied(report.items);
  }

  async function discard() {
    setBusy(true);
    await discardPlan(sessionId);
    setBusy(false);
    onDiscarded();
  }

  const nothing = proposed.length === 0;

  return (
    <div className="space-y-5">
      {summary && (
        <Panel className="border-primary/20 bg-primary-soft/40 p-5">
          <p className="field-label">Lo que entendí</p>
          <p className="mt-2 text-base leading-relaxed text-primary-ink">{summary}</p>
        </Panel>
      )}

      {nothing ? (
        <Panel className="p-6">
          <h2 className="text-base font-semibold text-ink">
            No tengo nada que proponerte todavía.
          </h2>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-ink-muted">
            Prefiero decirte esto a inventarme tres configuraciones para que la pantalla no se
            vea vacía. Cuéntame algo más concreto — una fecha que se les vence, algo que revisan
            cada semana, un procedimiento que siguen — y vuelvo a intentarlo.
          </p>
          <Link
            href="/onboarding/entrevista?nueva=1"
            className="mt-4 inline-flex items-center gap-2 rounded-pill bg-primary px-4 py-2 text-xs font-semibold text-white shadow-pop"
          >
            Seguir contándole
          </Link>
        </Panel>
      ) : (
        <section>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-base font-semibold text-ink">
              Esto es lo que dejaría configurado
            </h2>
            <p className="text-xs text-ink-faint">
              Nada de esto existe todavía. Desmarca lo que no quieras.
            </p>
          </div>
          <ul className="space-y-2.5">
            {proposed.map((item) => (
              <ProposedRow
                key={item.id}
                item={item}
                checked={chosen.has(item.id)}
                onToggle={() => toggle(item.id)}
                disabled={busy}
              />
            ))}
          </ul>
        </section>
      )}

      <Limits handoffs={handoffs} outOfScope={outOfScope} />

      {!nothing && (
        <Panel className="sticky bottom-4 z-10 flex flex-wrap items-center justify-between gap-3 p-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">
              {chosen.size === 0
                ? 'No hay nada marcado.'
                : `Se van a crear ${chosen.size} ${chosen.size === 1 ? 'cosa' : 'cosas'}.`}
            </p>
            <p className="mt-0.5 text-micro text-ink-faint">
              Todo lo que se cree se puede deshacer enseguida.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void discard()}
              disabled={busy}
              className="text-xs font-semibold text-ink-muted hover:text-ink disabled:opacity-40"
            >
              Descartar todo
            </button>
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy || chosen.size === 0}
              className="inline-flex items-center gap-2 rounded-pill bg-primary px-4 py-2 text-xs font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px disabled:pointer-events-none disabled:opacity-40 motion-reduce:transform-none motion-reduce:transition-none"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              Crear {chosen.size > 0 ? chosen.size : ''}
            </button>
          </div>
        </Panel>
      )}

      {error && <p className="text-xs text-rose">{error}</p>}
    </div>
  );
}

function ProposedRow({
  item,
  checked,
  onToggle,
  disabled,
}: {
  item: SetupItem;
  checked: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const copy = KIND_COPY[item.kind];
  const fields = itemFields(item);

  return (
    <li>
      <label
        className={clsx(
          'flex cursor-pointer gap-3.5 rounded-card border p-4 transition-colors',
          checked
            ? 'border-primary/30 bg-surface shadow-card'
            : 'border-border bg-surface-2/60 opacity-70 hover:opacity-100',
          disabled && 'pointer-events-none',
        )}
      >
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={disabled}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--primary))]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="text-ink-muted">{ICON[item.kind]}</span>
            <span className="text-sm font-semibold text-ink">{item.title}</span>
            <span className={chipClass('primary')}>{copy.where}</span>
          </div>

          {item.rationale && (
            <p className="mt-2 border-l-2 border-border-strong pl-3 text-xs italic leading-relaxed text-ink-muted">
              {item.rationale}
            </p>
          )}

          {fields.length > 0 && (
            <dl className="mt-3 space-y-1.5">
              {fields.map((f) => (
                <div key={f.label} className="grid gap-0.5 sm:grid-cols-[120px_1fr] sm:gap-3">
                  <dt className="field-label sm:pt-px">{f.label}</dt>
                  <dd className="tabular text-xs leading-relaxed text-ink">{f.value}</dd>
                </div>
              ))}
            </dl>
          )}

          <p className="mt-2.5 text-micro leading-relaxed text-ink-faint">{copy.blurb}</p>
        </div>
      </label>
    </li>
  );
}

/**
 * Los límites, dichos con todas las letras y en el mismo tamaño que lo demás.
 * Esta sección es la que más tentación da de esconder y la que más vende: es la
 * única prueba, en toda la pantalla, de que lo de arriba no está inflado.
 */
function Limits({ handoffs, outOfScope }: { handoffs: Handoff[]; outOfScope: OutOfScope[] }) {
  if (handoffs.length === 0 && outOfScope.length === 0) return null;
  return (
    <div className="space-y-5">
      {handoffs.length > 0 && (
        <section>
          <h2 className="mb-2.5 text-base font-semibold text-ink">
            Esto sí lo hace, pero no se configura hablando
          </h2>
          <ul className="space-y-2.5">
            {handoffs.map((h, i) => {
              const copy = HANDOFF_COPY[h.kind];
              return (
                <li key={`${h.kind}-${i}`}>
                  <Panel className="flex flex-wrap items-start justify-between gap-3 p-4">
                    <div className="min-w-0 max-w-xl">
                      <p className="text-sm font-semibold text-ink">{copy.title}</p>
                      {h.want && (
                        <p className="mt-1 text-xs italic text-ink-muted">«{h.want}»</p>
                      )}
                      <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                        {copy.why}
                      </p>
                    </div>
                    <Link
                      href={copy.href}
                      className="inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border-strong px-3.5 py-2 text-xs font-semibold text-ink transition-colors hover:bg-surface-2"
                    >
                      {copy.cta}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Panel>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {outOfScope.length > 0 && (
        <section>
          <h2 className="mb-2.5 flex items-center gap-2 text-base font-semibold text-ink">
            <Ban className="h-4 w-4 text-ink-faint" />
            Esto todavía no lo puedo hacer solo
          </h2>
          <Panel className="divide-y divide-border">
            {outOfScope.map((o, i) => (
              <div key={`${o.want}-${i}`} className="p-4">
                <p className="text-sm font-medium text-ink">«{o.want}»</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">{o.note}</p>
              </div>
            ))}
          </Panel>
          <p className="mt-2 text-micro leading-relaxed text-ink-faint">
            Lo dejo anotado tal como lo dijiste. Prefiero decírtelo hoy a montarte algo que
            parezca que lo resuelve.
          </p>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// El recibo
// ---------------------------------------------------------------------------

function Receipt({
  sessionId,
  items,
  handoffs,
  outOfScope,
  onChange,
}: {
  sessionId: string;
  items: SetupItem[];
  handoffs: Handoff[];
  outOfScope: OutOfScope[];
  onChange: (items: SetupItem[]) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const live = items.filter((i) => i.status === 'created' || i.status === 'merged');
  const failed = items.filter((i) => i.status === 'failed');
  const undone = items.filter((i) => i.status === 'undone');

  async function one(itemId: string) {
    setBusy(itemId);
    setError(null);
    const report = await undoItem(itemId);
    setBusy(null);
    if (report.items.length > 0) onChange(report.items);
    if (!report.ok) setError(report.error ?? 'No se pudo deshacer.');
  }

  async function all() {
    setBusy('all');
    setError(null);
    const report = await undoAll(sessionId);
    setBusy(null);
    if (report.items.length > 0) onChange(report.items);
    if (report.error) setError(report.error);
  }

  return (
    <div className="space-y-5">
      <Panel className="border-emerald/25 bg-emerald-soft/40 p-5">
        <p className="text-base font-semibold text-ink">
          {live.length === 0
            ? 'No quedó nada creado.'
            : `Listo. ${live.length} ${live.length === 1 ? 'cosa quedó' : 'cosas quedaron'} en su sitio.`}
        </p>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
          Cada una vive en su módulo de siempre: ábrela, cámbiala o bórrala desde ahí como
          cualquier otra. Si algo no era, deshazlo aquí mismo.
        </p>
      </Panel>

      {live.length > 0 && (
        <ul className="space-y-2.5">
          {live.map((item) => {
            const copy = KIND_COPY[item.kind];
            const undo = undoability(item);
            return (
              <li key={item.id}>
                <Panel className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <span className="text-emerald">
                        <Check className="h-4 w-4" />
                      </span>
                      <span className="text-sm font-semibold text-ink">{item.title}</span>
                      <Provenance source={copy.where} detail={copy.noun} />
                    </div>
                    {item.status === 'merged' && (
                      <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
                        {undo.note}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <Link
                      href={copy.href}
                      className="text-xs font-semibold text-primary hover:underline"
                    >
                      Abrir {copy.where}
                    </Link>
                    {undo.can && (
                      <button
                        type="button"
                        onClick={() => void one(item.id)}
                        disabled={busy !== null}
                        className="inline-flex items-center gap-1.5 rounded-pill border border-border-strong px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 disabled:opacity-40"
                      >
                        {busy === item.id ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Undo2 className="h-3 w-3" />
                        )}
                        Deshacer
                      </button>
                    )}
                  </div>
                </Panel>
              </li>
            );
          })}
        </ul>
      )}

      {failed.length > 0 && (
        <section>
          <h2 className="mb-2.5 text-base font-semibold text-ink">Esto no se pudo crear</h2>
          <Panel className="divide-y divide-border">
            {failed.map((item) => (
              <div key={item.id} className="p-4">
                <p className="text-sm font-medium text-ink">{item.title}</p>
                <p className="mt-1 text-xs text-rose">{item.error}</p>
              </div>
            ))}
          </Panel>
        </section>
      )}

      {undone.length > 0 && (
        <p className="text-xs text-ink-faint">
          <span className="tabular">{undone.length}</span>{' '}
          {undone.length === 1 ? 'cosa deshecha' : 'cosas deshechas'}. Ya no están en ningún lado.
        </p>
      )}

      <Limits handoffs={handoffs} outOfScope={outOfScope} />

      {error && <p className="text-xs text-rose">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <Link
          href="/onboarding/entrevista?nueva=1"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Contarle otra cosa
        </Link>
        {live.some((i) => undoability(i).can) && (
          <button
            type="button"
            onClick={() => void all()}
            disabled={busy !== null}
            className="text-xs font-semibold text-ink-muted hover:text-rose disabled:opacity-40"
          >
            {busy === 'all' ? 'Deshaciendo…' : 'Deshacer todo lo que se creó'}
          </button>
        )}
      </div>
    </div>
  );
}
