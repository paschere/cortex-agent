'use client';

import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * Quién está invitado y todavía no ha entrado.
 *
 * ESTO NO EXISTÍA. Se enviaba la invitación y ahí se acababa el producto: no
 * había forma de saber a quién se le mandó, ni de cancelarla, ni de volver a
 * mandarla cuando el correo se perdía. El asiento, en cambio, sí quedaba
 * ocupado —`readSeats` cuenta las pendientes contra el techo del plan—, así que
 * un espacio podía llenarse con invitaciones que nadie recuerda haber enviado y
 * la única salida era escribirnos.
 *
 * LAS VENCIDAS SE QUEDAN EN LA LISTA. better-auth ni las borra ni les cambia el
 * estado: siguen `pending` para siempre. Esconderlas dejaría el asiento ocupado
 * por una fila invisible, que es justo el agujero de arriba con otra cara. Se
 * marcan «vencida» y se pueden cancelar.
 *
 * Props puras y ninguna llamada a la base, igual que `InviteTeam`: la pantalla
 * que la pinta ya resolvió el espacio, el texto de la caducidad viene redactado
 * desde allí, y cancelar entra como una acción de servidor pasada por prop. Un
 * componente que fuera a buscar él mismo la acción a `app/(app)/admin/users/`
 * volvería a atarse a una ruta, que es de lo que acabamos de sacar a `InviteTeam`.
 */

export interface PendingInvitationView {
  id: string;
  email: string;
  role: 'member' | 'admin' | 'owner';
  expired: boolean;
  /** «vence en 30h» o «vencida», ya redactado por quien la pinta. */
  expiresLabel: string;
  /** La fecha completa, para el `title` de quien quiera el dato exacto. */
  expiresTitle: string;
}

const ROLE_LABEL: Record<PendingInvitationView['role'], string> = {
  owner: 'Dueño del espacio',
  admin: 'Administra',
  member: 'Miembro',
};

export function PendingInvitations({
  invitations,
  cancelInvitation,
}: {
  invitations: PendingInvitationView[];
  /** La acción de servidor que aísla por espacio. Ver admin/users/actions.ts. */
  cancelInvitation: (invitationId: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resent, setResent] = useState<string | null>(null);

  /**
   * La acción de servidor es la que aísla por espacio; aquí sólo se pinta lo que
   * conteste. Si devuelve `ok: false` es porque la invitación ya no está
   * pendiente —o nunca fue de este espacio— y lo honesto es decirlo y recargar,
   * no dejar la fila borrada de la pantalla y presente en la base.
   */
  async function cancel(id: string) {
    setBusy(id);
    setError(null);
    setResent(null);
    try {
      const result = await cancelInvitation(id);
      if (!result.ok) setError(result.error ?? 'No se pudo cancelar la invitación.');
      startTransition(() => router.refresh());
    } catch {
      setError('No se pudo cancelar la invitación. Revisa tu conexión.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Reenviar es invitar otra vez al mismo correo, y la ruta ya sabe hacerlo:
   * `createInvitation` con `resend: true` refresca la fila que ya existe y manda
   * el correo de nuevo, sin duplicarla.
   *
   * SALVO SI ESTÁ VENCIDA, y ese es el motivo de las dos llamadas. better-auth
   * busca la pendiente que va a refrescar descartando las caducadas, así que
   * sobre una vencida no refresca nada: INSERTA una fila nueva y deja la vieja
   * ahí, pendiente y contando asiento para siempre. Por eso la vencida se cancela
   * antes. Cancelar primero además libera el asiento, así que la comprobación de
   * plan de la ruta no rebota un reenvío por un cupo que la propia fila ocupaba.
   */
  async function resend(invitation: PendingInvitationView) {
    if (invitation.role === 'owner') return;
    setBusy(invitation.id);
    setError(null);
    setResent(null);
    try {
      if (invitation.expired) {
        const canceled = await cancelInvitation(invitation.id);
        if (!canceled.ok) {
          setError(canceled.error ?? 'No se pudo reenviar la invitación.');
          return;
        }
      }
      const res = await fetch('/api/team/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: invitation.email, role: invitation.role }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'No se pudo reenviar la invitación.');
        return;
      }
      setResent(invitation.email);
      startTransition(() => router.refresh());
    } catch {
      setError('No se pudo reenviar la invitación. Revisa tu conexión.');
    } finally {
      setBusy(null);
    }
  }

  if (invitations.length === 0) {
    return (
      <p className="px-5 pb-5 pt-3 text-xs leading-relaxed text-ink-muted">
        No hay invitaciones esperando respuesta. Las que envíes aparecen aquí hasta que la persona
        entre, las canceles o venzan.
      </p>
    );
  }

  return (
    <div>
      <ul className="divide-y divide-border">
        {invitations.map((invitation) => (
          <li
            key={invitation.id}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-3 text-xs"
          >
            <span className="min-w-0 flex-1 truncate font-mono text-ink">{invitation.email}</span>
            <span className="rounded-pill border border-border bg-surface-2 px-2 py-0.5 text-micro font-semibold text-ink-muted">
              {ROLE_LABEL[invitation.role]}
            </span>
            <span
              className={`tabular whitespace-nowrap ${
                invitation.expired ? 'font-semibold text-rose' : 'text-ink-faint'
              }`}
              title={invitation.expiresTitle}
            >
              {invitation.expiresLabel}
            </span>
            <span className="flex items-center gap-1.5">
              {invitation.role !== 'owner' && (
                <Button
                  type="button"
                  variant="outline"
                  className="px-2.5 py-1 text-micro"
                  disabled={busy !== null}
                  onClick={() => resend(invitation)}
                >
                  {busy === invitation.id ? 'Enviando…' : 'Reenviar'}
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                className="px-2.5 py-1 text-micro"
                disabled={busy !== null}
                onClick={() => cancel(invitation.id)}
              >
                Cancelar
              </Button>
            </span>
          </li>
        ))}
      </ul>

      {resent && (
        <p className="px-5 pt-2.5 text-xs text-emerald">
          Le volvimos a escribir a <span className="font-mono">{resent}</span>. El enlace nuevo dura
          48 horas.
        </p>
      )}
      {error && <p className="px-5 pt-2.5 text-xs leading-relaxed text-rose">{error}</p>}

      <p className="px-5 pb-4 pt-2.5 text-micro leading-relaxed text-ink-faint">
        Una invitación pendiente ocupa un asiento del plan aunque nadie la haya aceptado todavía.
        Cancelarla lo libera de inmediato.
      </p>
    </div>
  );
}
