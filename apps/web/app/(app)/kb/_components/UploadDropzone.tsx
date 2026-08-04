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
      // Audio is transcribed rather than parsed, so a call recording becomes
      // as answerable as a document. Both m4a labels are listed because the
      // same file is typed one way by Safari and the other by Chrome.
      'audio/mpeg': ['.mp3'],
      'audio/mp4': ['.m4a', '.mp4'],
      'audio/x-m4a': ['.m4a'],
      'audio/wav': ['.wav'],
      'audio/webm': ['.webm'],
      'audio/ogg': ['.ogg', '.oga'],
    },
    // The ceiling is the audio one; the server still holds documents to 10 MB.
    // Rejecting a 30 MB recording in the browser for being "too big" would be
    // a lie about a file the Knowledge Base accepts.
    maxSize: 200 * 1024 * 1024,
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
          PDF, Word, text or Markdown up to 10 MB — or a recording (MP3, M4A, WAV, WebM) up to 200
          MB, which Cortex transcribes and can quote back with the speaker and the minute.
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
