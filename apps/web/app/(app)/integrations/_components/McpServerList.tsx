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
  return t === 'api_key' ? 'API key' : t === 'bearer' ? 'Bearer' : 'No auth';
}

/** A ruled tag on the row: squared, bordered, never a shadow. */
const TAG = 'rounded-card border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]';

export function McpServerList({ servers }: { servers: McpServer[] }) {
  if (servers.length === 0) {
    return (
      <p className="max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
        Nothing plugged in. Cortex runs on the integrations above — add a server below only if you
        have an MCP server of your own.
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
        setError('Could not save that change. Try again in a moment.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach Cortex. Check your connection and try again.');
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
        setError('Could not read this server\u2019s tools. Check that the URL is reachable.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach Cortex. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    if (!confirm(`Remove "${server.name}"? Its tools disappear from Cortex immediately.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/mcp-servers/${server.id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        setError('Could not remove this server. Try again in a moment.');
        return;
      }
      router.refresh();
    } catch {
      setError('Could not reach Cortex. Check your connection and try again.');
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
              {server.tool_count} tool{server.tool_count === 1 ? '' : 's'}
            </span>
            {!server.enabled && (
              <span className={clsx(TAG, 'border-amber/40 bg-amber-soft text-amber')}>Paused</span>
            )}
          </div>
          <p className="tabular mt-1 max-w-md truncate text-[11px] text-ink-faint" title={server.url}>
            {server.url}
          </p>
        </div>

        <div className="flex items-center gap-3 text-[12.5px] text-ink-muted">
          <label className="flex items-center gap-1.5" title="Expose this server's tools to Cortex">
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
            title="Let Cortex call this server without asking for confirmation"
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
        <p className="mt-2 rounded-card border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-[11.5px] text-rose">
          Cortex could not reach this server: {server.last_error}. Check the URL and the credential,
          then refresh its tools.
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
          Refresh tools
        </Button>
        {/* Removing a server takes its tools out of Cortex at once — it stops
            something, so it takes the red. */}
        <Button type="button" variant="danger" onClick={remove} disabled={busy}>
          <Trash2 className="h-3 w-3" />
          Remove
        </Button>
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
