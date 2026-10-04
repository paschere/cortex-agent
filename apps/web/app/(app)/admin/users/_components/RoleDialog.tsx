'use client';

import { Button } from '@/components/ui/button';
import { ROLES_INFO } from '@/lib/team/role-matrix';
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { setUserPositionAction } from '../actions';

/**
 * Cambiar el rol y a quién le responde una persona, en un solo guardado.
 *
 * Es el desplegable doble que antes vivía en cada fila, ahora dentro de un
 * diálogo que explica lo que cada rol puede. No decide nada: la acción
 * (`setUserPositionAction`) vuelve a aplicar las reglas del servidor.
 */

const SELECT_CLASS =
  'w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15 disabled:opacity-60';

type AssignableRole = 'member' | 'team_admin' | 'org_admin';

/** El rol del directorio, nombrado con la palabra que usa la matriz. */
const OPTIONS: ReadonlyArray<{ value: AssignableRole; label: string; blurb: string }> = [
  { value: 'member', label: ROLES_INFO.member.label, blurb: ROLES_INFO.member.blurb },
  { value: 'team_admin', label: ROLES_INFO.team_admin.label, blurb: ROLES_INFO.team_admin.blurb },
  { value: 'org_admin', label: ROLES_INFO.admin.label, blurb: ROLES_INFO.admin.blurb },
];

export function RoleDialog({
  open,
  onOpenChange,
  personLabel,
  userId,
  currentRole,
  roleLocked,
  lockedReason,
  currentManagerId,
  managerChoices,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  personLabel: string;
  userId: string;
  currentRole: AssignableRole;
  roleLocked: boolean;
  lockedReason?: string;
  currentManagerId: string | null;
  /** Quiénes pueden ser su jefe: ya sin los que cerrarían un círculo. */
  managerChoices: ReadonlyArray<{ id: string; label: string }>;
  onSaved: () => void;
}) {
  const [role, setRole] = useState<AssignableRole>(currentRole);
  const [managerId, setManagerId] = useState(currentManagerId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blurb = OPTIONS.find((option) => option.value === role)?.blurb;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const result = await setUserPositionAction({
        userId,
        role: roleLocked ? null : role,
        managerId: managerId || null,
      });
      if (!result.ok) {
        setError(result.error ?? 'No se pudo guardar.');
        return;
      }
      onOpenChange(false);
      onSaved();
    } catch {
      setError('No se pudo guardar. Revisa tu conexión.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[88vh] w-[min(460px,calc(100vw-1.5rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-pop outline-none">
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="text-sm font-bold text-ink">Rol y jefe</Dialog.Title>
              <Dialog.Description className="mt-0.5 truncate text-xs text-ink-muted">
                {personLabel}
              </Dialog.Description>
            </div>
            <Dialog.Close
              className="rounded-sm p-1 text-ink-faint hover:bg-surface-2 hover:text-ink"
              aria-label="Cerrar"
              disabled={busy}
            >
              <X className="h-4 w-4" />
            </Dialog.Close>
          </div>
          <div className="space-y-4 overflow-y-auto px-5 py-4">
            <div>
              <label htmlFor="role-dialog-role" className="field-label">
                Rol
              </label>
              <select
                id="role-dialog-role"
                value={role}
                onChange={(event) => setRole(event.target.value as AssignableRole)}
                disabled={roleLocked || busy}
                className={`${SELECT_CLASS} mt-1`}
              >
                {OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-muted">{roleLocked ? lockedReason : blurb}</p>
            </div>
            <div>
              <label htmlFor="role-dialog-manager" className="field-label">
                A quién le responde
              </label>
              <select
                id="role-dialog-manager"
                value={managerId}
                onChange={(event) => setManagerId(event.target.value)}
                disabled={busy}
                className={`${SELECT_CLASS} mt-1`}
              >
                <option value="">A nadie</option>
                {managerChoices.map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.label}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-ink-muted">
                Decide a quién avisa Cortex cuando esta persona deja vencer un compromiso y no
                contesta.
              </p>
            </div>
            {error && (
              <p
                role="alert"
                className="rounded-sm border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose"
              >
                {error}
              </p>
            )}
          </div>
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            <Dialog.Close asChild>
              <Button type="button" variant="ghost" disabled={busy}>
                Cancelar
              </Button>
            </Dialog.Close>
            <Button type="button" onClick={save} disabled={busy}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              Guardar
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
