'use client';
import { useDropzone } from 'react-dropzone';
import { useState } from 'react';

export function UploadDropzone({
  collectionId,
  onUploaded,
}: {
  collectionId: string;
  onUploaded: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        ['.docx'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
    },
    maxSize: 10 * 1024 * 1024,
    onDrop: async (files) => {
      setBusy(true);
      for (const f of files) {
        const form = new FormData();
        form.append('file', f);
        form.append('collection_id', collectionId);
        await fetch('/api/kb/documents', { method: 'POST', body: form });
      }
      setBusy(false);
      onUploaded();
    },
  });

  return (
    <div
      {...getRootProps({
        className: `border-2 border-dashed rounded-xl p-8 text-center text-sm cursor-pointer transition ${
          isDragActive
            ? 'bg-neutral-100 dark:bg-neutral-800 border-neutral-400'
            : 'border-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'
        }`,
      })}
    >
      <input {...getInputProps()} />
      {busy
        ? 'Uploading…'
        : isDragActive
          ? 'Drop here…'
          : 'Drop PDF/DOCX/TXT/MD files (≤10 MB) or click to browse'}
    </div>
  );
}
