'use client';

import type { SchemaActions, SchemaEditorData } from '@/app/(app)/trackers/schema-types';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SchemaEditor } from './SchemaEditor';
import { schemaActions } from './schema-client';

/**
 * El editor de campos y reglas de UNA tabla en un panel lateral. Se abre desde
 * /trackers/[slug] («Campos y reglas») y desde el inspector de una vista
 * («Editar campos y reglas de …»): lee la configuración por `slug` en el
 * servidor cada vez que se abre, así que nunca muestra algo viejo.
 */
export function TrackerSchemaSheet({
  slug,
  open,
  onOpenChange,
  actions = schemaActions,
  onSaved,
}: {
  slug: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: SchemaActions;
  /** Después de guardar: refrescar lo que dependa de la tabla (catálogo del lienzo, la pantalla…). */
  onSaved?: (data: SchemaEditorData) => void;
}) {
  const [data, setData] = useState<SchemaEditorData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !slug) return;
    let alive = true;
    setData(null);
    setError(null);
    actions.load(slug).then((r) => {
      if (!alive) return;
      if (r.ok) setData(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [open, slug, actions]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] animate-veil bg-canvas/70 backdrop-blur-sm" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-[70] flex w-[min(44rem,100vw)] flex-col border-l border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-semibold text-ink">
                Campos y reglas{data ? ` de ${data.tracker.name}` : ''}
              </Dialog.Title>
              <Dialog.Description className="text-xs text-ink-muted">
                Lo que arma Cortex por chat se cambia igual aquí: campos, validaciones, duplicados y
                sincronizaciones.
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-4 pt-4">
            {error && <p className="text-sm text-rose">{error}</p>}
            {!data && !error && (
              <p className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" /> Leyendo la tabla…
              </p>
            )}
            {data && (
              <SchemaEditor
                key={`${data.tracker.id}:${data.tracker.fields.length}`}
                data={data}
                actions={actions}
                onSaved={onSaved}
                onCancel={() => onOpenChange(false)}
              />
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
