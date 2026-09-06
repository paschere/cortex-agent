'use client';
import { Button } from '@/components/ui/button';
import {
  type CollectionInvoice,
  type CollectionWorkflow,
  type ManagementCaseData,
  workflowLabels,
} from '@/lib/management/shape';
import Link from 'next/link';
import { useEffect, useState, useTransition } from 'react';
import { loadWorkflow, progressWorkflow, startWorkflow, workflowEvidence } from './actions';
import { Alert, Field, Select } from './form-fields';

const phases = [
  'Leer factura',
  'Preparar cobro',
  'Aprobar envío',
  'Seguir respuesta',
  'Verificar pago',
];
export function WorkflowPanel({
  caseId,
  userId,
  canStart,
  onEvidence,
}: {
  caseId: string;
  userId: string;
  canStart: boolean;
  onEvidence: (e: NonNullable<ManagementCaseData['evidence']>) => void;
}) {
  const [run, setRun] = useState<CollectionWorkflow | null>(null);
  const [invoices, setInvoices] = useState<CollectionInvoice[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState('');
  const [invoice, setInvoice] = useState('');
  const [recipient, setRecipient] = useState('');
  const [pending, start] = useTransition();
  const [history, setHistory] = useState<
    { id: string; state: string; detail: string; created_at: string }[]
  >([]);
  async function refresh() {
    const r = await loadWorkflow(caseId);
    if (r.ok) {
      setRun(r.run);
      setInvoices(r.invoices);
      setHistory(r.history as typeof history);
      setLoaded(true);
    } else setError(r.error);
  }
  useEffect(() => {
    let live = true;
    loadWorkflow(caseId)
      .then((r) => {
        if (!live) return;
        if (r.ok) {
          setRun(r.run);
          setInvoices(r.invoices);
          setHistory(r.history as typeof history);
          setLoaded(true);
        } else setError(r.error);
      })
      .catch(() => live && setError('No se pudo cargar el proceso.'));
    return () => {
      live = false;
    };
  }, [caseId]);
  function act(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError('');
    start(async () => {
      try {
        const r = await fn();
        if (!r.ok) setError(r.error ?? 'No se pudo continuar.');
        await refresh();
      } catch {
        setError('No se pudo actualizar.');
      }
    });
  }
  const proof = run?.evidence;
  const position =
    run?.state === 'review' ? 4 : run?.state === 'waiting' ? 3 : run?.state === 'approval' ? 2 : 0;
  if (loaded && !run && !expanded)
    return canStart ? (
      <section className="my-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface-2 p-4">
        <div>
          <h3 className="text-sm font-semibold">Automatizar este asunto</h3>
          <p className="mt-1 text-xs text-ink-muted">
            Vincula una factura para preparar el cobro y seguir su resultado.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => setExpanded(true)}>
          Preparar un cobro
        </Button>
      </section>
    ) : null;
  return (
    <section className="my-6 space-y-4 rounded-lg border border-primary/20 bg-primary-soft/40 p-4">
      <div>
        <h3 className="font-semibold">Proceso de cobro</h3>
        <p className="mt-1 text-xs text-ink-muted">
          Conecta una factura confirmada con su cobro y sus pagos. El mensaje se revisa y aprueba en
          Acciones.
        </p>
      </div>
      <ol className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {phases.map((phase, i) => (
          <li
            key={phase}
            className={`border-t-2 pt-2 text-xs ${run && i <= position ? 'border-primary font-semibold text-primary-ink' : 'border-border text-ink-muted'}`}
          >
            <span className="mr-1">{i + 1}.</span>
            {phase}
          </li>
        ))}
      </ol>
      {error && (
        <Alert>
          {error}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => act(async () => ({ ok: true }))}
          >
            Reintentar
          </button>
        </Alert>
      )}
      {!loaded && !error && (
        <output className="block text-sm text-ink-muted">Consultando el proceso…</output>
      )}
      {loaded &&
        !run &&
        (canStart ? (
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <Select
                label="Factura confirmada (100 más recientes)"
                value={invoice}
                onChange={setInvoice}
              >
                <option value="">Seleccionar factura</option>
                {invoices.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.doc_number ?? 'Sin número'} — {i.counterparty_name ?? 'Sin contraparte'} ·{' '}
                    {i.currency} {i.total_amount}
                  </option>
                ))}
              </Select>
              <Field
                label="Correo del cliente que revisará el cobro"
                type="email"
                value={recipient}
                onChange={setRecipient}
              />
            </div>
            <p className="text-xs text-ink-muted">
              Iniciar autoriza preparar la propuesta y revisar estos registros cada 15 minutos.
              Todavía no envía ningún mensaje. Los datos del proceso serán visibles en este asunto
              compartido.
            </p>
            <Button
              type="button"
              disabled={pending || !invoice || !recipient}
              onClick={() => act(() => startWorkflow({ caseId, invoiceId: invoice, recipient }))}
            >
              {pending ? 'Preparando…' : 'Iniciar seguimiento de cobro'}
            </Button>
            {!invoices.length && (
              <Link href="/kb" className="ml-3 text-xs font-semibold text-primary">
                Subir una factura al cerebro
              </Link>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">
            El responsable, creador o administrador puede iniciar el proceso.
          </p>
        ))}
      {run && (
        <>
          <div className="space-y-2">
            <p className="text-sm font-semibold">{workflowLabels[run.state]}</p>
            <p className="text-sm text-ink-muted">
              {run.detail || 'Listo para consultar la factura.'}
            </p>
            {run.last_checked_at && (
              <p className="text-xs text-ink-muted">
                Última revisión: {new Date(run.last_checked_at).toLocaleString('es-CO')}
              </p>
            )}
          </div>
          {proof && (
            <div className="grid gap-3 border-y border-border py-3 sm:grid-cols-3">
              {[
                ['Total de factura', proof.invoiceTotal],
                ['Pagos confirmados', proof.confirmedPaid],
                ['Saldo', proof.balance],
              ].map(([label, value]) => (
                <div key={String(label)}>
                  <p className="text-xs text-ink-muted">{label}</p>
                  <strong className="tabular-nums">
                    {new Intl.NumberFormat('es-CO', {
                      style: 'currency',
                      currency: proof.currency,
                    }).format(Number(value))}
                  </strong>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {run.action_id && (
              <Link
                href="/actions"
                className="inline-flex items-center rounded-lg border border-border bg-surface px-3 py-2 text-sm font-semibold"
              >
                Revisar cobro y respuesta
              </Link>
            )}
            {run.user_id === userId && run.state !== 'cancelled' && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={pending}
                  onClick={() => act(() => progressWorkflow(caseId))}
                >
                  Revisar ahora
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => act(() => progressWorkflow(caseId, true))}
                >
                  Detener seguimiento
                </Button>
              </>
            )}
            {run.state === 'review' && proof && canStart && (
              <Button
                type="button"
                disabled={pending}
                onClick={() =>
                  act(async () => {
                    const r = await workflowEvidence(caseId);
                    if (r.ok) onEvidence(r.evidence);
                    return r;
                  })
                }
              >
                Usar evidencia en el cierre
              </Button>
            )}
          </div>
          <details className="border-t border-border pt-3">
            <summary className="cursor-pointer text-xs font-semibold">
              Historial del proceso
            </summary>
            <ol className="mt-3 space-y-3">
              {history.map((h) => (
                <li key={h.id} className="border-l-2 border-border pl-3 text-xs">
                  <p>{h.detail}</p>
                  <p className="mt-1 text-ink-faint">
                    {new Date(h.created_at).toLocaleString('es-CO')}
                  </p>
                </li>
              ))}
            </ol>
          </details>
        </>
      )}
    </section>
  );
}
