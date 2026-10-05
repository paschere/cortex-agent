'use client';

import { Button } from '@/components/ui/button';
import { expiryCountdown, invitationRoleLabel } from '@/lib/team/invitation-roles';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';
import { InviteLink } from './InviteTeam';

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
 * marcan «vencida» y se pueden cancelar o reenviar.
 *
 * ===========================================================================
 * LO QUE SE AGREGÓ: QUIÉN INVITÓ, EL ENLACE Y UN REENVÍO QUE NO PIERDE NADA
 * ===========================================================================
 *   - Quién invitó, el cargo, el equipo y cuánto falta para que venza (en vivo).
 *   - COPIAR EL ENLACE: el correo se pierde (spam, dirección equivocada) y casi
 *     siempre la persona está a un mensaje de WhatsApp de distancia. El enlace
 *     es el mismo del correo y abre la página pública de la invitación.
 *   - REENVIAR llama a `POST /api/team/invitations/<id>/resend`, que renueva el
 *     plazo si está viva y, si está vencida, la cancela y crea una nueva
 *     conservando cargo, equipo y mensaje. Antes eso eran dos llamadas hechas
 *     desde aquí, y un fallo a medias dejaba la fila vieja ocupando asiento.
 *
 * Los datos de arriba (quién invitó, cargo…) no vienen en las props —la pantalla
 * que pinta esto entrega lo básico— sino de `GET /api/team/invitations`, que se
 * vuelve a pedir cuando cambia la lista. Si esa lectura falla, la fila se pinta
 * igual con lo básico: es información extra, nunca una condición.
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

interface Extra {
  expiresAt: string;
  inviterName: string | null;
  position: string | null;
  teamName: string | null;
  hasMessage: boolean;
}

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
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [extras, setExtras] = useState<Record<string, Extra>>({});
  const [now, setNow] = useState(() => new Date());

  // La firma de la lista: cambia cuando se envía, reenvía o cancela algo, y es lo
  // que dispara volver a pedir los datos extra.
  const signature = useMemo(() => invitations.map((i) => i.id).join(','), [invitations]);

  const loadExtras = useCallback(async () => {
    try {
      const res = await fetch('/api/team/invitations');
      if (!res.ok) return;
      const data = (await res.json()) as {
        invitations?: Array<{
          id: string;
          expiresAt: string;
          inviterName: string | null;
          position: string | null;
          teamName: string | null;
          message: string | null;
        }>;
      };
      const next: Record<string, Extra> = {};
      for (const row of data.invitations ?? []) {
        next[row.id] = {
          expiresAt: row.expiresAt,
          inviterName: row.inviterName,
          position: row.position,
          teamName: row.teamName,
          hasMessage: Boolean(row.message),
        };
      }
      setExtras(next);
    } catch {
      /* Sin los extras la lista se pinta igual con lo básico. */
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `signature` es el disparador a propósito.
  useEffect(() => {
    if (invitations.length > 0) void loadExtras();
  }, [signature, loadExtras]);

  // La cuenta regresiva se refresca cada minuto: «vence en 5 h» no puede
  // quedarse en 5 h con la pestaña abierta toda la tarde.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  /**
   * La acción de servidor es la que aísla por espacio; aquí sólo se pinta lo que
   * conteste. Si devuelve `ok: false` es porque la invitación ya no está
   * pendiente —o nunca fue de este espacio— y lo honesto es decirlo y recargar,
   * no dejar la fila borrada de la pantalla y presente en la base.
   */
  async function cancel(id: string) {
    setBusy(id);
    setError(null);
    setNotice(null);
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

  async function resend(invitation: PendingInvitationView) {
    if (invitation.role === 'owner') return;
    setBusy(invitation.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/team/invitations/${encodeURIComponent(invitation.id)}/resend`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(data.error ?? 'No se pudo reenviar la invitación.');
        return;
      }
      setNotice(`Le volvimos a escribir a ${invitation.email}. El enlace nuevo dura siete días.`);
      startTransition(() => router.refresh());
      void loadExtras();
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
        {invitations.map((invitation) => {
          const extra = extras[invitation.id];
          // Con la fecha exacta (de la lectura extra) la cuenta regresiva corre en
          // vivo; sin ella vale la frase que redactó la pantalla.
          const expired = extra
            ? new Date(extra.expiresAt).getTime() <= now.getTime()
            : invitation.expired;
          const label = extra ? expiryCountdown(extra.expiresAt, now) : invitation.expiresLabel;
          return (
            <li key={invitation.id} className="px-5 py-3 text-xs">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <span className="min-w-0 flex-1 truncate font-mono text-ink">
                  {invitation.email}
                </span>
                <span className="rounded-pill border border-border bg-surface-2 px-2 py-0.5 text-micro font-semibold text-ink-muted">
                  {invitationRoleLabel(invitation.role)}
                </span>
                <span
                  className={`tabular whitespace-nowrap ${
                    expired ? 'font-semibold text-rose' : 'text-ink-faint'
                  }`}
                  title={invitation.expiresTitle}
                >
                  {label}
                </span>
              </div>

              {(extra?.inviterName || extra?.position || extra?.teamName || extra?.hasMessage) && (
                <p className="mt-1 text-micro text-ink-faint">
                  {[
                    extra.inviterName ? `Invitó ${extra.inviterName}` : null,
                    extra.position,
                    extra.teamName ? `equipo ${extra.teamName}` : null,
                    extra.hasMessage ? 'con mensaje personal' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}

              {!expired && (
                <div className="mt-2 flex">
                  <InviteLink
                    id={invitation.id}
                    roleLabel={invitationRoleLabel(invitation.role)}
                    copied={copied === invitation.id}
                    onCopied={() => {
                      setCopied(invitation.id);
                      setTimeout(
                        () => setCopied((current) => (current === invitation.id ? null : current)),
                        2500,
                      );
                    }}
                  />
                </div>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
              </div>
            </li>
          );
        })}
      </ul>

      {notice && <p className="px-5 pt-2.5 text-xs text-emerald">{notice}</p>}
      {error && <p className="px-5 pt-2.5 text-xs leading-relaxed text-rose">{error}</p>}

      <p className="px-5 pb-4 pt-2.5 text-micro leading-relaxed text-ink-faint">
        Una invitación pendiente ocupa un asiento del plan aunque nadie la haya aceptado todavía.
        Cancelarla lo libera de inmediato.
      </p>
    </div>
  );
}
