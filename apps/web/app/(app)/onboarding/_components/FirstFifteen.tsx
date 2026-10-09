'use client';

import { saveAutopilot } from '@/app/(app)/piloto/actions';
import { Panel } from '@/components/ui/panel';
import { type Finding, chatHref } from '@/lib/first-run/findings';
import { CONNECT_FROM_COOKIE, ONBOARDING_FROM } from '@/lib/first-run/oauth-return';
import type { ProgressView } from '@/lib/first-run/progress';
import { type Flow, type StepId, timePromise } from '@/lib/first-run/steps';
import { FIRST_STEPS_SEEN_COOKIE } from '@/lib/self-service/setup';
import { clsx } from 'clsx';
import {
  ArrowRight,
  BellRing,
  Calculator,
  Check,
  FolderOpen,
  Loader2,
  MessageCircle,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useEffect, useState } from 'react';

/**
 * «LOS PRIMEROS 15 MINUTOS»: un solo camino, cuatro pasos.
 *
 * Reúne lo que ya existía (la pregunta de módulos, los botones de conexión,
 * la entrevista, el piloto) en un recorrido con barra y promesa de tiempo.
 * El estado de cada paso viene del servidor (derivado de los datos, nada se
 * guarda aparte); aquí sólo se elige qué paso se mira y se consulta el avance
 * mientras el paso está abierto. Nada del paquete de herramientas entra al
 * navegador: todo lo que cruza es JSON.
 */

interface Snapshot {
  progress: ProgressView;
  loadingNotes: string[];
  findings: Finding[];
  restricted: boolean;
}

const POLL_MS = 6000;

const btn =
  'inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-bold text-white transition-colors hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50';
const quiet =
  'inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 text-xs font-bold text-ink transition-colors hover:bg-surface-2';

