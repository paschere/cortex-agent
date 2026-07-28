'use client';

import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Loader2, UploadCloud } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useDropzone } from 'react-dropzone';

export function UploadDropzone({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const router = useRouter();

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
    },
    maxSize: 10 * 1024 * 1024,
    onDrop: async (files) => {
      setBusy(true);
      setError(null);
      for (const f of files) {
        const form = new FormData();
        form.append('file', f);
        // The space is decided here, never guessed by the server from the file.
        form.append('space_id', spaceId);
        const res = await fetch('/api/kb/documents', { method: 'POST', body: form });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? `${f.name} could not be added.`);
          break;
        }
      }
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['kb-docs', spaceId] });
      router.refresh();
    },
  });

  return (
    <div>
      <div
        {...getRootProps({
          className: clsx(
            'cursor-pointer rounded-card border border-dashed px-4 py-7 text-center transition-colors',
            isDragActive
              ? 'border-primary bg-primary-soft'
              : 'border-border-strong bg-surface-2 hover:border-primary/40',
          ),
        })}
      >
        <input {...getInputProps()} />
        <span className="mx-auto mb-2 grid h-9 w-9 place-items-center rounded-[10px] bg-surface text-primary">
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <UploadCloud className="h-4 w-4" />
          )}
        </span>
        <p className="text-[13px] font-semibold text-ink">
          {busy
            ? 'Adding…'
            : isDragActive
              ? `Drop it into ${spaceName}`
              : `Drop a file into ${spaceName}`}
        </p>
        <p className="mt-0.5 text-[11.5px] text-ink-faint">
          PDF, Word, text or Markdown, up to 10 MB. Zippy reads it and can answer from it within a
          minute.
        </p>
      </div>
      {error && (
        <p className="mt-2 rounded-[10px] border border-rose/30 bg-rose-soft px-3 py-2 text-[12px] text-rose">
          {error}
        </p>
      )}
    </div>
  );
}
