'use client';

import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type AuthType = 'none' | 'bearer' | 'api_key';

const FIELD =
  'mt-1 w-full rounded-card border border-border bg-surface px-3 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-primary disabled:opacity-50';

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
        setError(
          typeof data.error === 'string'
            ? data.error
            : 'Cortex no pudo agregar ese servidor. Revisa la URL e inténtalo de nuevo.',
        );
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
      // The secret is never echoed back by the API — clear it here too.
      setName('');
      setUrl('');
      setAuthType('none');
      setAuthValue('');
      router.refresh();
    } catch {
      setError('No se pudo conectar con Cortex. Revisa tu conexión e inténtalo de nuevo.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="field-label">Nombre</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={60}
            disabled={disabled}
            placeholder="Mi MCP de Notion"
            className={FIELD}
          />
        </label>
        <label className="block">
          <span className="field-label">URL del servidor (SSE)</span>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
            maxLength={512}
            disabled={disabled}
            placeholder="https://mcp.example.com/sse"
            className={`${FIELD} font-mono text-[12px]`}
          />
        </label>
      </div>

      <fieldset>
        <legend className="field-label">Autenticación</legend>
        <div className="mt-1.5 flex flex-wrap gap-4">
          {(['none', 'bearer', 'api_key'] as AuthType[]).map((t) => (
            <label key={t} className="flex items-center gap-1.5 text-[13px] text-ink">
              <input
                type="radio"
                name="authType"
                value={t}
                checked={authType === t}
                onChange={() => setAuthType(t)}
                disabled={disabled}
                className="accent-primary"
              />
              <span>
                {t === 'api_key' ? 'API key' : t === 'bearer' ? 'Bearer token' : 'Ninguna'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {authType !== 'none' && (
        <label className="block">
          <span className="field-label">{authType === 'bearer' ? 'Bearer token' : 'API key'}</span>
          <input
            type="password"
            value={authValue}
            onChange={(e) => setAuthValue(e.target.value)}
            required
            disabled={disabled}
            placeholder="••••••••••••"
            className={FIELD}
          />
          <span className="mt-1 block text-[11px] leading-relaxed text-ink-faint">
            Se guarda cifrada y no se vuelve a mostrar. Para cambiarla, agrega el servidor de nuevo.
          </span>
        </label>
      )}

      {error && (
        <p className="rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          {error}
        </p>
      )}
      {result && (
        <p className="rounded-card border border-emerald/30 bg-emerald-soft px-3 py-2 text-[12.5px] text-emerald">
          Servidor agregado. Cortex encontró <span className="tabular">{result.toolCount}</span>{' '}
          {result.toolCount === 1 ? 'herramienta' : 'herramientas'}.
          {result.lastError ? ` También reportó: ${result.lastError}` : ''}
        </p>
      )}

      <Button type="submit" disabled={disabled || submitting}>
        {submitting ? 'Agregando…' : 'Agregar servidor'}
      </Button>
    </form>
  );
}
