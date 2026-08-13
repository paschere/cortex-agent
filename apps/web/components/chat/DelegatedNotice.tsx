'use client';

import {
  type ExercisedMandate,
  type NoticePlanEntry,
  authorizationPhrase,
  delegationHeadline,
} from '@/lib/mandates/delegation';
import { clsx } from 'clsx';
import { KeyRound, Loader2, ShieldOff } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * CORTEX DICIENDO, EN EL MOMENTO, QUE ACABA DE ACTUAR SIN PREGUNTAR.
 *
 * ===========================================================================
 * POR QUÉ ESTO VA EN LA CONVERSACIÓN Y NO EN UNA PANTALLA DE ADMINISTRACIÓN
 * ===========================================================================
 * Hasta hoy, ejercer un mandato dejaba una fila en `audit_events` y nada más.
 * Nadie abre la auditoría, así que lo más gerencial que hace el producto —actuar
 * por su cuenta— solo se descubría cuando algo salía mal. Un aviso que vive en
 * otra pantalla es un aviso que se lee días después de que dejara de importar.
 *
 * Así que se dice aquí, pegado a la respuesta en la que ocurrió, con las tres
 * cosas juntas: QUÉ hizo, POR QUÉ pudo, y la PUERTA DE SALIDA al lado. Las tres
 * o ninguna: sin la razón es una notificación, y sin el botón es una
 * notificación que obliga a ir a buscar dónde se apaga — y un permiso que hay
 * que ir a buscar para quitarlo es un permiso que se queda puesto.
 *
 * ===========================================================================
 * DE DÓNDE SALE CADA PALABRA
 * ===========================================================================
 * El nombre del mandato viaja pegado al resultado de la llamada (`_security`,
 * ver registry.ts). La fecha y la persona salen de `mandates.created_at` y
 * `mandates.granted_by`, leídas por `/api/mandates/exercised`. Nada de esto se
 * genera: ver la cabecera de `lib/mandates/delegation.ts`. Si la lectura no
 * llega, el aviso sale sin fecha y sin botón en vez de salir con una fecha
 * plausible.
 *
 * ===========================================================================
 * EL TONO
 * ===========================================================================
 * Ámbar, no rosa. Esto no es un error ni una advertencia: es el producto
 * haciendo justo lo que se le autorizó, y pintarlo de alarma enseñaría a la
 * persona a tener miedo de un permiso que ella misma concedió. Ámbar es el tono
 * que este sistema reserva para «alguien tiene que mirar esto», que es
 * exactamente lo que se pide.
 */

interface DelegatedNoticeProps {
  entry: NoticePlanEntry;
  /** La concesión leída de la base, o null si no se pudo casar con una fila. */
  exercised: ExercisedMandate | null;
  canRevoke: boolean;
  /** Para que la conversación vuelva a leer el estado tras revocar. */
  onRevoked?: () => void;
}

const STATE_NOTE: Record<ExercisedMandate['state'], string | null> = {
  active: null,
  revoked: 'Ese mandato ya está revocado: desde entonces vuelvo a preguntarte.',
  expired: 'Ese mandato ya caducó: desde entonces vuelvo a preguntarte.',
  scheduled: null,
};

export function DelegatedNotice({ entry, exercised, canRevoke, onRevoked }: DelegatedNoticeProps) {
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justRevoked, setJustRevoked] = useState(false);

  const phrase = exercised ? authorizationPhrase(exercised) : null;
  const headline = delegationHeadline(entry);
  const state = justRevoked ? 'revoked' : (exercised?.state ?? 'active');
  const note = STATE_NOTE[state];

  async function revoke() {
    if (!exercised) return;
    if (
      !window.confirm(
        `Revocar «${exercised.label}». A partir de la siguiente llamada vuelvo a preguntarte antes de hacer esto. ¿Seguimos?`,
      )
    ) {
      return;
    }
    setWorking(true);
    setError(null);
    try {
      const res = await fetch(`/api/mandates/${exercised.mandateId}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'No se pudo revocar.');
        return;
      }
      setJustRevoked(true);
      onRevoked?.();
    } catch {
      setError('No se pudo hablar con el servidor.');
    } finally {
      setWorking(false);
    }
  }

  /**
   * La forma corta: el mismo mandato, otra vez, en la misma conversación.
   *
   * La razón no ha cambiado desde el primer aviso y el botón sigue estando tres
   * mensajes más arriba. Repetir la tarjeta entera cada turno es lo que apaga
   * los avisos; una línea mantiene el rastro sin gastar la atención que hace
   * falta para el mandato SIGUIENTE, que sí se enseña entero.
   */
  if (entry.variant === 'brief') {
    return (
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-[11.5px] text-ink-faint">
        <KeyRound className="h-3 w-3 shrink-0" aria-hidden />
        <span>
          {headline}, bajo el mismo mandato «{entry.label}».
        </span>
        <Link href="/admin/mandates" className="font-semibold text-primary hover:underline">
          Ver
        </Link>
      </p>
    );
  }

  return (
    <div className="mt-2 rounded-card border border-amber/20 bg-amber-soft px-3.5 py-2.5">
      <div className="flex items-start gap-2.5">
        <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold leading-relaxed text-ink">
            {headline}
            {phrase ? `, ${phrase}` : ''}.
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">
            Está dentro del mandato «{entry.label}»{phrase ? '' : ', que un administrador concedió'}
            . Quedó registrado en la auditoría.
            {note ? ` ${note}` : ''}
          </p>

          {error && <p className="mt-1 text-[12px] font-medium text-rose">{error}</p>}

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <Link
              href="/admin/mandates"
              className="text-[12px] font-semibold text-primary hover:underline"
            >
              Ver el mandato
            </Link>
            {exercised && state === 'active' && canRevoke && (
              <button
                type="button"
                onClick={revoke}
                disabled={working}
                className={clsx(
                  'inline-flex items-center gap-1.5 text-[12px] font-semibold text-rose',
                  'transition-opacity duration-150 hover:underline disabled:opacity-50',
                  'motion-reduce:transition-none',
                )}
              >
                {working ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <ShieldOff className="h-3 w-3" />
                )}
                Revocar el permiso
              </button>
            )}
            {exercised && state === 'active' && !canRevoke && (
              // Se dice quién puede, en vez de esconder el botón sin explicar:
              // conceder y revocar son la misma potestad, y quien no la tiene
              // necesita saber a quién pedírselo.
              <span className="text-[11.5px] text-ink-faint">
                Solo un administrador puede revocarlo
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
