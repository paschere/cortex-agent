'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

interface ConfirmationPromptProps {
  conversationId: string;
  toolId: string;
  input: unknown;
}

type Status = 'pending' | 'running' | 'allowed' | 'cancelled' | 'error';

export function ConfirmationPrompt({ conversationId, toolId, input }: ConfirmationPromptProps) {
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

  return (
    <div className="mt-2 rounded-md border border-yellow-300 bg-yellow-50 dark:bg-yellow-900/30 dark:border-yellow-700 p-2 text-xs">
      <div className="font-medium mb-1 text-yellow-900 dark:text-yellow-200">
        Confirm action: <span className="font-mono">{toolId}</span>
      </div>
      <pre className="overflow-auto mb-2 rounded bg-yellow-100 dark:bg-yellow-900/50 p-1 text-[10px]">
        {JSON.stringify(input, null, 2)}
      </pre>
      <div className="flex gap-2">
        <Button
          onClick={handleAllow}
          disabled={status === 'running'}
          className="h-6 text-xs px-2 py-0"
        >
          {status === 'running' ? 'Running...' : 'Allow'}
        </Button>
        <Button
          variant="ghost"
          onClick={handleCancel}
          disabled={status === 'running'}
          className="h-6 text-xs px-2 py-0"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
