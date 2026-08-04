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
      setStatus('Guardando…');
      try {
        for (const file of acceptedFiles) {
          const form = new FormData();
          form.append('file', file);
          // No space named: the upload route files it under the sender's own
          // notes, which is the only default that cannot over-share.
          const res = await fetch('/api/kb/documents', { method: 'POST', body: form });
          if (!res.ok) {
            setStatus(`No se pudo guardar ${file.name}.`);
            return;
          }
        }
        setStatus(
          `Guardado en tus propias notas: ${acceptedFiles.length === 1 ? 'se podrá' : 'se podrán'} buscar en un minuto.`,
        );
        setTimeout(() => setStatus(null), 5000);
      } catch (err) {
        setStatus(err instanceof Error ? err.message : 'No se pudo subir el archivo.');
      }
    },
  });

  return (
    <div
      {...getRootProps({
        className: clsx(
          'cursor-pointer rounded-card border border-dashed p-2 text-xs transition-colors',
          isDragActive
            ? 'border-primary bg-primary-soft text-primary'
            : 'border-border-strong text-ink-faint hover:bg-surface-2',
        ),
      })}
    >
      <input {...getInputProps()} />
      {status ??
        'Suelta un archivo para guardarlo en tus propias notas (PDF, DOCX, TXT, MD — máx. 10 MB).'}
    </div>
  );
}
