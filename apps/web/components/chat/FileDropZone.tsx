'use client';

import { clsx } from 'clsx';
import { useState } from 'react';
import { useDropzone } from 'react-dropzone';

/**
 * Files dropped into a chat go into the person's own notes.
 *
 * They used to land in a bucket scoped to the conversation, which meant a file
 * shared in one thread was reachable by anything that could name that thread
 * and by nothing the person could later find. A personal space is the honest
 * answer: it is theirs, they can see it on /kb, and they can move it into a
 * company space when it turns out to matter to everyone.
 */
export function FileDropZone(_props: { conversationId: string }) {
  const [status, setStatus] = useState<string | null>(null);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
    },
    maxSize: 10 * 1024 * 1024,
    onDrop: async (acceptedFiles) => {
      if (acceptedFiles.length === 0) return;
      setStatus('Adding…');
      try {
        for (const file of acceptedFiles) {
          const form = new FormData();
          form.append('file', file);
          // No space named: the upload route files it under the sender's own
          // notes, which is the only default that cannot over-share.
          const res = await fetch('/api/kb/documents', { method: 'POST', body: form });
          if (!res.ok) {
            setStatus(`${file.name} could not be added.`);
            return;
          }
        }
        setStatus(
          `Saved to your own notes — ${acceptedFiles.length === 1 ? 'it' : 'they'} will be searchable in a minute.`,
        );
        setTimeout(() => setStatus(null), 5000);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'That did not upload.');
      }
    },
  });

  return (
    <div
      {...getRootProps({
        className: clsx(
          'cursor-pointer rounded-[10px] border border-dashed p-2 text-xs transition-colors',
          isDragActive
            ? 'border-primary bg-primary-soft text-primary'
            : 'border-border-strong text-ink-faint hover:bg-surface-2',
        ),
      })}
    >
      <input {...getInputProps()} />
      {status ?? 'Drop a file to save it to your own notes (PDF, DOCX, TXT, MD — max 10 MB).'}
    </div>
  );
}
