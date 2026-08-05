'use client';

import { Button } from '@/components/ui/button';
import { clsx } from 'clsx';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface McpServer {
  id: string;
  name: string;
  url: string;
  auth_type: 'none' | 'bearer' | 'api_key';
  enabled: boolean;
  trusted: boolean;
  tool_count: number;
  last_checked_at: string | null;
  last_error: string | null;
  /** Whether a secret is stored — never the secret itself. */
  authConfigured: boolean;
  tools: Array<{ tool_name: string; tool_description: string | null }>;
}

function authBadge(t: McpServer['auth_type']): string {
  return t === 'api_key' ? 'API key' : t === 'bearer' ? 'Bearer' : 'Sin auth';
}

/** A soft pill tag on the row: short label, no shadow of its own. */
const TAG = 'rounded-pill border px-2.5 py-0.5 text-[11px] font-semibold';

export function McpServerList({ servers }: { servers: McpServer[] }) {
  if (servers.length === 0) {
    return (
      <p className="max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
        No hay nada conectado. Cortex funciona con las integraciones de arriba; agrega un servidor
        abajo solo si tienes uno propio de MCP.
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {servers.map((s) => (
        <McpServerRow key={s.id} server={s} />
      ))}
    </ul>
  );
}

function McpServerRow({ server }: { server: McpServer }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patch(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError('No se pudo guardar el cambio. Inténtalo de nuevo en un momento.');
        return;
      }
      router.refresh();
    } catch {
      setError('No se pudo conectar con Cortex. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}/refresh`, { method: 'POST' });
      if (!res.ok) {
        setError('No se pudieron leer las herramientas. Revisa que la URL responda.');
        return;
      }
      router.refresh();
    } catch {
      setError('No se pudo conectar con Cortex. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    if (!confirm(`¿Eliminar "${server.name}"? Sus herramientas salen de Cortex de inmediato.`))
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        setError('No se pudo eliminar el servidor. Inténtalo de nuevo en un momento.');
        return;
      }
      router.refresh();
    } catch {
      setError('No se pudo conectar con Cortex. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-card border border-border bg-surface-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-bold text-ink">{server.name}</span>
            <span className={clsx(TAG, 'border-border bg-surface text-ink-faint')}>
              {authBadge(server.auth_type)}
              {server.authConfigured ? ' · stored' : ''}
            </span>
            <span className={clsx(TAG, 'border-primary/30 bg-primary-soft text-primary')}>
              {server.tool_count} {server.tool_count === 1 ? 'herramienta' : 'herramientas'}
            </span>
            {!server.enabled && (
              <span className={clsx(TAG, 'border-amber/40 bg-amber-soft text-amber')}>En pausa</span>
            )}
          </div>
          <p className="tabular mt-1 max-w-md truncate text-[11px] text-ink-faint" title={server.url}>
            {server.url}
          </p>
        </div>

        <div className="flex items-center gap-3 text-[12.5px] text-ink-muted">
          <label
            className="flex items-center gap-1.5"
            title="Deja que Cortex vea las herramientas de este servidor"
          >
            <input
              type="checkbox"
              checked={server.enabled}
              disabled={busy}
              onChange={(e) => patch({ enabled: e.target.checked })}
              className="accent-primary"
            />
            <span>Activo</span>
          </label>
          <label
            className="flex items-center gap-1.5"
            title="Deja que Cortex llame a este servidor sin pedir confirmación"
          >
            <input
              type="checkbox"
              checked={server.trusted}
              disabled={busy}
              onChange={(e) => patch({ trusted: e.target.checked })}
              className="accent-primary"
            />
            <span>De confianza</span>
          </label>
        </div>
      </div>

      {server.last_error && (
        <p className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-[11.5px] text-rose">
          Cortex no pudo comunicarse con este servidor: {server.last_error}. Revisa la URL y la
          credencial, y vuelve a sincronizar sus herramientas.
        </p>
      )}
      {error && (
        <p className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-[11.5px] text-rose">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={refresh} disabled={busy}>
          <RefreshCw className={clsx('h-3 w-3', busy && 'animate-spin')} />
          Sincronizar herramientas
        </Button>
        {/* Removing a server takes its tools out of Cortex at once — it stops
            something, so it takes the red. */}
        <Button type="button" variant="danger" onClick={remove} disabled={busy}>
          <Trash2 className="h-3 w-3" />
          Eliminar
        </Button>
        {server.tools.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11.5px] font-semibold text-primary hover:underline"
          >
            {expanded
              ? 'Ocultar las herramientas'
              : `Ver ${server.tools.length} ${server.tools.length === 1 ? 'herramienta' : 'herramientas'}`}
          </button>
        )}
      </div>

      {expanded && server.tools.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border pt-2.5 text-[11.5px]">
          {server.tools.map((t) => (
            <li key={t.tool_name}>
              <span className="tabular text-ink">{t.tool_name}</span>
              {t.tool_description ? (
                <span className="text-ink-faint"> — {t.tool_description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
