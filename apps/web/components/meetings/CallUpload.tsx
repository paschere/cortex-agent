'use client';

import { Loader2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

export function CallUpload({
  onDone,
  compact = false,
}: {
  onDone: (sessionId: string) => void;
  compact?: boolean;
}) {
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(file: File) {
    setBusy(true);
    setError(null);
    try {
      const body = new FormData();
      body.set('file', file);
      body.set('title', file.name.replace(/\.[^.]+$/, ''));
      const res = await fetch('/api/meetings/archive/upload', { method: 'POST', body });
      const data = (await res.json().catch(() => ({}))) as {
        sessionId?: string;
        error?: string;
      };
      if (!res.ok || !data.sessionId) {
        throw new Error(data.error ?? 'No pude guardar esa grabación.');
      }
      onDone(data.sessionId);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <input
        ref={input}
        type="file"
        accept="audio/*,video/mp4,video/webm,video/quicktime,.mp3,.wav,.m4a,.webm,.mp4"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send(file);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => input.current?.click()}
        className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink disabled:opacity-60"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {busy ? 'Transcribiendo…' : compact ? 'Subir' : 'Subir grabación'}
      </button>
      {error ? <p className="max-w-xs text-right text-[11px] text-rose">{error}</p> : null}
    </div>
  );
}
