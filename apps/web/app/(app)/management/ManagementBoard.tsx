'use client';
import { Button } from '@/components/ui/button';
import { CortexSignature } from '@/components/ui/cortex-signature';
import { PageHeader } from '@/components/ui/page-header';
import {
  type ManagementCase,
  type ManagementCaseData,
  type ManagementProfile,
  type ManagementSignal,
  managementPriority,
  managementSourceConflicts,
  managementStateLabels,
} from '@/lib/management/shape';
import { ArrowRight, Briefcase, CheckCircle2, Plus, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { CaseEditor } from './CaseEditor';
import { ManualStudio } from './ManualStudio';
import { ProfileEditor } from './ProfileEditor';
import { startDailyBrief } from './actions';
import { Alert, type Person, blankCase } from './form-fields';

type Props = {
  initialTab?: 'today' | 'processes' | 'settings';
  cases: ManagementCase[];
  profile: ManagementProfile;
  people: Person[];
  signals: ManagementSignal[];
  warnings: string[];
  truncated: boolean;
  readAt: string;
  today: string;
  userId: string;
  isAdmin: boolean;
};
export function ManagementBoard(props: Props) {
  const { cases, profile, people, signals, warnings, truncated, readAt, today, userId, isAdmin } =
    props;
  const router = useRouter();
  const [tab, setTab] = useState<'today' | 'processes' | 'settings'>(props.initialTab ?? 'today');
  const [filter, setFilter] = useState<'all' | 'risk' | 'review' | 'working' | 'verified'>('all');
  const [editor, setEditor] = useState<{ item?: ManagementCase; data: ManagementCaseData } | null>(
    null,
  );
  const [notice, setNotice] = useState('');
  const [refreshing, startRefresh] = useTransition();
  const name = (id: string | null) =>
    people.find((p) => p.id === id)?.name ||
    people.find((p) => p.id === id)?.email ||
    'Sin responsable';
  const active = cases.filter((c) => !['verified', 'cancelled'].includes(c.data.state));
  const risk = (c: ManagementCase) =>
    c.data.dueOn < today ||
    c.data.state === 'blocked' ||
    !c.data.ownerId ||
    !!(
      c.data.dependsOn &&
      !cases.some((d) => d.id === c.data.dependsOn && d.data.state === 'verified')
    );
  const sorted = [...cases].sort(
    (a, b) =>
      managementPriority(b, today, cases).score - managementPriority(a, today, cases).score ||
      a.data.dueOn.localeCompare(b.data.dueOn) ||
      a.id.localeCompare(b.id),
  );
  const shown = sorted.filter((c) =>
    filter === 'all'
      ? !['verified', 'cancelled'].includes(c.data.state)
      : filter === 'risk'
        ? active.includes(c) && risk(c)
        : filter === 'working'
          ? c.data.state === 'working'
          : filter === 'review'
            ? c.data.state === 'review'
            : ['verified', 'cancelled'].includes(c.data.state),
  );
  const sourceConflicts = managementSourceConflicts(signals, cases);
  const known = new Set(cases.map((c) => c.data.sourceKey));
  const unassigned = signals.filter((s) => !known.has(s.key));
  function startCase(data: ManagementCaseData, item?: ManagementCase) {
    setNotice('');
    setTab('today');
    setEditor({ data, item });
  }
  function saved() {
    setEditor(null);
    setNotice('Asunto guardado. El historial conserva esta revisión.');
    router.refresh();
  }
  return (
    <div className="space-y-6">
      <div className="management-intro" hidden={tab === 'processes' || !!editor}>
        <CortexSignature className="management-signature" />
        <PageHeader
          title="Agenda de gerencia"
          subtitle="Prioridades, responsables y resultados que puedes comprobar."
          icon={<Briefcase className="h-5 w-5" />}
          actions={
            <>
              <Button
                variant="outline"
                onClick={() => startRefresh(() => router.refresh())}
                disabled={refreshing}
              >
                <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                <span className="sr-only sm:not-sr-only">Actualizar</span>
              </Button>
              <Button onClick={() => startCase(blankCase(today, profile.data.reviewAfterDays))}>
                <Plus className="h-4 w-4" />
                Nuevo asunto
              </Button>
            </>
          }
        />
      </div>
      <div
        className="flex gap-6 overflow-x-auto border-b border-border"
        aria-label="Secciones de gerencia"
      >
        {(
          [
            ['today', 'La operación'],
            ['processes', 'Manuales de procesos'],
            ['settings', 'Configuración'],
          ] as const
        ).map(([value, label]) => (
          <button
            type="button"
            key={value}
            onClick={() => {
              setTab(value);
              setEditor(null);
            }}
            aria-pressed={tab === value}
            className={`shrink-0 whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-semibold ${tab === value ? 'border-primary text-primary' : 'border-transparent text-ink-muted'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'today' && !editor && (
        <section className="manager-agenda" aria-label="Siguiente paso de gerencia">
          <div>
            <h2>
              {active.some(risk)
                ? 'Empecemos por lo que necesita atención.'
                : active.length
                  ? 'Cada compromiso, con un siguiente paso.'
                  : 'Preparemos el primer encargo.'}
            </h2>
            <p>
              {active.filter(risk).length} asuntos requieren atención ·{' '}
              {active.filter((c) => c.data.state === 'review').length} esperan verificación humana.
              Consulta las señales antes de concluir que todo está al día.
            </p>
          </div>
          <div className="manager-agenda__actions">
            <Link href="/chat?prompt=Revisa%20management.brief%20y%20ay%C3%BAdame%20a%20priorizar%20la%20agenda%20de%20hoy.%20Distingue%20hechos%2C%20datos%20faltantes%20y%20el%20siguiente%20paso.">
              Revisar con Cortex
            </Link>
            <Link href="/onboarding">Configurar empresa</Link>
          </div>
          <nav aria-label="Fuentes de la agenda">
            <Link href="/goals">Metas</Link>
            <Link href="/commitments">Compromisos</Link>
            <Link href="/approvals">Aprobaciones</Link>
            <Link href="/schedules">Rutinas</Link>
            <Link href="/feed">Consultar datos</Link>
          </nav>
        </section>
      )}
      {notice && (
        <output className="flex items-center gap-2 text-sm text-emerald">
          <CheckCircle2 className="h-4 w-4" />
          {notice}
        </output>
      )}
      {tab === 'today' && (
        <>
          {profile.revision === 0 && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4">
              <p className="text-sm">
                Define el alcance y los resultados esperados de Cortex para esta empresa.
              </p>
              <Button variant="outline" onClick={() => setTab('settings')}>
                Configurar gerencia
              </Button>
            </div>
          )}
          {warnings.map((w) => (
            <Alert key={w}>{w}</Alert>
          ))}
          {truncated && (
            <Alert>
              Se muestran hasta 500 asuntos recientes y 1.000 personas. Las cifras y dependencias
              visibles pueden estar incompletas.
            </Alert>
          )}
          <div hidden={!!editor} className="management-stats grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(
              [
                ['Por verificar', active.filter((c) => c.data.state === 'review').length, 'review'],
                ['En riesgo', active.filter(risk).length, 'risk'],
                ['En gestión', active.filter((c) => c.data.state === 'working').length, 'working'],
                [
                  'Cerrados con evidencia',
                  cases.filter((c) => c.data.state === 'verified').length,
                  'verified',
                ],
              ] as const
            ).map(([label, count, f]) => (
              <button
                type="button"
                key={f}
                onClick={() => setFilter(f)}
                data-kind={f}
                className={`management-stat rounded-lg border p-4 text-left ${filter === f ? 'border-primary bg-primary/5' : 'border-border bg-surface'}`}
                aria-pressed={filter === f}
              >
                <span className="block text-xs font-medium text-ink-muted">{label}</span>
                <strong className="mt-2 block text-2xl tabular-nums text-ink">{count}</strong>
              </button>
            ))}
          </div>
          {editor ? (
            <CaseEditor
              key={editor.item?.id ?? 'new'}
              {...editor}
              people={people}
              cases={cases}
              userId={userId}
              isAdmin={isAdmin}
              today={today}
              onClose={() => setEditor(null)}
              onSaved={saved}
            />
          ) : (
            <>
              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
                <section className="min-w-0">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-base font-bold">Agenda de gestión</h2>
                    <Button variant="ghost" onClick={() => setFilter('all')}>
                      Ver abiertos ({active.length})
                    </Button>
                  </div>
                  <p className="mb-4 text-xs text-ink-muted">
                    Prioridad por vencimiento, impacto declarado, bloqueo y revisión pendiente. No
                    es una predicción.
                  </p>
                  <div className="management-agenda divide-y divide-border rounded-lg border border-border bg-surface">
                    {shown.length === 0 && (
                      <div className="p-8 text-sm text-ink-muted">
                        {active.length === 0 && filter === 'all'
                          ? 'Todavía no hay asuntos abiertos. Organiza una señal o crea el primer asunto con su resultado esperado.'
                          : 'No hay asuntos en esta vista.'}
                      </div>
                    )}
                    {shown.map((c) => {
                      const p = managementPriority(c, today, cases);
                      return (
                        <button
                          type="button"
                          key={c.id}
                          onClick={() => startCase(c.data, c)}
                          data-blocked={c.data.state === 'blocked'}
                          className="management-case group block w-full space-y-2 p-4 text-left hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                        >
                          <div className="flex items-start justify-between gap-3">
                            <strong className="break-words text-sm">{c.data.title}</strong>
                            <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 text-ink-muted" />
                          </div>
                          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-ink-muted">
                            <span className="case-state">
                              {managementStateLabels[c.data.state]}
                            </span>
                            <span>{name(c.data.ownerId)}</span>
                            <span>Plazo {c.data.dueOn}</span>
                          </div>
                          <p className="text-xs font-medium text-primary">
                            {p.reasons.join(' · ')}
                          </p>
                          <p className="break-words text-sm text-ink-muted">
                            Próximo paso: {c.data.nextAction}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </section>
                <aside className="management-context min-w-0 space-y-5">
                  {sourceConflicts.length > 0 && (
                    <section className="space-y-3 rounded-lg border border-amber/30 p-4">
                      <h2 className="text-sm font-bold">Fuentes pendientes tras un cierre</h2>
                      <p className="text-xs text-ink-muted">
                        El asunto está cerrado, pero su fuente aún reporta trabajo pendiente.
                      </p>
                      {sourceConflicts.map(({ signal, caseId }) => (
                        <div key={caseId} className="space-y-2">
                          <p className="text-sm font-semibold">{signal.title}</p>
                          <div className="flex flex-wrap gap-3">
                            <Link href={signal.href} className="text-xs font-semibold text-primary">
                              Abrir fuente
                            </Link>
                            <button
                              type="button"
                              className="text-xs font-semibold"
                              onClick={() => {
                                const item = cases.find((c) => c.id === caseId);
                                if (item) startCase(item.data, item);
                              }}
                            >
                              Revisar cierre →
                            </button>
                          </div>
                        </div>
                      ))}
                    </section>
                  )}
                  <section>
                    <h2 className="mb-2 text-base font-bold">
                      Señales por organizar{' '}
                      <span className="text-ink-muted">{unassigned.length}</span>
                    </h2>
                    <p className="mb-4 text-xs text-ink-muted">
                      Revisa la fuente antes de convertir una señal en trabajo compartido.
                    </p>
                    <div className="divide-y divide-border">
                      {unassigned.length === 0 && (
                        <p className="py-4 text-sm text-ink-muted">
                          Sin señales nuevas en las fuentes consultadas.
                        </p>
                      )}
                      {unassigned.map((s) => (
                        <div key={s.key} className="space-y-2 py-4">
                          <p className="break-words text-sm font-semibold">{s.title}</p>
                          <p className="text-xs text-ink-muted">{s.reason}</p>
                          <div className="flex flex-wrap items-center gap-3">
                            <Link
                              className="text-xs font-semibold text-primary hover:underline"
                              href={s.href}
                            >
                              Abrir fuente
                            </Link>
                            <button
                              type="button"
                              className="text-xs font-semibold hover:underline"
                              onClick={() =>
                                startCase({
                                  ...blankCase(today, profile.data.reviewAfterDays),
                                  title: s.title,
                                  objective: s.reason,
                                  ownerId: s.ownerId,
                                  impact: s.impact,
                                  dueOn: s.dueOn ?? today,
                                  sourceKey: s.key,
                                  sourceUrl: s.href,
                                })
                              }
                            >
                              Organizar →
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                  <section className="space-y-2 border-t border-border pt-4">
                    <h3 className="text-sm font-semibold">Seguimiento</h3>
                    <p className="text-xs text-ink-muted">
                      {active.filter((c) => c.data.nextReviewOn <= today).length} asuntos tienen
                      revisión pendiente hoy. Escalamiento: {name(profile.data.escalationOwnerId)}.
                    </p>
                    <p className="text-xs text-ink-muted">
                      Las señales se actualizan al abrir o actualizar esta vista. Puedes recibir un
                      parte de los asuntos compartidos en una conversación.
                    </p>
                    <DailyBriefControl />
                  </section>
                </aside>
              </div>
              <p className="text-xs text-ink-muted">
                Consulta: {new Date(readAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}{' '}
                · Asuntos compartidos con la empresa. La evidencia propuesta requiere revisión
                humana.
              </p>
            </>
          )}
        </>
      )}
      <div hidden={tab !== 'processes'}>
        <ManualStudio
          activeTab={tab === 'processes'}
          profile={profile}
          isAdmin={isAdmin}
          onSaved={() => router.refresh()}
          onUse={(p) =>
            startCase({
              ...blankCase(today, profile.data.reviewAfterDays),
              title: p.name,
              objective: p.purpose,
              successCriteria: p.successCriteria,
              nextAction: p.steps.slice(0, 1000),
              sourceUrl: p.browserUrl,
            })
          }
        />
      </div>
      {tab === 'settings' && (
        <ProfileEditor
          key={profile.revision}
          onManageProcesses={() => setTab('processes')}
          profile={profile}
          people={people}
          isAdmin={isAdmin}
          onSaved={() => {
            setNotice('Configuración guardada para esta empresa.');
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function DailyBriefControl() {
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  const [job, setJob] = useState<{ id: string; status: string } | null>(null);
  return (
    <div className="space-y-2">
      <p className="text-xs text-ink-muted">
        Lunes a viernes, 8:00 a. m. de Bogotá. Entrega en Cortex; sin correos ni ejecución de
        acciones.
      </p>
      {error && <Alert>{error}</Alert>}
      {job ? (
        <output className="block text-xs">
          {job.status === 'paused' ? 'Tu parte está pausado.' : 'Parte diario activo.'}{' '}
          <Link className="font-semibold text-primary" href={`/schedules/${job.id}`}>
            Ver rutina →
          </Link>
        </output>
      ) : (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            start(async () => {
              try {
                const r = await startDailyBrief();
                if (r.ok) setJob({ id: r.jobId, status: r.status });
                else setError(r.error);
              } catch {
                setError('No se pudo activar.');
              }
            })
          }
        >
          {pending ? 'Activando…' : 'Activar mi parte diario'}
        </Button>
      )}
    </div>
  );
}
