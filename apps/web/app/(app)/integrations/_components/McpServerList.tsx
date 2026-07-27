'use client';

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
  return t === 'api_key' ? 'API key' : t === 'bearer' ? 'Bearer' : 'No auth';
}

const SMALL_BUTTON =
  'inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-50';

export function McpServerList({ servers }: { servers: McpServer[] }) {
  if (servers.length === 0) {
    return (
      <p className="text-[12.5px] text-ink-faint">
        No external servers plugged in. Zippy runs on the integrations above — add one below only if
        you have an MCP server of your own.
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
        setError('Update failed');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error');
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
        setError('Refresh failed');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    if (!confirm(`Remove "${server.name}"? Its tools disappear from Zippy immediately.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        setError('Delete failed');
        return;
      }
      router.refresh();
    } catch {
      setError('Network error');
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
            <span className="rounded-pill border border-border bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-ink-faint">
              {authBadge(server.auth_type)}
              {server.authConfigured ? ' · stored' : ''}
            </span>
            <span className="rounded-pill bg-primary-soft px-2 py-0.5 text-[10.5px] font-semibold text-primary">
              {server.tool_count} tool{server.tool_count === 1 ? '' : 's'}
            </span>
            {!server.enabled && (
              <span className="rounded-pill bg-surface px-2 py-0.5 text-[10.5px] font-semibold text-ink-faint">
                Paused
              </span>
            )}
          </div>
          <p
            className="mt-0.5 max-w-md truncate font-mono text-[11px] text-ink-faint"
            title={server.url}
          >
            {server.url}
          </p>
        </div>

        <div className="flex items-center gap-3 text-[12.5px] text-ink-muted">
          <label className="flex items-center gap-1.5" title="Expose this server's tools to Zippy">
            <input
              type="checkbox"
              checked={server.enabled}
              disabled={busy}
              onChange={(e) => patch({ enabled: e.target.checked })}
              className="accent-primary"
            />
            <span>Enabled</span>
          </label>
          <label
            className="flex items-center gap-1.5"
            title="Let Zippy call this server without asking for confirmation"
          >
            <input
              type="checkbox"
              checked={server.trusted}
              disabled={busy}
              onChange={(e) => patch({ trusted: e.target.checked })}
              className="accent-primary"
            />
            <span>Trusted</span>
          </label>
        </div>
      </div>

      {server.last_error && (
        <p className="mt-2 rounded-[10px] border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-[11.5px] text-rose">
          Last error: {server.last_error}
        </p>
      )}
      {error && <p className="mt-2 text-[11.5px] text-rose">{error}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" onClick={refresh} disabled={busy} className={SMALL_BUTTON}>
          <RefreshCw className={clsx('h-3 w-3', busy && 'animate-spin')} />
          Refresh tools
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-pill border border-rose/30 bg-surface px-2.5 py-1 text-[11.5px] font-semibold text-rose transition-colors hover:bg-rose-soft disabled:opacity-50"
        >
          <Trash2 className="h-3 w-3" />
          Remove
        </button>
        {server.tools.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-[11.5px] font-semibold text-primary hover:underline"
          >
            {expanded
              ? 'Hide tools'
              : `Show ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {expanded && server.tools.length > 0 && (
        <ul className="mt-3 space-y-1 border-t border-border pt-2.5 text-[11.5px]">
          {server.tools.map((t) => (
            <li key={t.tool_name}>
              <span className="font-mono text-ink">{t.tool_name}</span>
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
