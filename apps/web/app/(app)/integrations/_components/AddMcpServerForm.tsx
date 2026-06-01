'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

type AuthType = 'none' | 'bearer' | 'api_key';

export function AddMcpServerForm({ disabled = false }: { disabled?: boolean }) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [authType, setAuthType] = useState<AuthType>('none');
  const [authValue, setAuthValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ toolCount: number; lastError: string | null } | null>(
    null,
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || disabled) return;
    setSubmitting(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/mcp-servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          url,
          authType,
          authValue: authType === 'none' ? undefined : authValue,
        }),
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        setError(typeof data.error === 'string' ? data.error : 'Failed to add server');
        return;
      }

      const created = (await res.json()) as { id: string };

      // Synchronously refresh the manifest so we can show a tool-count preview.
      let toolCount = 0;
      let lastError: string | null = null;
      try {
        const refreshRes = await fetch(`/api/mcp-servers/${created.id}/refresh`, {
          method: 'POST',
        });
        if (refreshRes.ok) {
          const refreshData = (await refreshRes.json()) as {
            toolCount: number;
            lastError: string | null;
          };
          toolCount = refreshData.toolCount;
          lastError = refreshData.lastError;
        }
      } catch {
        // best-effort preview
      }

      setResult({ toolCount, lastError });
      setName('');
      setUrl('');
      setAuthType('none');
      setAuthValue('');
      router.refresh();
    } catch {
      setError('Network error — please try again');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={60}
            disabled={disabled}
            placeholder="My Notion MCP"
            className="mt-1 w-full rounded border px-2 py-1.5 text-sm disabled:opacity-50 dark:bg-neutral-900"
          />
        </label>
        <label className="block text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">Server URL (SSE)</span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            maxLength={512}
            disabled={disabled}
            placeholder="https://mcp.example.com/sse"
            className="mt-1 w-full rounded border px-2 py-1.5 text-sm disabled:opacity-50 dark:bg-neutral-900"
          />
        </label>
      </div>

      <fieldset className="text-sm">
        <legend className="text-neutral-600 dark:text-neutral-400">Authentication</legend>
        <div className="mt-1 flex flex-wrap gap-4">
          {(['none', 'bearer', 'api_key'] as AuthType[]).map((t) => (
            <label key={t} className="flex items-center gap-1.5">
              <input
                type="radio"
                name="authType"
                value={t}
                checked={authType === t}
                onChange={() => setAuthType(t)}
                disabled={disabled}
              />
              <span>{t === 'api_key' ? 'API Key' : t === 'bearer' ? 'Bearer' : 'None'}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {authType !== 'none' && (
        <label className="block text-sm">
          <span className="text-neutral-600 dark:text-neutral-400">
            {authType === 'bearer' ? 'Bearer token' : 'API key'}
          </span>
          <input
            type="password"
            value={authValue}
            onChange={(e) => setAuthValue(e.target.value)}
            required
            disabled={disabled}
            placeholder="••••••••••••"
            className="mt-1 w-full rounded border px-2 py-1.5 text-sm disabled:opacity-50 dark:bg-neutral-900"
          />
        </label>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}
      {result && (
        <p className="text-sm text-green-700">
          Server added — {result.toolCount} tool{result.toolCount === 1 ? '' : 's'} discovered.
          {result.lastError ? ` (warning: ${result.lastError})` : ''}
        </p>
      )}

      <button
        type="submit"
        disabled={disabled || submitting}
        className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
      >
        {submitting ? 'Adding…' : 'Add server'}
      </button>
    </form>
  );
}
