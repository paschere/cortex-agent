import { listMandates, mandateState } from '@/lib/mandates/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  listVisibleSpaces,
  managementSourceConflicts,
  readManagement,
  readManagementSignals,
} from '@cortex/agent-tools';
import Link from 'next/link';
export const dynamic = 'force-dynamic';
export default async function ControlPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [board, signals, spaces, mandates] = await Promise.all([
    readManagement(db),
    readManagementSignals(db, user.id),
    listVisibleSpaces(db, user.id),
    user.role === 'org_admin' ? listMandates(db).catch(() => null) : Promise.resolve(null),
  ]);
  const documents = spaces.length
    ? await db
        .from('kb_documents')
        .select('id,title,collection_id,status,recorded_at,valid_until,superseded_by')
        .in(
          'collection_id',
          spaces.map((s) => s.id),
        )
        .order('created_at', { ascending: false })
        .limit(101)
    : { data: [], error: null };
  const conflicts = managementSourceConflicts(signals.signals, board.cases);
  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header>
        <p className="text-xs font-semibold uppercase tracking-widest text-primary">
          Control de la operación
        </p>
        <h1 className="mt-2 text-2xl font-bold">Qué puede hacer y en qué se apoya.</h1>
        <Link className="mt-3 inline-block text-sm text-primary" href="/management/mission">
          Continuar la misión →
        </Link>
      </header>
      <section className="rounded-xl border border-border p-5">
        <h2 className="font-semibold">Seguimiento de cartera · autonomía del proceso</h2>
        <dl className="mt-4 divide-y divide-border">
          {[
            [
              'Puede consultar',
              'Factura seleccionada, pagos vinculados y respuesta al cobro. El acceso depende de tu cuenta y permisos.',
            ],
            [
              'Puede preparar',
              'Una propuesta de cobro y revisiones cada 15 minutos cuando inicias el proceso. No repite automáticamente un envío fallido o sin respuesta.',
            ],
            [
              'Necesita mi aprobación',
              'Enviar el cobro. Un administrador verifica el cierre con evidencia; una respuesta del cliente no prueba el pago.',
            ],
            [
              'Puedo detenerlo',
              'Abre el asunto y usa Detener seguimiento. Detener no deshace correos que ya se enviaron.',
            ],
          ].map(([label, text]) => (
            <div key={label} className="grid gap-2 py-4 sm:grid-cols-[190px_1fr]">
              <dt className="text-sm font-semibold">{label}</dt>
              <dd className="text-sm text-ink-muted">{text}</dd>
            </div>
          ))}
        </dl>
        <Link href="/management/mission" className="text-sm font-semibold text-primary">
          Abrir proceso, historial y controles →
        </Link>
      </section>
      <section>
        <h2 className="font-semibold">Mandatos de la empresa</h2>
        <p className="mt-2 text-sm text-ink-muted">
          Los mandatos existentes autorizan herramientas en la empresa; no están limitados a este
          proceso. La aprobación del cobro de esta misión sigue siendo obligatoria.
        </p>
        {user.role !== 'org_admin' ? (
          <p className="mt-3 text-sm">Un administrador puede revisar y modificar los mandatos.</p>
        ) : (
          <>
            <div className="mt-4 divide-y divide-border">
              {mandates?.map((m) => (
                <div key={m.id} className="py-3">
                  <h3 className="text-sm font-semibold">
                    {m.label} ·{' '}
                    {
                      {
                        active: 'Activo',
                        revoked: 'Revocado',
                        expired: 'Vencido',
                        scheduled: 'Programado',
                      }[mandateState(m)]
                    }
                  </h3>
                  <p className="mt-1 text-xs text-ink-muted">
                    Vigencia: {m.starts_at.slice(0, 10)} a {m.expires_at.slice(0, 10)} · Límite
                    diario: {m.max_uses_per_day ?? 'sin límite configurado'} · Importe:{' '}
                    {m.amount_ceiling ?? 'sin techo configurado'} {m.currency ?? ''} · Sin
                    presencia: {m.applies_unattended ? 'autorizado' : 'no autorizado'}
                  </p>
                </div>
              )) ?? <p>No se pudieron leer los mandatos.</p>}
            </div>
            <Link
              href="/admin/mandates"
              className="mt-3 inline-block text-sm font-semibold text-primary"
            >
              Configurar límites, revocar y consultar usos →
            </Link>
          </>
        )}
      </section>
      <section>
        <h2 className="font-semibold">Decisiones afectadas por información pendiente</h2>
        <p className="mt-2 text-xs text-ink-muted">
          Consultado{' '}
          {new Date(signals.readAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' })}. No es
          la fecha de sincronización de cada proveedor.
        </p>
        <div className="mt-4 divide-y divide-border">
          {signals.signals.map((s) => (
            <div key={s.key} className="py-3">
              <Link href={s.href} className="text-sm font-semibold text-primary">
                {s.title}
              </Link>
              <p className="text-sm text-ink-muted">{s.reason}</p>
            </div>
          ))}
          {conflicts.map((c) => (
            <p key={c.caseId} className="py-3 text-sm">
              El asunto de «{c.signal.title}» está cerrado, pero su fuente todavía requiere
              atención. Confirma el resultado antes de usarlo como evidencia.
            </p>
          ))}
          {signals.warnings.map((w) => (
            <p key={w} className="py-3 text-sm">
              {w}
            </p>
          ))}
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Las inconsistencias comparan asuntos y señales disponibles. No equivalen a una revisión
          semántica de todos los documentos.
        </p>
      </section>
      <section>
        <h2 className="font-semibold">Vigencia y responsable de las fuentes</h2>
        {documents.error ? (
          <p className="mt-3 text-sm">No se pudo consultar la calidad documental.</p>
        ) : (
          <div className="mt-3 divide-y divide-border">
            {documents.data?.slice(0, 100).map((d) => {
              const space = spaces.find((s) => s.id === d.collection_id);
              const owner = board.people.find((p) => p.id === space?.ownerId);
              return (
                <div key={d.id} className="py-3">
                  <Link href="/kb" className="text-sm font-semibold text-primary">
                    {d.title || 'Sin título'}
                  </Link>
                  <p className="mt-1 text-xs text-ink-muted">
                    {d.superseded_by
                      ? 'Reemplazado: consulta la versión sucesora'
                      : d.valid_until
                        ? `Vigencia declarada hasta ${d.valid_until}`
                        : 'Sin vencimiento declarado; requiere criterio humano'}{' '}
                    · Estado: {d.status}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    Fecha documental: {d.recorded_at ?? 'no declarada'} · Responsable del espacio:{' '}
                    {owner?.name || owner?.email || 'por asignar'}
                  </p>
                </div>
              );
            })}
            {!documents.data?.length && (
              <p className="text-sm text-ink-muted">No hay documentos visibles para revisar.</p>
            )}
            {(documents.data?.length ?? 0) > 100 && (
              <p className="text-xs">
                Mostrando los 100 documentos más recientes. Abre el cerebro para consultar el resto.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
