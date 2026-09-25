'use client';

import { renameCompanyAction } from '@/app/(app)/overview/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Cambiar el nombre visible de una empresa propia.
 *
 * Sólo el nombre: el identificador corto (slug) se queda como está porque
 * puede estar en enlaces ya enviados. La acción revalida que la empresa sea
 * de quien la renombra; aquí sólo se pinta la respuesta.
 */
export function RenameCompany({
  organizationId,
  currentName,
}: {
  organizationId: string;
  currentName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(currentName);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const unchanged = name.trim() === currentName || !name.trim();

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setNote(null);
        try {
          const result = await renameCompanyAction({ organizationId, name });
          setNote({ ok: result.ok, text: result.message });
          if (result.ok) router.refresh();
        } catch {
          setNote({ ok: false, text: 'No se pudo guardar. Revisa tu conexión.' });
        } finally {
          setBusy(false);
        }
      }}
      className="space-y-2"
    >
      <label htmlFor="company-name" className="field-label">
        Nombre de la empresa
      </label>
      <Input
        id="company-name"
        value={name}
        maxLength={120}
        onChange={(event) => setName(event.target.value)}
      />
      <p className="text-micro text-ink-faint">
        Lo ven todas las personas del equipo. Los enlaces existentes no cambian.
      </p>
      <div className="flex items-center gap-2">
        <Button type="submit" variant="outline" disabled={busy || unchanged} className="text-xs">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
          Guardar nombre
        </Button>
        {note && (
          <span
            role={note.ok ? 'status' : 'alert'}
            className={note.ok ? 'text-xs text-emerald' : 'text-xs text-rose'}
          >
            {note.text}
          </span>
        )}
      </div>
    </form>
  );
}
