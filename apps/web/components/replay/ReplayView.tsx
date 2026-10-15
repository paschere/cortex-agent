import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { chipClass } from '@/lib/status-chip';
import type { ReplaySnapshot } from '@/lib/task-share/shape';
import { AlertCircle, Check, Circle, CircleDot, EyeOff, Hand, Minus } from 'lucide-react';

/**
 * LA REPETICIÓN DE UNA TAREA, COMO UNA HOJA DE CUADERNO.
 *
 * Sólo lectura y sin estado: pinta la foto depurada (ver lib/task-share/shape.ts).
 * La usan la página pública /r/<token> y la maqueta de desarrollo.
 */

const dateFmt = new Intl.DateTimeFormat('es-CO', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});
const fmt = (iso: string | null) =>
  iso && !Number.isNaN(new Date(iso).getTime())
    ? dateFmt.format(new Date(iso)).replace(/[  ]/g, ' ')
    : null;

const STATUS_LABEL: Record<string, string> = {
  done: 'Terminada',
  needs_you: 'Esperaba a una persona',
  failed: 'No pudo terminar',
  cancelled: 'Cancelada',
  working: 'En curso',
  queued: 'En cola',
};

function PlanIcon({ status }: { status: string }) {
  const c = 'mt-0.5 h-4 w-4 shrink-0';
  if (status === 'done') return <Check aria-hidden className={`${c} text-emerald`} />;
  if (status === 'failed') return <AlertCircle aria-hidden className={`${c} text-rose`} />;
  if (status === 'skipped') return <Minus aria-hidden className={`${c} text-ink-faint`} />;
  if (status === 'in_progress') return <CircleDot aria-hidden className={`${c} text-primary`} />;
  return <Circle aria-hidden className={`${c} text-ink-faint`} />;
}

export function ReplayView({
  snapshot: s,
  shotUrl,
  expiresAt,
}: {
  snapshot: ReplaySnapshot;
  /** La ruta de una captura por su clave; sin ella, no se pintan fotos. */
  shotUrl?: (key: string) => string;
  expiresAt: string | null;
}) {
  const started = fmt(s.startedAt);
  const expires = fmt(expiresAt);
  return (
    <article className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-14">
      <p className="text-micro font-semibold tracking-wide text-ink-faint uppercase">
        {s.companyName} · Repetición de una tarea
      </p>
      <h1 className="title-display mt-2 text-balance text-ink [overflow-wrap:anywhere]">
        {s.title}
      </h1>
      <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-ink-muted">
        <span
          className={chipClass(
            s.status === 'done' ? 'emerald' : s.status === 'failed' ? 'rose' : 'neutral',
          )}
        >
          {STATUS_LABEL[s.status] ?? s.status}
        </span>
        {s.ownerName && <span>Hecha para {s.ownerName}</span>}
        {started && <span className="tabular">{started}</span>}
      </p>

      {s.request && (
        <section className="mt-8" aria-label="Lo que se pidió">
          <h2 className="field-label">Lo que se pidió</h2>
          <blockquote className="mt-2 border-l-2 border-border-strong pl-4 text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">
            {s.request}
          </blockquote>
        </section>
      )}

      {s.plan && (
        <section
          className="mt-8 rounded-card border border-border bg-surface p-5 shadow-card"
          aria-label="El plan"
        >
          <h2 className="text-sm font-semibold text-ink">El plan · {s.plan.title}</h2>
          <ol className="mt-2 flex flex-col">
            {s.plan.steps.map((p) => (
              <li key={`${p.label}-${p.status}`} className="flex items-start gap-2.5 py-1.5">
                <PlanIcon status={p.status} />
                <div className="min-w-0 flex-1">
                  <p
                    className={`text-sm leading-snug [overflow-wrap:anywhere] ${p.status === 'pending' || p.status === 'skipped' ? 'text-ink-faint' : 'text-ink'}`}
                  >
                    {p.label}
                  </p>
                  {p.note && (
                    <p className="text-xs text-ink-muted [overflow-wrap:anywhere]">{p.note}</p>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {s.steps.length > 0 && (
        <section className="mt-8" aria-label="Lo que hizo">
          <h2 className="text-sm font-semibold text-ink">
            Lo que hizo <span className="font-normal text-ink-faint">· {s.steps.length} pasos</span>
          </h2>
          <ol className="mt-3 border-l border-border pl-5">
            {s.steps.map((st) => (
              <li key={st.id} className="relative pb-4 last:pb-0">
                <span
                  aria-hidden
                  className={`absolute top-1.5 -left-[1.62rem] flex h-2.5 w-2.5 rounded-full ring-4 ring-canvas ${st.status === 'error' ? 'bg-rose' : st.status === 'waiting' ? 'bg-amber' : 'bg-emerald'}`}
                />
                <p className="flex items-start gap-1.5 text-sm leading-snug text-ink [overflow-wrap:anywhere]">
                  {st.status === 'waiting' && (
                    <Hand aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" />
                  )}
                  <span className={st.status === 'error' ? 'text-rose' : undefined}>
                    {st.sentence}
                  </span>
                </p>
                {st.shot && shotUrl && (
                  <a
                    href={shotUrl(st.shot)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-2 block w-full max-w-sm overflow-hidden rounded-card border border-border bg-surface-2 shadow-card"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={shotUrl(st.shot)}
                      alt={`Captura: ${st.sentence}`}
                      loading="lazy"
                      className="block h-auto w-full"
                    />
                  </a>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {s.answer && (
        <section
          className="mt-8 rounded-card border border-border bg-surface p-5 shadow-card sm:p-8"
          aria-label="La respuesta"
        >
          <h2 className="mb-3 text-sm font-semibold text-ink">La respuesta</h2>
          <div className="text-sm text-ink">
            <ChatMarkdown content={s.answer} />
          </div>
        </section>
      )}

      <footer className="mt-10 border-t border-border pt-4 text-xs leading-relaxed text-ink-faint">
        <p className="flex items-start gap-1.5">
          <EyeOff aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Enlace de solo lectura{expires ? `, vence el ${expires}` : ''}.{' '}
            {s.hidePersonal
              ? 'Se ocultaron correos, teléfonos y NIT; nunca se muestran claves.'
              : 'Nunca se muestran claves ni lo que se escribió en las herramientas.'}{' '}
            Las capturas son tal como estaban en pantalla.
          </span>
        </p>
        <p className="mt-2">Hecho con Cortex</p>
      </footer>
    </article>
  );
}