function useSnapshot(active: boolean, withFindings: boolean) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/first-run/progress${withFindings ? '?hallazgos=1' : ''}`, {
        cache: 'no-store',
      });
      if (res.ok) setSnap((await res.json()) as Snapshot);
    } catch {
      /* una consulta caída no tumba el paso: se reintenta sola */
    }
  }, [withFindings]);
  useEffect(() => {
    if (!active) return;
    let stop = false;
    void load();
    const id = setInterval(() => {
      if (!stop && document.visibilityState === 'visible') void load();
    }, POLL_MS);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [active, load]);
  return snap;
}

function ProgressPanel({ snap }: { snap: Snapshot | null }) {
  if (!snap) return <div className="h-12 animate-pulse rounded-card bg-surface-2" aria-hidden />;
  const { progress } = snap;
  return (
    <div
      className="flex flex-col gap-1.5 rounded-card border border-border bg-surface-2/50 p-3"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-xs font-bold text-ink">
        {progress.loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" aria-hidden />
        ) : (
          <Check className="h-3.5 w-3.5 text-emerald" aria-hidden />
        )}
        {progress.loading ? 'Cortex está leyendo…' : 'Esto es lo que Cortex ya leyó'}
      </div>
      {progress.lines.length ? (
        <p className="text-sm text-ink-muted">{progress.lines.join(' · ')}</p>
      ) : (
        <p className="text-sm text-ink-muted">
          Todavía no hay nada leído. Conecta una fuente y aquí verás el avance.
        </p>
      )}
    </div>
  );
}

function SourceRow({
  icon,
  title,
  body,
  done,
  children,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  done: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted">
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-ink">
            {title}
            {done ? (
              <span className="ml-2 rounded-pill bg-emerald-soft px-2 py-0.5 text-micro font-bold text-emerald">
                Conectado
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 text-sm text-ink-muted">{body}</p>
        </div>
      </div>
      {children}
    </div>
  );
}

function DriveSuggestions({ enabled }: { enabled: boolean }) {
  const [folders, setFolders] = useState<string[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    fetch('/api/first-run/drive-folders', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { folders?: Array<{ name: string }> } | null) => {
        if (alive) setFolders((j?.folders ?? []).map((f) => f.name));
      })
      .catch(() => alive && setFolders([]));
    return () => {
      alive = false;
    };
  }, [enabled]);
  if (!enabled) return null;
  return (
    <div className="flex flex-col gap-2 rounded-sm bg-surface-2/60 p-3">
      <p className="text-xs text-ink-muted">
        Cortex <b className="text-ink">no lee nada de tu Drive</b> hasta que elijas las carpetas.
        {folders?.length ? ' Estas son las de primer nivel:' : ''}
      </p>
      {folders?.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {folders.map((f) => (
            <li
              key={f}
              className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface px-2.5 py-1 text-xs text-ink"
            >
              <FolderOpen className="h-3 w-3 text-ink-faint" aria-hidden />
              {f}
            </li>
          ))}
        </ul>
      ) : null}
      <Link href="/kb" className={clsx(quiet, 'self-start')}>
        Elegir carpetas <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </div>
  );
}

function SourcesStep({
  googleConnected,
  accountingConnected,
  whatsappConnected,
  mailbox,
  accounting,
  notice,
}: {
  googleConnected: boolean;
  accountingConnected: boolean;
  whatsappConnected: boolean;
  mailbox: ReactNode;
  accounting: ReactNode;
  notice: { kind: 'ok' | 'error'; text: string } | null;
}) {
  // Los retornos de OAuth miran esta marca para volver aquí y no a /integrations.
  useEffect(() => {
    try {
      document.cookie = `${CONNECT_FROM_COOKIE}=${ONBOARDING_FROM}; path=/; max-age=1800; samesite=lax`;
    } catch {
      /* sin cookies, la conexión vuelve a /integrations: igual funciona */
    }
    return () => {
      try {
        document.cookie = `${CONNECT_FROM_COOKIE}=; path=/; max-age=0; samesite=lax`;
      } catch {
        /* nada que limpiar */
      }
    };
  }, []);
  const snap = useSnapshot(true, false);
  return (
    <div className="flex flex-col gap-3">
      {notice ? (
        <output
          className={clsx(
            'rounded-sm border px-3 py-2 text-sm',
            notice.kind === 'ok'
              ? 'border-emerald/30 bg-emerald-soft text-emerald'
              : 'border-rose/30 bg-rose-soft text-rose',
          )}
        >
          {notice.text}
        </output>
      ) : null}
      <SourceRow
        icon={<FolderOpen className="h-4 w-4" aria-hidden />}
        title="Google: Drive, Gmail y Sheets"
        body="Tus documentos, tus hojas y (si tú lo enciendes) tu correo. Se piden los permisos de lectura."
        done={googleConnected}
      >
        {googleConnected ? (
          <>
            <DriveSuggestions enabled />
            {mailbox}
          </>
        ) : (
          <a href="/api/integrations/google?preset=all" className={clsx(btn, 'self-start')}>
            Conectar Google <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </a>
        )}
      </SourceRow>
      <SourceRow
        icon={<Calculator className="h-4 w-4" aria-hidden />}
        title="Tu programa contable"
        body="Siigo, Alegra o QuickBooks: facturas, cartera y clientes. La primera carga empieza al conectar."
        done={accountingConnected}
      >
        {accounting}
      </SourceRow>
      <SourceRow
        icon={<MessageCircle className="h-4 w-4" aria-hidden />}
        title="WhatsApp"
        body="Para atender clientes y leer los grupos del equipo que tú elijas."
        done={whatsappConnected}
      >
        {whatsappConnected ? null : (
          <Link href="/integrations/whatsapp" className={clsx(quiet, 'self-start')}>
            Conectar WhatsApp <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </SourceRow>
      <ProgressPanel snap={snap} />
    </div>
  );
}

function SummaryStep({ autopilotEnabled }: { autopilotEnabled: boolean }) {
  const router = useRouter();
  const snap = useSnapshot(true, true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [on, setOn] = useState(autopilotEnabled);

  async function enable() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await saveAutopilot({ enabled: true });
      setNote(r.note);
      if (r.ok) {
        setOn(true);
        router.refresh();
      }
    } catch {
      setNote('No pude encenderlo. Inténtalo otra vez o entra a Piloto.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {!snap ? (
        <div className="h-24 animate-pulse rounded-card bg-surface-2" aria-hidden />
      ) : snap.findings.length > 0 ? (
        <ol className="flex flex-col gap-2.5">
          {snap.findings.map((f) => (
            <li
              key={f.id}
              className={clsx(
                'flex flex-col gap-2 rounded-card border p-4',
                f.tone === 'alert'
                  ? 'border-rose/30 bg-rose-soft/40'
                  : f.tone === 'warn'
                    ? 'border-amber/40 bg-amber-soft/40'
                    : 'border-border bg-surface',
              )}
            >
              <p className="text-sm font-bold text-ink">{f.title}</p>
              <p className="text-sm text-ink-muted">{f.detail}</p>
              <Link
                href={f.action.kind === 'chat' ? chatHref(f.action.prompt) : f.action.href}
                className={clsx(quiet, 'self-start')}
              >
                {f.action.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <div className="flex flex-col gap-2 rounded-card border border-border bg-surface p-4">
          <p className="text-sm font-bold text-ink">
            {snap.restricted
              ? 'Los hallazgos con plata y papeles los ve quien administra la empresa.'
              : 'Todavía no tengo suficiente para decirte algo útil.'}
          </p>
          {snap.loadingNotes.map((t) => (
            <p key={t} className="flex items-center gap-2 text-sm text-ink-muted">
              {snap.progress.loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : null}
              {t}
            </p>
          ))}
          <p className="text-xs text-ink-faint">Esta pantalla se actualiza sola.</p>
        </div>
      )}
      <ProgressPanel snap={snap} />
      <div className="flex flex-col gap-2 rounded-card border border-primary/30 bg-primary-soft/40 p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-ink">
          <BellRing className="h-4 w-4 text-primary" aria-hidden />
          Que Cortex vigile esto por ti
        </p>
        <p className="text-sm text-ink-muted">
          El Piloto repasa cada mañana lo que vence, lo que te deben y lo que se atrasó, y te lo
          cuenta. Tú decides qué hace solo.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {on ? (
            <span className="text-xs font-bold text-emerald">Piloto encendido</span>
          ) : (
            <button type="button" onClick={enable} disabled={busy} className={btn}>
              {busy ? 'Encendiendo…' : 'Encender el Piloto'}
            </button>
          )}
          <Link href="/piloto" className={quiet}>
            Ver cómo funciona
          </Link>
        </div>
        {note ? <p className="text-xs text-ink-muted">{note}</p> : null}
      </div>
    </div>
  );
}

function InterviewStep({ state }: { state: 'none' | 'talking' | 'proposed' | 'applied' }) {
  const label =
    state === 'proposed'
      ? 'Revisar el plan que propuso'
      : state === 'talking'
        ? 'Seguir la conversación'
        : state === 'applied'
          ? 'Ver lo que se creó'
          : 'Empezar la conversación';
  return (
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4">
      <p className="text-sm text-ink-muted">
        Cuéntale cómo funciona tu empresa con tus palabras (puedes dictar). Cortex propone tablas,
        vistas, aplicaciones y automatizaciones, y{' '}
        <b className="text-ink">no crea nada sin que lo apruebes</b>. Son unos 5 minutos.
      </p>
      <Link href="/onboarding/entrevista" className={clsx(btn, 'self-start')}>
        {label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </div>
  );
}

export function FirstFifteen({
  flow,
  initialStep,
  googleConnected,
  accountingConnected,
  whatsappConnected,
  interviewState,
  autopilotEnabled,
  slots,
  notice,
  fullGuideHref,
}: {
  flow: Flow;
  initialStep: StepId;
  googleConnected: boolean;
  accountingConnected: boolean;
  whatsappConnected: boolean;
  interviewState: 'none' | 'talking' | 'proposed' | 'applied';
  autopilotEnabled: boolean;
  slots: { modules: ReactNode; mailbox: ReactNode; accounting: ReactNode };
  notice: { kind: 'ok' | 'error'; text: string } | null;
  fullGuideHref: string;
}) {
  const [step, setStep] = useState<StepId>(initialStep);
  const idx = flow.steps.findIndex((s) => s.id === step);
  const current = flow.steps[idx] ?? flow.steps[0];

  useEffect(() => {
    // La puerta del Inicio manda aquí sólo la primera vez.
    try {
      document.cookie = `${FIRST_STEPS_SEEN_COOKIE}=1; path=/; max-age=31536000; samesite=lax`;
    } catch {
      /* sin cookies, el Inicio vuelve a ofrecerlo: no es grave */
    }
  }, []);

  if (!current) return null;
  const prev = flow.steps[idx - 1];
  const next = flow.steps[idx + 1];

  return (
    <section aria-labelledby="first-run-title" className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h1 id="first-run-title" className="text-xl font-extrabold tracking-tight text-ink">
            Ponemos a Cortex a trabajar con tus datos
          </h1>
          <p className="text-sm font-semibold text-ink-muted">{timePromise(flow)}</p>
        </div>
        <div
          role="img"
          aria-label={`Avance de la puesta en marcha: ${flow.percent}%`}
          className="h-2 overflow-hidden rounded-pill bg-surface-2"
        >
          <div
            className="h-full rounded-pill bg-primary transition-[width] duration-500"
            style={{ width: `${Math.max(flow.percent, 4)}%` }}
          />
        </div>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {flow.steps.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => setStep(s.id)}
                aria-current={s.id === step ? 'step' : undefined}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-card border px-3 py-2 text-left text-xs font-bold transition-colors',
                  s.id === step
                    ? 'border-primary bg-primary-soft/60 text-ink ring-1 ring-primary'
                    : 'border-border bg-surface text-ink-muted hover:bg-surface-2',
                )}
              >
                <span
                  className={clsx(
                    'grid h-5 w-5 shrink-0 place-items-center rounded-full text-micro',
                    s.status === 'done' ? 'bg-emerald text-white' : 'border border-border-strong',
                  )}
                  aria-hidden
                >
                  {s.status === 'done' ? <Check className="h-3 w-3" strokeWidth={3} /> : s.n}
                </span>
                <span className="min-w-0 truncate">{s.title}</span>
                {s.status === 'done' ? <span className="sr-only">(hecho)</span> : null}
              </button>
            </li>
          ))}
        </ol>
      </div>

      <Panel className="flex flex-col gap-4 p-5">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-extrabold tracking-tight text-ink">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden />
            {current.n}. {current.title}
            <span className="text-xs font-semibold text-ink-faint">≈{current.minutes} min</span>
          </h2>
          <p className="mt-1 text-sm text-ink-muted">{current.blurb}</p>
        </div>

        {step === 'empresa' ? slots.modules : null}
        {step === 'fuentes' ? (
          <SourcesStep
            googleConnected={googleConnected}
            accountingConnected={accountingConnected}
            whatsappConnected={whatsappConnected}
            mailbox={slots.mailbox}
            accounting={slots.accounting}
            notice={notice}
          />
        ) : null}
        {step === 'cuentale' ? <InterviewStep state={interviewState} /> : null}
        {step === 'resumen' ? <SummaryStep autopilotEnabled={autopilotEnabled} /> : null}

        <div className="flex items-center justify-between gap-2 border-t border-border pt-3">
          {prev ? (
            <button type="button" onClick={() => setStep(prev.id)} className={quiet}>
              Atrás
            </button>
          ) : (
            <span />
          )}
          {next ? (
            <button type="button" onClick={() => setStep(next.id)} className={btn}>
              {current.status === 'done' ? 'Siguiente' : 'Lo hago después'}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          ) : (
            <Link href={fullGuideHref} className={quiet}>
              Ver la guía completa
            </Link>
          )}
        </div>
      </Panel>
    </section>
  );
}
