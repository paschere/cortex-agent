'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

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
  authConfigured: boolean;
  tools: Array<{ tool_name: string; tool_description: string | null }>;
}

function authBadge(t: McpServer['auth_type']): string {
  return t === 'api_key' ? 'API Key' : t === 'bearer' ? 'Bearer' : 'No auth';
}

export function McpServerList({ servers }: { servers: McpServer[] }) {
  if (servers.length === 0) {
    return (
      <p className="mt-4 text-sm text-neutral-500">
        No external MCP servers yet. Add one below to expose its tools to the agent.
      </p>
    );
  }

  return (
    <ul className="mt-4 space-y-3">
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
    <li className="rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium">{server.name}</span>
            <span className="rounded border px-1.5 py-0.5 text-xs text-neutral-500">
              {authBadge(server.auth_type)}
            </span>
            <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
              {server.tool_count} tool{server.tool_count === 1 ? '' : 's'}
            </span>
          </div>
          <p className="mt-0.5 max-w-md truncate text-xs text-neutral-500" title={server.url}>
            {server.url}
          </p>
        </div>

        <div className="flex items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={server.enabled}
              disabled={busy}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            <span>Enabled</span>
          </label>
          <label
            className="flex items-center gap-1.5"
            title="Allows Claude to call this server without confirmation"
          >
            <input
              type="checkbox"
              checked={server.trusted}
              disabled={busy}
              onChange={(e) => patch({ trusted: e.target.checked })}
            />
            <span>Trusted</span>
          </label>
        </div>
      </div>

      {server.last_error && (
        <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-900/20">
          Last error: {server.last_error}
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <button
          onClick={refresh}
          disabled={busy}
          className="rounded border px-2 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800"
        >
          Refresh
        </button>
        <button
          onClick={remove}
          disabled={busy}
          className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 dark:hover:bg-red-900/20"
        >
          Delete
        </button>
        {server.tools.length > 0 && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-xs text-neutral-500 underline-offset-2 hover:underline"
          >
            {expanded ? 'Hide tools' : `Show ${server.tools.length} tool${server.tools.length === 1 ? '' : 's'}`}
          </button>
        )}
      </div>

      {expanded && server.tools.length > 0 && (
        <ul className="mt-2 space-y-1 border-t pt-2 text-xs">
          {server.tools.map((t) => (
            <li key={t.tool_name}>
              <span className="font-mono">{t.tool_name}</span>
              {t.tool_description ? (
                <span className="text-neutral-500"> — {t.tool_description}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
