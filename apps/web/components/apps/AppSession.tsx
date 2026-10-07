'use client';

import { signOutAppAction, signOutEverywhereAction } from '@/lib/apps/external-actions';
import { agoLabel } from '@/lib/apps/offline-cache';
import { Download, LogOut, Share, WifiOff } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, useTransition } from 'react';

/**
 * LO QUE LA APP HACE EN EL TELÉFONO (0209): registrar su service worker (con
 * alcance /a/<app>/), decirle quién es la persona para que guarde SU copia sin
 * conexión, avisar cuando no hay señal e instalarse.
 *
 * El service worker (lib/apps/service-worker-source.ts) sólo guarda algo
 * cuando la página le manda `who`: así la copia siempre es de quien la abrió.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => {
      window.addEventListener('online', cb);
      window.addEventListener('offline', cb);
      return () => {
        window.removeEventListener('online', cb);
        window.removeEventListener('offline', cb);
      };
    },
    () => navigator.onLine,
    () => true,
  );
}

/** Registra el worker y lo pone al día de quién mira. No dibuja nada. */
export function AppWorker({ appId, userKey }: { appId: string; userKey: string }) {
  const pathname = usePathname();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pathname` vuelve a avisarle al worker quién es en cada pantalla (guarda SU copia de esa pantalla)
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let cancelled = false;
    const announce = (reg: ServiceWorkerRegistration) => {
      const target = reg.active ?? navigator.serviceWorker.controller;
      target?.postMessage({
        type: 'who',
        userKey,
        url: `${window.location.pathname}${window.location.search}`,
      });
    };
    navigator.serviceWorker
      .register(`/a/${appId}/sw.js`, { scope: `/a/${appId}/` })
      .then(async () => {
        const ready = await navigator.serviceWorker.ready;
        if (!cancelled) announce(ready);
      })
      .catch(() => {
        // Sin service worker no hay modo sin conexión ni botón de instalar; la app funciona igual.
      });
    return () => {
      cancelled = true;
    };
  }, [appId, userKey, pathname]);
  return null;
}

/** «Sin conexión · datos de hace X». */
export function OfflineBanner({ computedAt }: { computedAt: string }) {
  const online = useOnline();
  if (online) return null;
  return (
    <output className="view-no-print mb-4 flex items-center gap-2 rounded-card border border-amber/40 bg-amber-soft px-4 py-2.5 text-sm font-medium text-ink">
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        Sin conexión · datos de {agoLabel(computedAt)}. Lo que registres se envía cuando vuelva la
        señal.
      </span>
    </output>
  );
}

/** «Instalar en este teléfono»: Chrome/Android con el aviso del navegador; iPhone con instrucciones. */
export function InstallButton() {
  const [event, setEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [ios, setIos] = useState(false);
  const [standalone, setStandalone] = useState(true);
  const [help, setHelp] = useState(false);

  useEffect(() => {
    setStandalone(
      window.matchMedia('(display-mode: standalone)').matches ||
        (navigator as unknown as { standalone?: boolean }).standalone === true,
    );
    setIos(/iPhone|iPad|iPod/.test(navigator.userAgent));
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setStandalone(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  if (standalone || (!event && !ios)) return null;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={async () => {
          if (event) {
            await event.prompt();
            await event.userChoice.catch(() => null);
            setEvent(null);
          } else setHelp((v) => !v);
        }}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
      >
        <Download className="h-3.5 w-3.5" aria-hidden /> Instalar en este teléfono
      </button>
      {help && (
        <p className="max-w-[14rem] text-micro leading-snug text-ink-muted">
          En el iPhone: toca <Share className="inline h-3 w-3" aria-hidden /> Compartir y luego
          «Agregar a inicio».
        </p>
      )}
    </div>
  );
}

/** Cerrar sesión y «cerrar todas mis sesiones» (sólo para usuarios externos). */
export function SignOutMenu({ appId }: { appId: string }) {
  const [pending, start] = useTransition();
  const leave = (everywhere: boolean) =>
    start(async () => {
      // Primero se le avisa al worker: la copia de esta persona no se queda en el teléfono.
      navigator.serviceWorker?.controller?.postMessage({ type: 'signout' });
      await (everywhere ? signOutEverywhereAction(appId) : signOutAppAction(appId));
      window.location.assign(`/a/${appId}`);
    });
  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        disabled={pending}
        onClick={() => leave(false)}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-faint hover:text-ink disabled:opacity-50"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden /> Cerrar sesión
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={() => leave(true)}
        className="text-micro text-ink-faint hover:text-ink disabled:opacity-50"
      >
        Cerrar todas mis sesiones
      </button>
    </div>
  );
}
