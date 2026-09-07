'use client';
import { confirmationSummary } from '@/lib/tool-labels';
import { Building2, Check, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Proposal {
  id: string;
  workspaceId: string;
  workspaceName: string;
  toolId: string;
  input: Record<string, unknown>;
  state: string;
  sourceWorkspaceIds: string[];
  result?: unknown;
  error?: string | null;
}
const status: Record<string, string> = {
  pending: 'Necesita tu aprobación',
  executing: 'En ejecución',
  succeeded: 'Ejecutada',
  rejected: 'Descartada',
  failed: 'No ejecutada',
  uncertain: 'Requiere verificar el resultado',
};
const fieldNames: Record<string, string> = {
  to: 'Destinatario',
  subject: 'Asunto',
  body: 'Contenido',
  request: 'Solicitud',
  amount: 'Importe',
  currency: 'Moneda',
  name: 'Nombre',
  title: 'Título',
  description: 'Descripción',
  kind: 'Tipo',
  dueOn: 'Fecha',
  draftId: 'Borrador',
  documentId: 'Documento',
  email: 'Correo',
  spaceId: 'Cerebro',
  instructions: 'Instrucciones',
};

export function GlobalActionCards({
  conversationId,
  refreshKey,
  spaces,
}: { conversationId?: string; refreshKey: boolean; spaces: Array<{ id: string; name: string }> }) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setProposals([]);
    setError(null);
    if (!conversationId || refreshKey) return;
    const abort = new AbortController();
    void fetch(`/api/chat/global/actions?conversationId=${encodeURIComponent(conversationId)}`, {
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const data = await response.json();
        setProposals(data.proposals ?? []);
      })
      .catch(() => {});
    return () => abort.abort();
  }, [conversationId, refreshKey]);
  async function decide(id: string, decision: 'approve' | 'reject') {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const response = await fetch('/api/chat/global/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: id, decision }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'No se pudo registrar la decisión.');
      setProposals((current) => current.map((item) => (item.id === id ? data.proposal : item)));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Comprueba el resultado antes de volver a intentarlo.',
      );
      // Read back the durable claim after a lost response; never auto-retry an action.
      const refreshed = await fetch(
        `/api/chat/global/actions?conversationId=${encodeURIComponent(conversationId ?? '')}`,
      )
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      if (refreshed) setProposals(refreshed.proposals ?? []);
    } finally {
      setBusy(null);
    }
  }
  if (!proposals.length && !error) return null;
  return (
    <section aria-label="Acciones por aprobar" className="space-y-3">
      <div className="flex items-center gap-2 text-xs font-semibold text-violet-200">
        <ShieldCheck className="h-4 w-4" />
        Decisiones por empresa
      </div>
      {proposals.map((proposal) => (
        <article
          key={proposal.id}
          className="overflow-hidden rounded-2xl border border-violet-300/20 bg-[#1b1923]"
        >
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 px-4 py-3">
            <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-zinc-200">
              <Building2 className="h-4 w-4 shrink-0 text-violet-300" />
              {proposal.workspaceName}
            </span>
            <span className="text-[11px] text-violet-300">
              {status[proposal.state] ?? proposal.state}
            </span>
          </header>
          <div className="space-y-3 px-4 py-4">
            <p className="text-sm font-medium text-zinc-100">
              {confirmationSummary(proposal.toolId, proposal.input)}
            </p>
            <dl className="space-y-2 text-xs">
              {Object.entries(proposal.input).map(([key, value]) => (
                <div key={key} className="grid min-w-0 grid-cols-[90px_minmax(0,1fr)] gap-3">
                  <dt className="break-words text-zinc-500">{fieldNames[key] ?? key}</dt>
                  <dd className="whitespace-pre-wrap break-words text-zinc-300">
                    {/token|secret|password/i.test(key)
                      ? '••••••'
                      : typeof value === 'string'
                        ? value
                        : JSON.stringify(value)}
                  </dd>
                </div>
              ))}
            </dl>
            {proposal.sourceWorkspaceIds.length > 1 && (
              <p className="border-t border-white/5 pt-3 text-xs leading-relaxed text-zinc-400">
                Al aprobar autorizas usar el contenido mostrado de estos espacios para esta acción:{' '}
                <span className="text-zinc-200">
                  {proposal.sourceWorkspaceIds
                    .map((id) => spaces.find((s) => s.id === id)?.name ?? id)
                    .join(', ')}
                </span>
                .
              </p>
            )}
            {proposal.error && (
              <p className="text-xs leading-relaxed text-amber-200">{proposal.error}</p>
            )}
            {proposal.result != null && (
              <details className="text-xs text-zinc-400">
                <summary className="cursor-pointer py-1">Ver evidencia del resultado</summary>
                <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/20 p-3">
                  {JSON.stringify(proposal.result, null, 2)}
                </pre>
              </details>
            )}
            {proposal.state === 'pending' && (
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void decide(proposal.id, 'approve')}
                  className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-violet-300 px-4 text-xs font-semibold text-[#17151d] disabled:opacity-40"
                >
                  {busy === proposal.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="h-4 w-4" />
                  )}
                  Aprobar y ejecutar
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void decide(proposal.id, 'reject')}
                  className="min-h-10 px-2 text-xs text-zinc-400 disabled:opacity-40"
                >
                  Descartar
                </button>
              </div>
            )}
          </div>
        </article>
      ))}
      {error && (
        <p role="alert" className="text-xs text-amber-200">
          {error}
        </p>
      )}
    </section>
  );
}
