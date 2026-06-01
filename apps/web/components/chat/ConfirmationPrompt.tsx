'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { confirmationSummary } from '@/lib/tool-labels';

interface ConfirmationPromptProps {
  conversationId: string;
  toolId: string;
  input: unknown;
  onConfirmed?: () => void;
}

type Status = 'pending' | 'running' | 'allowed' | 'cancelled' | 'error';

export function ConfirmationPrompt({ conversationId, toolId, input, onConfirmed }: ConfirmationPromptProps) {
  const [status, setStatus] = useState<Status>('pending');
  const [errorMessage, setErrorMessage] = useState<string>('');

  async function handleAllow() {
    setStatus('running');
    try {
      const res = await fetch('/api/chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, toolId, input }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMessage((data as { error?: string }).error ?? 'Unknown error');
        setStatus('error');
        return;
      }
      setStatus('allowed');
      onConfirmed?.();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Request failed');
      setStatus('error');
    }
  }

  function handleCancel() {
    setStatus('cancelled');
  }

  if (status === 'allowed') {
    return (
      <div className="mt-2 text-xs text-green-700 dark:text-green-400">
        Confirmed and executed.
      </div>
    );
  }

  if (status === 'cancelled') {
    return (
      <div className="mt-2 text-xs text-neutral-500">
        Cancelled.
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="mt-2 text-xs text-red-600 dark:text-red-400">
        Error: {errorMessage}
      </div>
    );
  }

  const summary = confirmationSummary(
    toolId,
    (input && typeof input === 'object' ? (input as Record<string, unknown>) : {}),
  );

  return (
    <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-900/30 dark:border-amber-700 p-2 text-xs">
      <div className="flex items-center gap-1.5 mb-1 font-medium text-amber-900 dark:text-amber-200">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600" />
        <span>Confirm action</span>
      </div>
      <p className="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-100">{summary}</p>
      <details className="mb-2">
        <summary className="cursor-pointer text-amber-700 dark:text-amber-300 select-none">
          Show details
        </summary>
        <pre className="overflow-auto mt-1 rounded bg-amber-100 dark:bg-amber-900/50 p-1 text-[10px]">
          {JSON.stringify(input, null, 2)}
        </pre>
      </details>
      <div className="flex gap-2">
        <Button
          onClick={handleAllow}
          disabled={status === 'running'}
          className="h-6 text-xs px-2 py-0"
        >
          {status === 'running' ? 'Running...' : 'Confirm'}
        </Button>
        <Button
          variant="ghost"
          onClick={handleCancel}
          disabled={status === 'running'}
          className="h-6 text-xs px-2 py-0"
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
