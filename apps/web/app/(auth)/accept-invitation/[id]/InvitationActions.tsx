'use client';

import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { AuthError } from '../../_components/AuthDocument';

/**
 * Los botones de la página de invitación. La página decide CUÁLES salen
 * (`landingAction`, en lib/team/invitation-landing-shape.ts); esto sólo los
 * pinta y habla con el servidor.
 */

type Kind =
  | { kind: 'signup-or-login'; signupHref: string; loginHref: string }
  | { kind: 'respond'; auto: boolean }
  | { kind: 'switch-account'; invitedEmail: string; loginHref: string }
  | { kind: 'open-app' }
  | { kind: 'login-only'; loginHref: string };

const LINK_PRIMARY =
  'cortex-primary-button inline-flex min-h-10 w-full items-center justify-center rounded-pill bg-primary px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary-strong';
const LINK_OUTLINE =
  'inline-flex min-h-10 w-full items-center justify-center rounded-pill border border-border-strong bg-surface px-5 py-2.5 text-sm font-bold text-ink transition-colors hover:border-ink-faint/40 hover:bg-surface-2';

export function InvitationActions({ invitationId, ...props }: { invitationId: string } & Kind) {
  const [state, setState] = useState<'idle' | 'working' | 'done'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const autoStarted = useRef(false);

  async function respond(action: 'accept' | 'reject') {
    setState('working');
    setErr(null);
    try {
      const res = await fetch(`/api/invitations/${encodeURIComponent(invitationId)}/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; next?: string };
      if (!res.ok) {
        setErr(data.error ?? 'No se pudo responder la invitación. Inténtalo de nuevo.');
        setState('idle');
        return;
      }
      setState('done');
      // Recarga entera y no `router.push`: la empresa activa acaba de cambiar y
      // todo el árbol de servidor está renderizado contra la anterior. El destino
      // lo da el servidor y trae `?workspace=`, que no depende de la caché de la sesión.
      if (action === 'accept') window.location.assign(data.next ?? '/');
      else window.location.assign('/');
    } catch {
      setErr('No se pudo responder la invitación. Revisa tu conexión.');
      setState('idle');
    }
  }

  // Quien acaba de crear su cuenta desde el enlace ya dijo que sí: se acepta
  // sola, una vez (el ref evita el doble disparo del modo estricto de React).
  const auto = props.kind === 'respond' && props.auto;
  // biome-ignore lint/correctness/useExhaustiveDependencies: dispara una sola vez al montar.
  useEffect(() => {
    if (!auto || autoStarted.current) return;
    autoStarted.current = true;
    void respond('accept');
  }, [auto]);

  async function switchAccount(loginHref: string) {
    setState('working');
    try {
      await authClient.signOut();
    } finally {
      window.location.assign(loginHref);
    }
  }

  if (props.kind === 'signup-or-login') {
    return (
      <div className="space-y-2.5">
        <Link href={props.signupHref} className={LINK_PRIMARY}>
          Crear mi cuenta
        </Link>
        <Link href={props.loginHref} className={LINK_OUTLINE}>
          Ya tengo cuenta · Entrar
        </Link>
      </div>
    );
  }

  if (props.kind === 'respond') {
    if (auto) {
      return (
        <div aria-live="polite">
          {err ? (
            <AuthError>{err}</AuthError>
          ) : (
            <p className="text-sm text-ink-muted">Entrando a tu empresa…</p>
          )}
        </div>
      );
    }
    return (
      <div>
        <div className="flex gap-3">
          <Button
            type="button"
            disabled={state !== 'idle'}
            onClick={() => respond('accept')}
            className="flex-1 py-2.5"
          >
            {state === 'working' ? 'Un momento…' : 'Aceptar y entrar'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={state !== 'idle'}
            onClick={() => respond('reject')}
            className="flex-1 py-2.5"
          >
            Rechazar
          </Button>
        </div>
        {err && <AuthError>{err}</AuthError>}
      </div>
    );
  }

  if (props.kind === 'switch-account') {
    return (
      <div className="space-y-2.5">
        <Button
          type="button"
          disabled={state !== 'idle'}
          onClick={() => switchAccount(props.loginHref)}
          className="w-full py-2.5"
        >
          {state === 'working'
            ? 'Cerrando sesión…'
            : `Cerrar sesión y entrar con ${props.invitedEmail}`}
        </Button>
        <Link href="/" className={LINK_OUTLINE}>
          Seguir con mi cuenta actual
        </Link>
      </div>
    );
  }

  if (props.kind === 'open-app') {
    return (
      <Link href="/" className={LINK_PRIMARY}>
        Ir a Cortex
      </Link>
    );
  }

  return (
    <Link href={props.loginHref} className={LINK_PRIMARY}>
      Entrar
    </Link>
  );
}
