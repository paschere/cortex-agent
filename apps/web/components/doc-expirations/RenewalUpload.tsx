'use client';

import { clsx } from 'clsx';
import { LoaderCircle, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ActionResult } from './types';

/**
 * Subir la renovación de un papel.
 *
 * El archivo entra al Cerebro por la misma puerta de siempre
 * (`/api/kb/documents`), en el espacio del documento anterior si se puede
 * escribir ahí; si no, en el cuaderno de quien lo sube. Luego se deja la pista
 * «esto renueva aquello» y la lectura (que corre al indexarse) lo propone en
 * «Por revisar»; al confirmarlo, el papel anterior queda renovado y su aviso
 * se cierra.
 */
export function RenewalUpload({
  expirationId,
  spaceId,
  onLink,
}: {
  expirationId: string;
  spaceId: string | null;
  onLink?: (input: { expirationId: string; documentId: string }) => Promise<ActionResult>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<ActionResult | null>(null);

  async function send(file: File) {
    setBusy(true);
    setNote(null);
    try {
      const post = async (space: string | null) => {
        const form = new FormData();
        form.append('file', file);
        if (space) form.append('space_id', space);
        return fetch('/api/kb/documents', { method: 'POST', body: form });
      };
      let res = await post(spaceId);
      // Sin permiso de escribir en ese espacio: a su cuaderno.
      if (spaceId && (res.status === 403 || res.status === 404)) res = await post(null);
      const body = (await res.json().catch(() => ({}))) as {
        document?: { id: string };
        error?: string;
      };
      if (!res.ok || !body.document) {
        setNote({ ok: false, error: body.error ?? 'No se pudo subir el archivo.' });
        return;
      }
      const linked = onLink
        ? await onLink({ expirationId, documentId: body.document.id })
        : { ok: true };
      setNote(
        linked.ok
          ? {
              ok: true,
              note:
                linked.note ??
                'Subido. Cuando termine de leerlo te pido confirmar la fecha nueva en «Por revisar».',
            }
          : linked,
      );
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="space-y-2">
      <input
        ref={input}
        type="file"
        accept=".pdf,.docx,.txt,.md,application/pdf"
        className="sr-only"
        id={`renewal-${expirationId}`}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void send(file);
        }}
      />
      <label
        htmlFor={`renewal-${expirationId}`}
        className={clsx(
          'inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3.5 text-xs font-bold text-ink transition-colors duration-150 hover:bg-surface-2 motion-reduce:transition-none',
          busy && 'pointer-events-none opacity-60',
        )}
      >
        {busy ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Upload className="h-3.5 w-3.5" aria-hidden />
        )}
        Subir la renovación
      </label>
      {note && (
        <p
          aria-live="polite"
          className={clsx(
            'rounded-sm px-3 py-2 text-xs leading-snug',
            note.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
          )}
        >
          {note.ok ? note.note : note.error}
        </p>
      )}
    </div>
  );
}
