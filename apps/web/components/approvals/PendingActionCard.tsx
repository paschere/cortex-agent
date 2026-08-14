'use client';

import { confirmationReason } from '@/lib/confirmation-notes';
import { confirmationSummary, humanizeToolId } from '@/lib/tool-labels';
import { clsx } from 'clsx';
import { Check, ChevronDown, Clock, Loader2, ShieldAlert, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * LA TARJETA CON LA QUE SE APRUEBA. UNA SOLA, EN DOS SITIOS.
 *
 * ===========================================================================
 * POR QUÉ NO SON DOS
 * ===========================================================================
 * Se monta en `/approvals`, que es la cola, y dentro del hilo del chat cuando
 * alguien pregunta qué espera su aprobación. El precedente es
 * `components/actions/ProposedActionCard.tsx`, y el argumento es el suyo palabra
 * por palabra: dos renderizados de la misma decisión es exactamente cómo el
 * texto que se ve en pantalla y lo que de verdad se ejecuta empiezan a
 * diferir. Aquí además hay una asimetría que lo agrava — el botón ejecuta una
 * llamada ya validada que la persona no escribió — así que la única copia que
 * puede existir del sitio donde se dice «sí» es una.
 *
 * ===========================================================================
 * LAS DOS FORMAS DE LLEGAR AL PAYLOAD, Y POR QUÉ SON DOS
 * ===========================================================================
 * La pantalla `/approvals` es un componente de servidor que ya leyó la fila
 * entera, así que le pasa el `input` y aquí no se pide nada.
 *
 * En el chat NO. La respuesta llega de `approvals.list`, cuyo esquema de salida
 * no tiene sitio para el payload a propósito (ver
 * `packages/agent-tools/src/approvals/shape.ts`): la cola puede contener una
 * exportación de nómina y eso no entra en el contexto del modelo. Así que la
 * tarjeta llega sin él y lo pide con `GET /api/approvals/[id]` sólo si alguien
 * despliega «ver lo que se va a enviar». La persona ve el payload; el modelo
 * nunca.
 *
 * ===========================================================================
 * EL BOTÓN ES UN `fetch`, Y ESO ES UNA DECISIÓN DE SEGURIDAD
 * ===========================================================================
 * `POST /api/approvals/[id]` desde un componente de cliente. No hay ninguna
 * herramienta con la que el modelo pueda aprobar — no existe `approvals.decide`
 * y no va a existir. Lo que impide que Cortex se dé permiso a sí mismo no es
 * una comprobación: es que no hay superficie que invocar. Está argumentado en
 * `packages/agent-tools/src/approvals/tools.ts`.
 */

interface PendingActionCardProps {
  id: string;
  toolId: string;
  /**
   * El payload, cuando quien monta la tarjeta ya lo tenía (la pantalla de
   * aprobaciones). Ausente en el chat, donde se pide al desplegar.
   */
  input?: unknown;
  /**
   * La frase que describe la llamada, cuando viene hecha de fuera. Con `input`
   * presente se calcula aquí y este campo sobra; sin él es lo único que hay.
   */
  summary?: string;
  expiresAt: string;
  /** De dónde salió, ya traducido a algo que una persona reconozca. */
  originLabel?: string | null;
  /**
   * Set when this was already answered — including from an Approve/Decline
   * button in Google Chat. The card then states the decision instead of
   * offering a second, conflicting one.
   */
  decision?: 'approved' | 'declined' | null;
  decidedAt?: string | null;
  decidedVia?: string | null;
  /** Refrescar lo que la tarjeta cambió, cuando quien la monta sabe cómo. */
  onSettled?: () => void;
}

const CHANNEL_LABEL: Record<string, string> = {
  google_chat: 'desde Google Chat',
  mcp: 'desde tu conversación en Claude',
  web: 'aquí',
};

type Status = 'pending' | 'running' | 'done' | 'declining' | 'declined' | 'error';

/** Compact time-to-expiry: "quedan 12m", "vencida". */
function timeLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'vencida';
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `quedan ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `quedan ${hr}h`;
  return `quedan ${Math.floor(hr / 24)}d`;
}

/** Lo que se enseña al desplegar, venga de donde venga. */
type Payload =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; text: string }
  | { state: 'failed'; message: string };

export function PendingActionCard({
  id,
  toolId,
  input,
  summary,
  expiresAt,
  originLabel,
  decision,
  decidedAt,
  decidedVia,
  onSettled,
}: PendingActionCardProps) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>('pending');
  const [errorMessage, setErrorMessage] = useState('');
  const [result, setResult] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [payload, setPayload] = useState<Payload>(
    input === undefined
      ? { state: 'idle' }
      : { state: 'ready', text: JSON.stringify(input, null, 2) },
  );

  async function act(action: 'approve' | 'decline') {
    setStatus(action === 'approve' ? 'running' : 'declining');
    try {
      const res = await fetch(`/api/approvals/${id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage((data as { error?: string }).error ?? 'Unknown error');
        setStatus('error');
        return;
      }
      if (action === 'approve') {
        const data = (await res.json().catch(() => ({}))) as { result?: unknown };
        let compact = '';
        try {
          compact = JSON.stringify(data.result) ?? '';
        } catch {
          compact = String(data.result);
        }
        setResult(compact.length > 600 ? `${compact.slice(0, 600)}…` : compact);
        setStatus('done');
        // Row is already consumed server-side. Skip router.refresh() here so the
        // result stays visible; the list reconciles on the next navigation.
        onSettled?.();
      } else {
        setStatus('declined');
        onSettled?.();
        router.refresh();
      }
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Request failed');
      setStatus('error');
    }
  }

  /**
   * El payload, pedido la primera vez que alguien lo despliega.
   *
   * Una vez traído se queda: volver a plegar y desplegar no vuelve a pedirlo,
   * porque lo que se está mirando es una fila que ya no puede cambiar — está
   * parada esperando esta misma decisión.
   */
  async function toggleDetails() {
    const next = !showDetails;
    setShowDetails(next);
    if (!next || payload.state !== 'idle') return;
    setPayload({ state: 'loading' });
    try {
      const res = await fetch(`/api/approvals/${id}`);
      if (!res.ok) {
        setPayload({ state: 'failed', message: 'No se pudo traer lo que se va a enviar.' });
        return;
      }
      const data = (await res.json()) as { input?: unknown };
      setPayload({ state: 'ready', text: JSON.stringify(data.input ?? null, null, 2) });
    } catch {
      setPayload({ state: 'failed', message: 'No se pudo traer lo que se va a enviar.' });
    }
  }

  /**
   * El titular. Con el payload delante se escribe la frase completa —la misma
   * que ve quien aprueba desde Google Chat—; sin él, la que vino en el
   * resultado de la herramienta; y si tampoco, el nombre de la herramienta.
   * Nunca el id en bruto.
   */
  const title =
    input !== undefined && input !== null && typeof input === 'object' && !Array.isArray(input)
      ? confirmationSummary(toolId, input as Record<string, unknown>)
      : (summary ?? humanizeToolId(toolId));

  // ---- Already answered somewhere else (Chat card, Claude, another tab) ----
  // Rendered before any local state so a decision made elsewhere can never be
  // overridden by this tab still showing buttons.
  if (decision) {
    const when = decidedAt
      ? new Date(decidedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : null;
    const where = decidedVia ? (CHANNEL_LABEL[decidedVia] ?? '') : '';
    const detail = [where, when].filter(Boolean).join(' · ');
    return (
      <div
        className={clsx(
          'flex flex-wrap items-center gap-2 rounded-card border px-4 py-3 text-sm shadow-card',
          decision === 'approved'
            ? 'border-emerald/40 bg-emerald-soft text-emerald'
            : 'border-border bg-surface-2 text-ink-muted',
        )}
      >
        {decision === 'approved' ? <Check className="h-4 w-4" /> : <X className="h-4 w-4" />}
        <span className="font-semibold">
          {decision === 'approved' ? 'Aprobada' : 'Rechazada'} — {title}
        </span>
        {detail && <span className="tabular text-micro text-ink-faint">{detail}</span>}
      </div>
    );
  }

  // ---- Resolved states (compact pills) ----
  if (status === 'done') {
    return (
      <div className="rounded-card border border-emerald/40 bg-emerald-soft px-4 py-3 shadow-card">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald">
          <Check className="h-4 w-4 shrink-0" />
          Aprobada y ejecutada — {title}
        </div>
        {result && (
          <pre className="scroll-slim mt-2 max-h-32 overflow-auto rounded-sm border border-emerald/30 bg-surface p-2 font-mono text-micro leading-relaxed text-ink-muted">
            {result}
          </pre>
        )}
      </div>
    );
  }
  if (status === 'declined') {
    return (
      <div className="flex items-center gap-2 rounded-card border border-border bg-surface-2 px-4 py-3 text-sm text-ink-muted shadow-card">
        <X className="h-4 w-4" />
        Rechazada — {title} no se ejecutó
      </div>
    );
  }

  const busy = status === 'running' || status === 'declining';

  // ---- Pending / running / error card ----
  // The one screen in this queue that asks for a decision, not just shows a
  // result — it lifts off the canvas like every other surface here, plus the
  // amber wash on its header so the ask reads before the copy does.
  return (
    <div className="overflow-hidden rounded-card border border-amber/40 bg-surface shadow-card">
      <div className="flex items-start gap-3 border-b border-amber/30 bg-amber-soft px-4 py-3">
        <ShieldAlert className="mt-0.5 h-[18px] w-[18px] shrink-0 text-amber" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="field-label text-amber">Necesita tu confirmación</span>
            <span className="tabular inline-flex items-center gap-1 rounded-pill border border-border bg-surface px-2 py-0.5 text-micro font-semibold text-ink-muted">
              <Clock className="h-3 w-3" />
              {timeLeft(expiresAt)}
            </span>
          </div>
          <p className="mt-0.5 text-sm font-semibold text-ink">{title}</p>
          <p className="mt-1 text-xs leading-snug text-ink-muted">
            {confirmationReason(toolId)}
          </p>
          {originLabel && (
            <p className="mt-1 text-micro text-ink-faint">Quedó pendiente en {originLabel}.</p>
          )}
        </div>
      </div>

      <div className="px-4 py-3">
        <button
          type="button"
          onClick={() => void toggleDetails()}
          className="flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-ink"
          aria-expanded={showDetails}
        >
          <ChevronDown
            className={clsx('h-3.5 w-3.5 transition-transform', showDetails && 'rotate-180')}
          />
          {showDetails ? 'Ocultar lo que se va a enviar' : 'Ver lo que se va a enviar'}
        </button>
        {showDetails && (
          <>
            {payload.state === 'loading' && (
              <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-faint">
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                Trayéndolo…
              </p>
            )}
            {payload.state === 'failed' && (
              <p className="mt-2 text-xs text-rose">{payload.message}</p>
            )}
            {payload.state === 'ready' && (
              <pre className="scroll-slim mt-2 max-h-48 overflow-auto rounded-sm border border-border bg-surface-2 p-2 font-mono text-micro leading-relaxed text-ink-muted">
                {payload.text}
              </pre>
            )}
          </>
        )}

        {status === 'error' && (
          <p className="mt-2 rounded-sm border border-rose/40 bg-rose-soft px-2.5 py-1.5 text-xs text-rose">
            {errorMessage} No se ejecutó nada. Vuelve a intentarlo o rechaza la acción.
          </p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => act('approve')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-pill bg-amber px-4 py-1.5 text-sm font-semibold text-white transition-all duration-150 hover:-translate-y-px hover:brightness-95 disabled:opacity-60 disabled:hover:translate-y-0 motion-reduce:transform-none motion-reduce:transition-none"
          >
            {status === 'running' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{' '}
                Ejecutando…
              </>
            ) : (
              <>
                <Check className="h-3.5 w-3.5" />{' '}
                {status === 'error' ? 'Reintentar' : 'Aprobar y ejecutar'}
              </>
            )}
          </button>
          <button
            type="button"
            onClick={() => act('decline')}
            disabled={busy}
            className="inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-60"
          >
            {status === 'declining' ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />{' '}
                Rechazando…
              </>
            ) : (
              'Rechazar'
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
