'use client';

import { parseFileValue } from '@/lib/views/upload-rules';
import { clsx } from 'clsx';
import { FileText, X } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * El valor de un campo `file` en una tabla o tarjeta: miniatura de la foto (que
 * abre grande) o ícono + nombre del archivo (que se abre en otra pestaña).
 */

export function FileValue({
  value,
  size = 36,
  className,
}: { value: string | null | undefined; size?: number; className?: string }) {
  const files = parseFileValue(value);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!files.length) return <span className="text-ink-faint">—</span>;
  return (
    <>
      <span className={clsx('inline-flex flex-wrap items-center gap-1.5', className)}>
        {files.map((f) =>
          f.mime.startsWith('image/') ? (
            <button
              key={f.url}
              type="button"
              onClick={() => setOpen(f.url)}
              aria-label={`Ver ${f.name}`}
              className="overflow-hidden rounded-md border border-line"
              style={{ width: size, height: size }}
            >
              <img src={f.url} alt={f.name} loading="lazy" className="h-full w-full object-cover" />
            </button>
          ) : (
            <a
              key={f.url}
              href={f.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex max-w-[14rem] items-center gap-1 text-primary hover:underline"
            >
              <FileText className="h-4 w-4 shrink-0" aria-hidden />
              <span className="truncate">{f.name}</span>
            </a>
          ),
        )}
      </span>
      {open && (
        // biome-ignore lint/a11y/useSemanticElements: visor propio
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Foto"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setOpen(null)}
          onKeyDown={(e) => e.key === 'Escape' && setOpen(null)}
        >
          <button
            type="button"
            aria-label="Cerrar"
            onClick={() => setOpen(null)}
            className="absolute right-4 top-4 rounded-full bg-black/60 p-3 text-white"
          >
            <X className="h-6 w-6" aria-hidden />
          </button>
          <img src={open} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
        </div>
      )}
    </>
  );
}
