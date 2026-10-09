'use client';

import { Bell, BellOff } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * Activar o apagar las notificaciones del navegador para Cortex (0220): «Tu día»
 * y lo que no puede esperar, aunque la pestaña esté cerrada. Usa el service
 * worker de siempre (/sw.js) y `/api/notifications/push`. Si el servidor no
 * tiene llaves VAPID, o el navegador no puede, no dice nada que no sea verdad.
 */

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type State = 'checking' | 'hidden' | 'ios_needs_install' | 'ask' | 'on' | 'denied';

const API = '/api/notifications/push';

export function PushToggle() {
  const [state, setState] = useState<State>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const set = (s: State) => !cancelled && setState(s);
      const standalone =
        window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true;
      if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !standalone)
        return set('ios_needs_install');
      if (
        !('serviceWorker' in navigator) ||
        !('PushManager' in window) ||
        !('Notification' in window)
      )
        return set('hidden');
      try {
        const res = await fetch(API, { cache: 'no-store' });
        if (!res.ok) return set('hidden');
        if (!((await res.json()) as { enabled?: boolean }).enabled) return set('hidden');
      } catch {
        return set('hidden');
      }
      if (Notification.permission === 'denied') return set('denied');
      try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        const sub = await reg?.pushManager.getSubscription();
        set(sub && Notification.permission === 'granted' ? 'on' : 'ask');
      } catch {
        set('ask');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const info = (await (await fetch(API, { cache: 'no-store' })).json()) as {
        enabled: boolean;
        publicKey: string | null;
      };
      if (!info.enabled || !info.publicKey) return setState('hidden');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return setState(permission === 'denied' ? 'denied' : 'ask');
      await navigator.serviceWorker.register('/sw.js');
      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(info.publicKey),
        }));
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });
      if (!res.ok) throw new Error('No se pudieron activar los avisos.');
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
      const reg = await navigator.serviceWorker.getRegistration('/');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch(API, {
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

  if (state === 'checking' || state === 'hidden') return null;
  const hint = 'text-micro leading-snug text-ink-muted';
  return (
    <div className="flex flex-col items-start gap-1 border-b border-border px-4 py-3 sm:px-5">
      {state === 'ios_needs_install' && (
        <p className={hint}>
          Para recibir avisos en el iPhone, agrega Cortex a tu inicio (Compartir, Agregar a inicio)
          y ábrelo desde ahí.
        </p>
      )}
      {state === 'denied' && (
        <p className={`${hint} flex items-center gap-1.5`}>
          <BellOff className="h-3.5 w-3.5 shrink-0" aria-hidden /> Bloqueaste las notificaciones en
          este navegador. Puedes permitirlas desde los ajustes del sitio.
        </p>
      )}
      {state === 'on' && (
        <button
          type="button"
          disabled={busy}
          onClick={disable}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald hover:underline disabled:opacity-50"
        >
          <Bell className="h-3.5 w-3.5" aria-hidden /> Notificaciones activadas en este dispositivo
          · apagar
        </button>
      )}
      {state === 'ask' && (
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
            Recibe «Tu día» cada mañana y lo urgente en este dispositivo, aunque Cortex esté
            cerrado.
          </p>
        </>
      )}
      {error && <p className="text-micro text-rose">{error}</p>}
    </div>
  );
}
