import { readWeeklyManagement } from '@/lib/management/weekly-review';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  addDays,
  bogotaToday,
  mondayOf,
  readManagement,
  readManagementSignals,
} from '@cortex/agent-tools';
import Link from 'next/link';
export const dynamic = 'force-dynamic';
export default async function ReviewPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const end = mondayOf(bogotaToday());
  const start = addDays(end, -7);
  const [review, board, signals] = await Promise.all([
    readWeeklyManagement(db, `${start}T05:00:00Z`, `${end}T05:00:00Z`).catch(() => null),
    readManagement(db),
    readManagementSignals(db, user.id),
  ]);
  const blocked = board.cases.filter((c) => c.data.state === 'blocked');
  const decisions = board.cases.filter(
    (c) =>
      c.data.state === 'review' ||
      (!c.data.ownerId && !['verified', 'cancelled'].includes(c.data.state)),
  );
  return (
    <div className="mx-auto max-w-4xl space-y-7">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">
          Revisión semanal
        </p>
        <h1 className="mt-2 text-2xl font-bold">Resultados que puedes comprobar.</h1>
        <p className="mt-2 text-sm text-ink-muted">
          Última semana cerrada: {start} a {addDays(end, -1)} · Bogotá
        </p>
      </header>
      <section className="rounded-xl border border-border p-5">
        <h2 className="font-semibold">Cierres con evidencia</h2>
        {review ? (
          <div className="mt-3 space-y-3">
            <p className="text-sm">{review.paragraphs[0]}</p>
            {review.missingHistory > 0 && (
              <p className="text-sm text-ink-muted">
                {review.missingHistory} revisiones no tienen historial anterior disponible y no se
                contaron como cierres nuevos.
              </p>
            )}
            {review.closures.map((e) => (
              <div key={e.case_id} className="border-t border-border pt-3">
                <h3 className="text-sm font-semibold">{e.data.title}</h3>
                <p className="mt-1 text-sm text-ink-muted">{e.data.evidence?.observation}</p>
                <a
                  className="mt-2 inline-block text-sm text-primary"
                  href={e.data.evidence?.reference}
                >
                  Consultar evidencia →
                </a>
              </div>
            ))}
          </div>
        ) : (
          <p className="mt-3 text-sm">
            No se pudo comprobar el historial. No se puede concluir que hubo cero cierres.
          </p>
        )}
      </section>
      <section>
        <h2 className="font-semibold">Lo que sigue bloqueado · situación actual</h2>
        {blocked.map((c) => (
          <p key={c.id} className="mt-3 text-sm">
            <strong>{c.data.title}</strong> · {c.data.blocker || 'Falta describir el bloqueo'} ·
            Próximo paso: {c.data.nextAction}
          </p>
        ))}
        {!blocked.length && (
          <p className="mt-3 text-sm text-ink-muted">
            Sin asuntos bloqueados en la vista consultada.
          </p>
        )}
      </section>
      <section>
        <h2 className="font-semibold">Decisiones que necesitas tomar · situación actual</h2>
        {decisions.map((c) => (
          <p key={c.id} className="mt-3 text-sm">
            {c.data.title} ·{' '}
            {c.data.state === 'review'
              ? 'Revisar evidencia antes del cierre'
              : 'Asignar responsable'}
          </p>
        ))}
        <Link className="mt-3 inline-block text-sm text-primary" href="/management">
          Resolver en la agenda →
        </Link>
      </section>
      <section>
        <h2 className="font-semibold">Metas que requieren atención</h2>
        {signals.signals
          .filter((s) => s.key.startsWith('goal:'))
          .map((s) => (
            <p key={s.key} className="mt-3 text-sm">
              {s.title} · {s.reason}
            </p>
          ))}
        {signals.warnings.map((w) => (
          <p key={w} className="mt-3 text-sm">
            {w}
          </p>
        ))}
        <p className="mt-3 text-xs text-ink-muted">
          Se muestran mediciones disponibles del último período cerrado, no un historial de cambios
          de definición de las metas.
        </p>
        <Link className="mt-3 inline-block text-sm text-primary" href="/goals">
          Revisar metas y mediciones →
        </Link>
      </section>
      {board.truncated && (
        <p className="text-sm">
          La agenda está truncada; los pendientes mostrados pueden estar incompletos.
        </p>
      )}
      <footer className="border-t border-border pt-5 text-sm text-ink-muted">
        <p>
          No se calculan ahorros ni ingresos atribuibles sin una línea base y un criterio de
          medición acordados.
        </p>
        <Link href="/reports" className="mt-3 inline-block text-primary">
          Informes semanales guardados →
        </Link>
      </footer>
    </div>
  );
}
