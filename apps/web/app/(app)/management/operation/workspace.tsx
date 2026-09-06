'use client';
import { Button } from '@/components/ui/button';
import {
  type Operation,
  type OperationEvent,
  type OperationPlan,
  operationDay,
} from '@/lib/management/operation-shape';
import { type ManagementCase, managementStateLabels } from '@/lib/management/shape';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { startDailyBrief } from '../actions';
import { operate, prepareOperation } from './actions';
const control =
  'mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-sm text-ink';
type Person = { id: string; name: string | null; email: string };
type Props = {
  operation: Operation | null;
  operations: Operation[];
  events: OperationEvent[];
  cases: ManagementCase[];
  people: Person[];
  goals: { id: string; label: string }[];
  today: string;
  userId: string;
  isAdmin: boolean;
  partial: boolean;
};
const labels: Record<string, string> = {
  name: 'Nombre del encargo',
  outcome: 'Qué resultado debe conseguir',
  measurement: 'Cómo lo mediremos',
  baseline: 'Punto de partida y fecha de medición',
  target: 'Resultado esperado al día 30',
  source: 'Dónde se comprueba y quién confirma el dato',
  boundaries: 'Qué puede preparar y qué necesita aprobación',
};
export function OperationWorkspace(p: Props) {
  const { operation: op } = p;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState('agenda');
  const [narration, setNarration] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [questions, setQuestions] = useState<string[]>([]);
  const name = (id: string) =>
    p.people.find((v) => v.id === id)?.name ||
    p.people.find((v) => v.id === id)?.email ||
    'Persona no disponible';
  const run = (command: unknown) =>
    start(async () => {
      setError('');
      try {
        const r = await operate(command, op?.id, op?.revision);
        if (!r.ok) setError(r.error);
        else {
          router.push(`/management/operation?id=${r.item.id}`);
          router.refresh();
        }
      } catch {
        setError('No se pudo guardar. Revisa la conexión y actualiza.');
      }
    });
  const linked = op ? p.cases.filter((c) => op.data.caseIds.includes(c.id)) : [];
  const decisions = p.events.filter((e) => e.data.kind === 'decision');
  const unresolved = decisions.filter(
    (e) => !p.events.some((r) => r.data.kind === 'resolve' && r.data.decisionId === e.id),
  );
  const day = op ? operationDay(op.data.startOn, p.today) : 0;
  const inactive = op?.state !== 'active';
  const form = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    return Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>;
  };
  return (
    <main className="mx-auto max-w-6xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-primary">
            Gerencia · operación acompañada
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            {op ? op.data.name : 'Un resultado concreto en 30 días.'}
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-ink-muted">
            Un acuerdo de trabajo, responsables y decisiones. Cada cierre conserva su evidencia.
          </p>
        </div>
        <Link className="text-sm text-primary" href="/management">
          Volver a la agenda →
        </Link>
      </header>
      {p.partial && (
        <output className="block rounded-lg border border-amber/30 p-3 text-sm text-amber">
          Vista parcial o alguna fuente no disponible. No uses estos conteos como un balance
          completo.
        </output>
      )}
      {notice && (
        <output className="block rounded-lg border border-primary/30 p-3 text-sm">{notice}</output>
      )}
      {error && (
        <p role="alert" className="rounded-lg border border-rose/30 p-3 text-sm text-rose">
          {error}
        </p>
      )}
      {!op ? (
        p.isAdmin ? (
          <section className="space-y-5 rounded-xl border border-border p-5">
            <h2 className="text-xl font-semibold">Cuéntale el encargo a Cortex</h2>
            <p className="text-sm text-ink-muted">
              Qué quieres mejorar, cómo trabajan hoy y qué resultado esperas. Cortex organiza un
              borrador; tú acuerdas las cifras y el alcance.
            </p>
            <label className="block text-sm">
              La situación de tu empresa
              <textarea
                value={narration}
                onChange={(e) => setNarration(e.target.value)}
                maxLength={12000}
                rows={4}
                className={control}
                placeholder="Quiero reducir los pedidos atrasados. Hoy revisamos una hoja cada viernes; necesito saber cada día qué se demora y quién debe resolverlo…"
              />
            </label>
            <Button
              disabled={pending || narration.trim().length < 30}
              onClick={() =>
                start(async () => {
                  setError('');
                  try {
                    const r = await prepareOperation(narration);
                    if (r.ok) {
                      const { questions, ...fields } = r.draft;
                      setDraft(fields);
                      setQuestions(questions);
                    } else setError(r.error);
                  } catch {
                    setError('No se pudo preparar el acuerdo.');
                  }
                })
              }
            >
              {pending ? 'Preparando…' : 'Organizar el acuerdo'}
            </Button>
            {questions.length > 0 && (
              <div className="space-y-2 border-l-2 border-primary pl-4">
                <h3 className="font-semibold">Antes de empezar necesitamos aclarar</h3>
                <ul className="list-disc pl-4 text-sm">
                  {questions.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
                <p className="text-xs text-ink-muted">
                  Completa estas respuestas en el acuerdo antes de iniciarlo.
                </p>
              </div>
            )}
            <form
              className="space-y-4 border-t border-border pt-5"
              onSubmit={(e) => {
                const values = form(e);
                const data = new FormData(e.currentTarget);
                run({
                  kind: 'create',
                  plan: {
                    ...values,
                    ownerId: values.ownerId,
                    startOn: values.startOn,
                    goalId: values.goalId || null,
                    caseIds: data.getAll('caseIds'),
                    notifyInApp: data.get('notifyInApp') === 'on',
                  },
                });
              }}
            >
              <h3 className="font-semibold">El acuerdo que vas a compartir con la empresa</h3>
              <div className="grid gap-4 md:grid-cols-2">
                {Object.entries(labels).map(([key, label]) => (
                  <label key={key} className="block text-sm">
                    {label}
                    <textarea
                      name={key}
                      required
                      minLength={key === 'name' ? 3 : 10}
                      maxLength={
                        key === 'name'
                          ? 120
                          : key === 'source' || key === 'outcome' || key === 'boundaries'
                            ? 1500
                            : 1000
                      }
                      rows={key === 'name' ? 1 : 3}
                      className={control}
                      value={draft[key] ?? ''}
                      onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                    />
                  </label>
                ))}
              </div>
              <div className="grid gap-4 md:grid-cols-3">
                <label className="text-sm">
                  Responsable del ciclo
                  <select name="ownerId" className={control} required defaultValue={p.userId}>
                    {p.people.map((v) => (
                      <option key={v.id} value={v.id}>
                        {name(v.id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-sm">
                  Fecha de inicio
                  <input
                    name="startOn"
                    type="date"
                    required
                    min={p.today}
                    defaultValue={p.today}
                    className={control}
                  />
                </label>
                <label className="text-sm">
                  Meta existente (opcional)
                  <select name="goalId" className={control}>
                    <option value="">Medición acordada arriba</option>
                    {p.goals.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <fieldset className="space-y-2">
                <legend className="mb-2 font-semibold">Qué asuntos forman parte del encargo</legend>
                <p className="text-sm text-ink-muted">
                  Selecciona entre 1 y 30 asuntos abiertos. Conservan responsables, plazos y
                  evidencia propios.
                </p>
                {p.cases
                  .filter((c) => !['verified', 'cancelled'].includes(c.data.state))
                  .map((c) => (
                    <label
                      key={c.id}
                      className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm"
                    >
                      <input type="checkbox" name="caseIds" value={c.id} className="mt-1" />
                      {c.data.title} · {c.data.ownerId ? name(c.data.ownerId) : 'Sin responsable'}
                    </label>
                  ))}
                <Link href="/management" className="inline-block text-sm text-primary">
                  Crear o completar asuntos →
                </Link>
              </fieldset>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="notifyInApp" className="mt-1" />
                Avisar dentro de Cortex a los responsables cuando corresponda revisar un asunto y al
                responsable del ciclo ante bloqueos o revisiones pendientes. No envía mensajes
                externos.
              </label>
              <p className="text-xs text-ink-muted">
                Este acuerdo no concede permisos ni activa envíos. Las revisiones de los días 7, 14,
                21 y 30 requieren medición, evidencia y un aprendizaje.
              </p>
              <Button
                disabled={
                  pending || !p.cases.some((c) => !['verified', 'cancelled'].includes(c.data.state))
                }
                type="submit"
              >
                Acordar e iniciar el ciclo
              </Button>
            </form>
          </section>
        ) : (
          <p>Un administrador debe acordar el primer ciclo de operación.</p>
        )
      ) : (
        <>
          <section className="grid gap-4 rounded-xl border border-border bg-surface-2 p-5 md:grid-cols-[1fr_auto]">
            <div>
              <p className="text-xs uppercase tracking-wider text-ink-muted">
                {op.state === 'active'
                  ? 'En curso'
                  : op.state === 'paused'
                    ? 'En pausa'
                    : op.state === 'cancelled'
                      ? 'Cancelado con motivo'
                      : 'Ciclo concluido'}{' '}
                · {day < 1 ? `Comienza ${op.data.startOn}` : `Día ${day} de 30`} ·{' '}
                {name(op.data.ownerId)}
              </p>
              <h2 className="mt-2 text-xl font-semibold">{op.data.outcome}</h2>
              <p className="mt-2 text-sm text-ink-muted">Objetivo: {op.data.target}</p>
            </div>
            <div className="flex gap-6">
              <div>
                <p className="text-2xl font-semibold">
                  {linked.filter((c) => c.data.state === 'verified').length}/
                  {op.data.caseIds.length}
                </p>
                <p className="text-xs text-ink-muted">asuntos verificados</p>
              </div>
              <div>
                <p className="text-2xl font-semibold">{unresolved.length}</p>
                <p className="text-xs text-ink-muted">decisiones pendientes</p>
              </div>
            </div>
          </section>
          <nav className="flex gap-5 overflow-x-auto border-b border-border" aria-label="Operación">
            {[
              ['agenda', 'La operación'],
              ['decisions', 'Decisiones'],
              ['reviews', 'Revisiones y aprendizajes'],
              ['agreement', 'Acuerdo e historial'],
            ].map(([id, label]) => (
              <button
                type="button"
                key={id}
                onClick={() => setTab(id ?? 'agenda')}
                aria-pressed={tab === id}
                className={`shrink-0 border-b-2 pb-3 text-sm font-semibold ${tab === id ? 'border-primary text-primary' : 'border-transparent text-ink-muted'}`}
              >
                {label}
              </button>
            ))}
          </nav>
          {tab === 'agenda' && (
            <section className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">Quién está moviendo cada resultado</h2>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    start(async () => {
                      try {
                        const r = await startDailyBrief();
                        setError('');
                        if (r.ok)
                          setNotice(
                            'Parte diario disponible. Revisa su horario y estado en Rutinas.',
                          );
                        else setError(r.error);
                      } catch {
                        setError('No se pudo preparar el parte.');
                      }
                    })
                  }
                >
                  Preparar parte diario
                </Button>
              </div>
              <p className="text-sm text-ink-muted">
                Los avances se registran aquí. Las acciones y aprobaciones del proceso permanecen en
                el asunto.
              </p>
              {linked.map((c) => (
                <article key={c.id} className="space-y-3 rounded-xl border border-border p-4">
                  <div className="flex flex-wrap justify-between gap-2">
                    <h3 className="font-semibold">{c.data.title}</h3>
                    <span className="text-xs text-ink-muted">
                      {managementStateLabels[c.data.state]}
                    </span>
                  </div>
                  <p className="text-sm">
                    {c.data.ownerId ? name(c.data.ownerId) : 'Falta responsable'} · Plazo{' '}
                    {c.data.dueOn} · Revisar {c.data.nextReviewOn}
                  </p>
                  <p className="text-sm text-ink-muted">{c.data.blocker || c.data.nextAction}</p>
                  <Link href={`/management?case=${c.id}`} className="text-sm text-primary">
                    Abrir asunto, evidencia e historial →
                  </Link>
                  {c.data.ownerId === p.userId &&
                    ['open', 'working', 'blocked'].includes(c.data.state) &&
                    !inactive && (
                      <form
                        className="grid gap-3 border-t border-border pt-3 md:grid-cols-2"
                        onSubmit={(e) => {
                          const f = form(e);
                          run({
                            kind: 'progress',
                            caseId: c.id,
                            caseRevision: c.revision,
                            status: f.status,
                            note: f.note,
                            nextReviewOn: f.nextReviewOn,
                          });
                        }}
                      >
                        <label className="text-sm">
                          Mi actualización
                          <select name="status" className={control}>
                            <option value="accepted">Me hago cargo</option>
                            <option value="progress">Estoy avanzando</option>
                            <option value="blocked">Necesito desbloqueo</option>
                          </select>
                        </label>
                        <label className="text-sm">
                          Próxima revisión
                          <input
                            type="date"
                            name="nextReviewOn"
                            min={p.today}
                            defaultValue={p.today}
                            className={control}
                            required
                          />
                        </label>
                        <label className="text-sm md:col-span-2">
                          Qué ocurrió y cuál es el siguiente paso
                          <textarea
                            name="note"
                            className={control}
                            required
                            minLength={10}
                            maxLength={1000}
                          />
                        </label>
                        <Button disabled={pending} type="submit">
                          Registrar avance
                        </Button>
                      </form>
                    )}
                </article>
              ))}
              {linked.length < op.data.caseIds.length && (
                <p className="text-amber">
                  Hay asuntos vinculados fuera de esta lectura. Abre la agenda completa antes de
                  evaluar el ciclo.
                </p>
              )}
            </section>
          )}
          {tab === 'decisions' && (
            <section className="space-y-5">
              <h2 className="text-lg font-semibold">Decidir con alternativas y fundamento</h2>
              {decisions.map((e) => {
                if (e.data.kind !== 'decision') return null;
                const d = e.data.decision;
                const resolved = p.events.find(
                  (r) => r.data.kind === 'resolve' && r.data.decisionId === e.id,
                );
                return (
                  <article key={e.id} className="space-y-3 rounded-xl border border-border p-4">
                    <h3 className="font-semibold">{d.question}</h3>
                    <p className="text-xs text-ink-muted">
                      Plazo {d.dueOn} · Propuesta por {name(e.actor_id)}
                    </p>
                    <div className="grid gap-3 md:grid-cols-2">
                      {d.options.map((o, i) => (
                        <div key={o.label} className="rounded-lg bg-surface-2 p-3">
                          <p className="font-semibold">
                            {i + 1}. {o.label}
                          </p>
                          <p className="mt-1 text-sm text-ink-muted">{o.consequence}</p>
                        </div>
                      ))}
                    </div>
                    <a href={d.evidence} className="text-sm text-primary">
                      Consultar fundamento →
                    </a>
                    <p className="text-sm">Por confirmar: {d.uncertainty}</p>
                    {resolved?.data.kind === 'resolve' ? (
                      <p className="text-sm text-emerald">
                        Decidió {name(resolved.actor_id)}: {d.options[resolved.data.option]?.label}.{' '}
                        {resolved.data.note}
                      </p>
                    ) : p.isAdmin && !inactive ? (
                      <form
                        className="space-y-3"
                        onSubmit={(ev) => {
                          const f = form(ev);
                          run({
                            kind: 'resolve',
                            decisionId: e.id,
                            option: Number(f.option),
                            note: f.note,
                          });
                        }}
                      >
                        <label className="block text-sm">
                          Mi decisión
                          <select name="option" className={control}>
                            {d.options.map((o, i) => (
                              <option key={o.label} value={i}>
                                {o.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="block text-sm">
                          Por qué elegimos esta alternativa
                          <textarea
                            name="note"
                            required
                            minLength={10}
                            maxLength={1500}
                            className={control}
                          />
                        </label>
                        <Button disabled={pending}>Registrar decisión</Button>
                        <p className="text-xs text-ink-muted">
                          Registrar la decisión no ejecuta la alternativa. Prepara la acción en su
                          asunto y conserva sus aprobaciones.
                        </p>
                      </form>
                    ) : (
                      <p className="text-sm text-ink-muted">
                        Pendiente de decisión del administrador.
                      </p>
                    )}
                  </article>
                );
              })}
              {!inactive && (
                <details className="rounded-xl border border-border p-4">
                  <summary className="cursor-pointer font-semibold">Plantear una decisión</summary>
                  <form
                    className="mt-4 space-y-3"
                    onSubmit={(e) => {
                      const f = form(e);
                      run({
                        kind: 'decision',
                        decision: {
                          question: f.question,
                          evidence: f.evidence,
                          uncertainty: f.uncertainty,
                          dueOn: f.dueOn,
                          options: [
                            { label: f.a, consequence: f.ac },
                            { label: f.b, consequence: f.bc },
                          ],
                        },
                      });
                    }}
                  >
                    {[
                      ['question', 'Qué debemos decidir'],
                      ['a', 'Alternativa 1'],
                      ['ac', 'Consecuencias, costo y plazo de la primera'],
                      ['b', 'Alternativa 2'],
                      ['bc', 'Consecuencias, costo y plazo de la segunda'],
                      ['uncertainty', 'Qué falta confirmar'],
                    ].map(([key, label]) => (
                      <label key={key} className="block text-sm">
                        {label}
                        <textarea
                          name={key}
                          className={control}
                          required
                          minLength={key === 'a' || key === 'b' ? 3 : 10}
                          maxLength={key === 'a' || key === 'b' ? 180 : 1000}
                        />
                      </label>
                    ))}
                    <label className="block text-sm">
                      Enlace al fundamento
                      <input
                        name="evidence"
                        className={control}
                        required
                        placeholder="https://… o /reports"
                        maxLength={2000}
                      />
                    </label>
                    <label className="block text-sm">
                      Fecha límite
                      <input
                        type="date"
                        name="dueOn"
                        className={control}
                        defaultValue={p.today}
                        required
                      />
                    </label>
                    <Button disabled={pending}>Guardar propuesta</Button>
                  </form>
                </details>
              )}
              <Link
                className="inline-block text-sm text-primary"
                href={`/chat?prompt=${encodeURIComponent(`Consulta la operación ${op.id} con management.operation. Ayúdame a comparar alternativas para las decisiones pendientes. Explica fuentes, consecuencias y dudas; no ejecutes ni decidas por mí.`)}`}
              >
                Preparar alternativas con Cortex →
              </Link>
            </section>
          )}
          {tab === 'reviews' && (
            <section className="space-y-4">
              <h2 className="text-lg font-semibold">Medir, revisar y mejorar</h2>
              <p className="text-sm text-ink-muted">
                Estas mediciones son declaradas por el administrador y quedan fechadas con su
                evidencia. Los aprendizajes se conservan para la siguiente decisión; no cambian
                manuales automáticamente.
              </p>
              {[7, 14, 21, 30].map((d) => {
                const event = p.events.find(
                  (e) => e.data.kind === 'checkpoint' && e.data.checkpoint.day === d,
                );
                return (
                  <article key={d} className="rounded-xl border border-border p-4">
                    <h3 className="font-semibold">
                      Día {d} · {event ? 'Revisado' : day < d ? 'Programado' : 'Revisión pendiente'}
                    </h3>
                    {event?.data.kind === 'checkpoint' ? (
                      <div className="mt-3 space-y-2 text-sm">
                        <p>Medición: {event.data.checkpoint.measurement}</p>
                        <p>{event.data.checkpoint.observation}</p>
                        <p>Aprendizaje: {event.data.checkpoint.lesson}</p>
                        <p>Siguiente paso: {event.data.checkpoint.nextAction}</p>
                        <a href={event.data.checkpoint.evidence} className="text-primary">
                          Consultar evidencia →
                        </a>
                        <p className="text-xs text-ink-muted">
                          Registró {name(event.actor_id)} ·{' '}
                          {new Date(event.created_at).toLocaleString('es-CO', {
                            timeZone: 'America/Bogota',
                          })}
                        </p>
                      </div>
                    ) : p.isAdmin && !inactive && day >= d ? (
                      <form
                        className="mt-3 space-y-3"
                        onSubmit={(e) => {
                          const f = form(e);
                          run({ kind: 'checkpoint', checkpoint: { day: d, ...f } });
                        }}
                      >
                        {[
                          ['measurement', 'Medición observada y período'],
                          ['observation', 'Qué funcionó y qué sigue bloqueado'],
                          ['nextAction', 'Qué cambiaremos en el siguiente tramo'],
                          ['lesson', 'Qué aprendimos para repetir o corregir'],
                        ].map(([key, label]) => (
                          <label key={key} className="block text-sm">
                            {label}
                            <textarea
                              name={key}
                              required
                              minLength={10}
                              maxLength={
                                key === 'measurement' || key === 'nextAction' ? 1000 : 1500
                              }
                              className={control}
                            />
                          </label>
                        ))}
                        <label className="block text-sm">
                          Referencia de la evidencia
                          <input
                            name="evidence"
                            required
                            maxLength={2000}
                            className={control}
                            placeholder="https://… o /reports"
                          />
                        </label>
                        <Button disabled={pending}>Registrar revisión del día {d}</Button>
                      </form>
                    ) : (
                      <p className="mt-2 text-sm text-ink-muted">
                        Se habilita en su fecha para revisión del administrador.
                      </p>
                    )}
                  </article>
                );
              })}
              <Link
                href={`/chat?prompt=${encodeURIComponent(`Consulta la operación ${op.id} con management.operation y sus aprendizajes. Propón mejoras a los manuales existentes, indicando qué evidencia las justifica. No cambies el proceso sin revisión humana.`)}`}
                className="text-sm text-primary"
              >
                Preparar mejoras del proceso con Cortex →
              </Link>
            </section>
          )}
          {tab === 'agreement' && (
            <section className="space-y-4">
              <p className="text-sm text-ink-muted">
                {op.data.notifyInApp
                  ? 'Avisos internos activados. Se revisan pendientes cada 15 minutos mientras el ciclo está activo.'
                  : 'Avisos internos desactivados para este ciclo.'}
              </p>
              <dl className="grid gap-5 rounded-xl border border-border p-5 md:grid-cols-2">
                {Object.entries(labels).map(([key, label]) => (
                  <div key={key}>
                    <dt className="text-xs text-ink-muted">{label}</dt>
                    <dd className="mt-1 whitespace-pre-wrap text-sm">
                      {op.data[key as keyof OperationPlan] as string}
                    </dd>
                  </div>
                ))}
              </dl>
              {op.data.goalId && (
                <Link href="/goals" className="text-sm text-primary">
                  Consultar la meta vinculada y sus mediciones →
                </Link>
              )}
              <h2 className="font-semibold">Historial de responsabilidades</h2>
              <ol className="space-y-2">
                {p.events.map((e) => (
                  <li key={e.id} className="border-l-2 border-border py-2 pl-4 text-sm">
                    <p className="font-semibold">
                      {{
                        create: 'Acuerdo iniciado',
                        pause: 'Ciclo pausado',
                        resume: 'Ciclo reanudado',
                        complete: 'Ciclo concluido',
                        cancel: 'Ciclo cancelado con motivo',
                        decision: 'Alternativas propuestas',
                        resolve: 'Decisión registrada',
                        checkpoint: 'Revisión con aprendizaje',
                        progress: 'Avance del responsable',
                      }[e.kind] ?? e.kind}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {name(e.actor_id)} ·{' '}
                      {new Date(e.created_at).toLocaleString('es-CO', {
                        timeZone: 'America/Bogota',
                      })}{' '}
                      · Revisión {e.revision}
                    </p>
                    {'note' in e.data && <p>{e.data.note}</p>}
                  </li>
                ))}
              </ol>
              {p.isAdmin && !['completed', 'cancelled'].includes(op.state) && (
                <form
                  className="space-y-3 rounded-xl border border-border p-4"
                  onSubmit={(e) => {
                    const f = form(e);
                    run({ kind: f.kind, note: f.note });
                  }}
                >
                  <label className="block text-sm">
                    Control del ciclo
                    <select name="kind" className={control}>
                      {op.state === 'paused' ? (
                        <option value="resume">Reanudar el ciclo</option>
                      ) : (
                        <>
                          <option value="pause">Pausar el ciclo</option>
                          <option value="complete">Concluir con resultados verificados</option>
                        </>
                      )}
                      <option value="cancel">Cancelar el ciclo sin declarar éxito</option>
                    </select>
                  </label>
                  <label className="block text-sm">
                    Motivo o balance final
                    <textarea
                      name="note"
                      className={control}
                      required
                      minLength={10}
                      maxLength={1000}
                    />
                  </label>
                  <p className="text-xs text-ink-muted">
                    Pausar detiene nuevos registros de este ciclo. Las rutinas y los trámites tienen
                    sus propios controles en sus módulos.
                  </p>
                  <Button disabled={pending}>Registrar cambio</Button>
                </form>
              )}
            </section>
          )}
        </>
      )}
      {p.operations.length > 0 && (
        <footer className="border-t border-border pt-4">
          <h2 className="text-sm font-semibold">Ciclos de la empresa</h2>
          <div className="mt-2 flex flex-wrap gap-4">
            {p.operations.map((o) => (
              <Link
                key={o.id}
                href={`/management/operation?id=${o.id}`}
                className="text-sm text-primary"
              >
                {o.data.name} ·{' '}
                {o.state === 'completed'
                  ? 'Concluido'
                  : o.state === 'paused'
                    ? 'Pausado'
                    : o.state === 'cancelled'
                      ? 'Cancelado'
                      : 'Activo'}
              </Link>
            ))}
            {!p.operations.some((o) => !['completed', 'cancelled'].includes(o.state)) && (
              <Link href="/management/operation" className="text-sm text-primary">
                Preparar siguiente ciclo →
              </Link>
            )}
          </div>
        </footer>
      )}
    </main>
  );
}
