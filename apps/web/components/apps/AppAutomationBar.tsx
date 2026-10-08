'use client';

import { pressAppButtonAction } from '@/lib/apps/button-actions';
import { clsx } from 'clsx';
import { Bell, BellOff, Loader2, Play } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { useAppToast } from './AppToast';

/**
 * LO QUE LAS AUTOMATIZACIONES PONEN EN UNA PANTALLA (0210): los botones de
 * acción manual de la pantalla («Enviar resumen ahora») y el interruptor de las
 * notificaciones del teléfono.
 *
 * Las notificaciones usan el service worker de la app (/a/<app>/sw.js, alcance
 * /a/<app>/, ver lib/apps/service-worker-source.ts) y la ruta
 * /api/apps/public/<app>/push, que sirve igual a un usuario externo y a un
 * miembro de Cortex. Sin llaves VAPID en el servidor el interruptor no se
 * ofrece y se dice que los avisos llegan por correo: nada de prometer un push
 * que no va a salir.
 */

export interface AppButton {
  automationId: string;
  label: string;
}

export function AppButtons({
  appId,
  screen,
  buttons,
}: {
  appId: string;
  screen: string;
  buttons: AppButton[];
}) {
  const [pending, start] = useTransition();
  const toast = useAppToast();
  if (!buttons.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {buttons.map((b) => (
        <button
          key={b.automationId}
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const res = await pressAppButtonAction(appId, screen, b.automationId);
              toast(
                res.ok ? { tone: 'ok', text: res.message } : { tone: 'error', text: res.error },
              );
            })
          }
          className="inline-flex min-h-11 items-center gap-1.5 rounded-pill border border-border bg-surface px-4 text-xs font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Play className="h-3.5 w-3.5" aria-hidden />
          )}
          {b.label}
        </button>
      ))}
    </div>
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type PushState =
  | 'checking'
  | 'unsupported'
  | 'server_off'
  | 'ios_needs_install'
  | 'ask'
  | 'on'
  | 'denied';

export function PushToggle({ appId }: { appId: string }) {
  const [state, setState] = useState<PushState>('checking');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const api = `/api/apps/public/${appId}/push`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const set = (s: PushState) => !cancelled && setState(s);
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true;
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (ios && !standalone) return set('ios_needs_install');
      if (
        !('serviceWorker' in navigator) ||
        !('PushManager' in window) ||
        !('Notification' in window)
      )
        return set('unsupported');
      try {
        const res = await fetch(api, { cache: 'no-store' });
        if (!res.ok) return set('unsupported');
        const info = (await res.json()) as { enabled: boolean };
        if (!info.enabled) return set('server_off');
      } catch {
        return set('unsupported');
      }
      if (Notification.permission === 'denied') return set('denied');
      try {
        const reg = await navigator.serviceWorker.getRegistration(`/a/${appId}/`);
        const sub = await reg?.pushManager.getSubscription();
        set(sub && Notification.permission === 'granted' ? 'on' : 'ask');
      } catch {
        set('ask');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, appId]);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const info = (await (await fetch(api, { cache: 'no-store' })).json()) as {
        enabled: boolean;
        publicKey: string | null;
      };
      if (!info.enabled || !info.publicKey) {
        setState('server_off');
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setState(permission === 'denied' ? 'denied' : 'ask');
        return;
      }
      await navigator.serviceWorker.register(`/a/${appId}/sw.js`, { scope: `/a/${appId}/` });
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(info.publicKey),
        }));
      const res = await fetch(api, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok)
        throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error);
      setState('on');
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'No se pudieron activar los avisos.');
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration(`/a/${appId}/`);
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch(api, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setState('ask');
    } catch {
      setError('No se pudieron apagar los avisos.');
    } finally {
      setBusy(false);
    }
  }

  if (state === 'checking' || state === 'unsupported') return null;
  const hint = 'text-micro leading-snug text-ink-muted';
  if (state === 'server_off')
    return <p className={hint}>Los avisos de esta app te llegan por correo.</p>;
  if (state === 'ios_needs_install')
    return (
      <p className={hint}>
        Para recibir avisos en el iPhone, primero agrega la app a tu inicio (Compartir → Agregar a
        inicio) y ábrela desde ahí.
      </p>
    );
  if (state === 'denied')
    return (
      <p className={clsx(hint, 'flex items-center gap-1.5')}>
        <BellOff className="h-3.5 w-3.5 shrink-0" aria-hidden /> Bloqueaste las notificaciones en
        este navegador; los avisos te llegan por correo. Puedes permitirlas desde los ajustes del
        sitio.
      </p>
    );
  return (
    <div className="flex flex-col items-start gap-1">
      {state === 'on' ? (
        <button
          type="button"
          disabled={busy}
          onClick={disable}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald hover:underline disabled:opacity-50"
        >
          <Bell className="h-3.5 w-3.5" aria-hidden /> Avisos activados · apagar
        </button>
      ) : (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={enable}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline disabled:opacity-50"
          >
            <Bell className="h-3.5 w-3.5" aria-hidden /> Activar notificaciones
          </button>
          <p className={hint}>
            Te avisamos en este teléfono cuando haya algo para ti (un rechazo, algo por revisar),
            aunque tengas la app cerrada. Sin esto te llega por correo.
          </p>
        </>
      )}
      {error && <p className="text-micro text-rose">{error}</p>}
    </div>
  );
}
