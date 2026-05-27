'use client';

import { useState } from 'react';
import { useDropzone } from 'react-dropzone';

interface FileDropZoneProps {
  conversationId: string;
}

export function FileDropZone({ conversationId }: FileDropZoneProps) {
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
      setStatus('Uploading...');
      try {
        // Find-or-create conversation-scoped collection
        const collRes = await fetch('/api/kb/collections', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            scope: 'conversation',
            scope_id: conversationId,
            name: `Chat files (${conversationId.slice(0, 6)})`,
          }),
        });
        if (!collRes.ok) {
          const err = await collRes.json().catch(() => ({}));
          setStatus(`Error: ${(err as { error?: string }).error ?? 'Failed to create collection'}`);
          return;
        }
        const collData = await collRes.json() as { collection?: { id: string }; id?: string };
        const collectionId = collData.collection?.id ?? collData.id;

        if (!collectionId) {
          setStatus('Error: Could not resolve collection ID');
          return;
        }

        for (const file of acceptedFiles) {
          const form = new FormData();
          form.append('file', file);
          form.append('collectionId', collectionId);
          const docRes = await fetch('/api/kb/documents', { method: 'POST', body: form });
          if (!docRes.ok) {
            setStatus(`Error uploading ${file.name}`);
            return;
          }
        }

        setStatus(`Uploaded ${acceptedFiles.length} file(s). Indexing in background...`);
        setTimeout(() => setStatus(null), 5000);
      } catch (err) {
        setStatus(`Error: ${err instanceof Error ? err.message : 'Unknown error'}`);
      }
    },
  });

  return (
    <div
      {...getRootProps({
        className: [
          'border-dashed border rounded-md text-xs text-neutral-500 p-2 cursor-pointer transition-colors',
          isDragActive
            ? 'bg-neutral-100 dark:bg-neutral-800 border-neutral-400'
            : 'hover:bg-neutral-50 dark:hover:bg-neutral-900',
        ].join(' '),
      })}
    >
      <input {...getInputProps()} />
      {status ?? 'Drop a file here to add it to this conversation (PDF, DOCX, TXT, MD — max 10 MB).'}
    </div>
  );
}
