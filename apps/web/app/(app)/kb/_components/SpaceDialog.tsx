'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Building2, Loader2, Lock, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createSpace } from '../actions';

/**
 * Creating a personal space and creating a company-wide one are the same form
 * with different weight. The global variant says out loud who ends up reading
 * it, because "everyone's Cortex will answer from this" is the whole difference
 * and it is not visible anywhere afterwards.
 */
export function SpaceDialog({
  kind,
  onClose,
  viewerName,
}: {
  kind: 'personal' | 'global';
  onClose: () => void;
  viewerName: string;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * La decisión de verdad de un espacio de la empresa, desde la 0123: ¿lo ve la
   * empresa entera, o solo quien se lo den? Empieza encendido porque es lo que
   * este diálogo hacía antes y es lo que la mayoría quiere; apagarlo crea el
   * espacio cerrado, y luego se reparte desde «Quién lo ve».
   */
  const [everyone, setEveryone] = useState(true);

  const isGlobal = kind === 'global';

  async function submit() {
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    const res = await createSpace(name, description, kind, everyone);
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(520px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex items-center gap-2.5">
              <span
                className={
                  isGlobal
                    ? 'grid h-8 w-8 place-items-center rounded-card bg-primary-soft text-primary'
                    : 'grid h-8 w-8 place-items-center rounded-card bg-surface-2 text-ink-muted'
                }
              >
                {isGlobal ? <Building2 className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
              </span>
              <div>
                <Dialog.Title className="text-sm font-bold text-ink">
                  {isGlobal ? 'Nuevo espacio común' : 'Nuevo espacio propio'}
                </Dialog.Title>
                <Dialog.Description className="text-micro text-ink-faint">
                  {isGlobal
                    ? everyone
                      ? 'Lo va a leer toda la empresa'
                      : 'Solo lo va a leer quien tú digas'
                    : `Solo ${viewerName} lo va a leer`}
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              className="grid h-8 w-8 shrink-0 place-items-center rounded-card text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>

          <div className="scroll-slim min-h-0 flex-1 space-y-4 overflow-auto px-5 py-4">
            {isGlobal && everyone && (
              <p className="rounded-card border border-amber/30 bg-amber-soft px-3 py-2.5 text-xs leading-relaxed text-ink">
                Lo que dejes aquí se vuelve la respuesta oficial: cuando alguien le pregunte a
                Cortex del tema, va a citar esto. Los borradores, déjalos en un espacio propio hasta
                que sean ciertos.
              </p>
            )}

            <label className="block">
              <span className="text-micro font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Nombre
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder={isGlobal ? 'Tarifas y fletes' : 'Mis notas de clientes'}
                className="mt-1.5 w-full rounded-card border border-border bg-surface px-3 py-2 text-sm text-ink transition placeholder:text-ink-faint focus:border-primary"
              />
            </label>

            <label className="block">
              <span className="text-micro font-semibold uppercase tracking-[0.12em] text-ink-faint">
                Qué va aquí
              </span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                placeholder="Una línea para que el siguiente sepa qué guardar aquí."
                className="mt-1.5 w-full resize-none rounded-card border border-border bg-surface px-3 py-2 text-sm leading-relaxed text-ink transition placeholder:text-ink-faint focus:border-primary"
              />
            </label>

            {isGlobal && (
              <label className="flex cursor-pointer items-start gap-2.5 rounded-card border border-border px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={everyone}
                  onChange={(e) => setEveryone(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold text-ink">
                    Que lo vea toda la empresa
                  </span>
                  <span className="block text-micro leading-relaxed text-ink-faint">
                    Apágalo y el espacio nace cerrado: entra solo quien tú añadas después, por
                    equipos o por personas. Se puede abrir más tarde; lo publicado no se puede
                    despublicar de las respuestas que Cortex ya dio.
                  </span>
                </span>
              </label>
            )}

            {error && (
              <p className="rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose">
                {error}
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
            <button
              type="button"
              onClick={onClose}
              className="rounded-card px-3.5 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={saving || !name.trim()}
              className="inline-flex items-center gap-1.5 rounded-card bg-primary px-4 py-1.5 text-xs font-semibold text-white shadow-pop transition-colors hover:bg-primary-strong disabled:opacity-50"
            >
              {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {isGlobal ? (everyone ? 'Publicar para todos' : 'Crear cerrado') : 'Crear el espacio'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
