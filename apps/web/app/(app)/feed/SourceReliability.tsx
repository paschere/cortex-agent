'use client';
import type { FeedSourceSummary } from '@/lib/feed/source-management';
import { workspaceHref } from '@/lib/workspace-context';
import { useState } from 'react';
const input = 'rounded-sm border border-border bg-surface px-2 py-1.5 text-xs text-ink';
export function SourceReliability({
  source,
  workspaceId,
  onChanged,
}: { source: FeedSourceSummary; workspaceId: string; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hook, setHook] = useState<{ token: string; path: string } | null>(null);
  async function save(body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(workspaceHref(workspaceId, '/api/feed/sources'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'No se pudo guardar.');
      setHook(data.webhook ?? null);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="basis-full border-t border-border pt-2">
      <summary className="cursor-pointer text-xs font-medium text-ink-muted">
        Vigencia y avisos de cambios
      </summary>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-ink-muted">
          Revisar vigencia cada
          <select
            aria-label={`Vigencia de ${source.name}`}
            className={input}
            disabled={busy}
            value={source.freshnessMinutes}
            onChange={(e) =>
              void save({ action: 'freshness', id: source.id, minutes: Number(e.target.value) })
            }
          >
            <option value={60}>1 hora</option>
            <option value={360}>6 horas</option>
            <option value={1440}>1 día</option>
            <option value={10080}>7 días</option>
            <option value={43200}>30 días</option>
          </select>
        </label>
        <p className="text-xs text-ink-muted">
          Este plazo muestra atrasos; la frecuencia de ejecución se define en cada activación.
        </p>
      </div>
      {['api', 'url', 'google_sheet', 'combined'].includes(source.kind) && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-ink-muted">
            Si tu proveedor puede enviar un webhook, avisa a Cortex cuando cambien los datos. Cortex
            vuelve a consultar la conexión; el aviso no guarda datos en el cerebro ni autoriza
            acciones.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="text-xs font-semibold text-primary disabled:opacity-50"
              disabled={busy || !source.enabled}
              onClick={() => void save({ action: 'webhook', id: source.id, enabled: true })}
            >
              {source.webhookEnabled ? 'Rotar clave del webhook' : 'Configurar webhook'}
            </button>
            {source.webhookEnabled && (
              <button
                type="button"
                className="text-xs text-ink-muted disabled:opacity-50"
                disabled={busy}
                onClick={() => void save({ action: 'webhook', id: source.id, enabled: false })}
              >
                Desactivar webhook
              </button>
            )}
          </div>
          {source.lastWebhookAt && (
            <p className="text-xs text-ink-muted">
              Último aviso: {new Date(source.lastWebhookAt).toLocaleString('es-CO')}
            </p>
          )}
          {hook && (
            <div
              aria-live="polite"
              className="space-y-2 rounded-sm border border-primary/30 p-3 text-xs"
            >
              <p className="font-semibold text-ink">
                Guarda esta clave en la configuración del proveedor. Solo se muestra ahora;
                cualquier clave anterior dejó de funcionar.
              </p>
              <label className="block text-ink-muted">
                URL POST
                <input
                  readOnly
                  className={`${input} mt-1 w-full`}
                  value={`${typeof window === 'undefined' ? '' : window.location.origin}${hook.path}`}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
              <label className="block text-ink-muted">
                Cabecera x-cortex-hook-token
                <input
                  readOnly
                  className={`${input} mt-1 w-full font-mono`}
                  value={hook.token}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
              <p className="text-ink-muted">
                Incluye x-cortex-event-id (ID único del evento) y x-cortex-timestamp (segundos Unix
                actuales). Los avisos vencen a los 5 minutos y los repetidos se ignoran.
              </p>
              <button
                type="button"
                className="font-semibold text-primary"
                onClick={() => setHook(null)}
              >
                Ya guardé la clave
              </button>
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-rose">
          {error}
        </p>
      )}
    </details>
  );
}
