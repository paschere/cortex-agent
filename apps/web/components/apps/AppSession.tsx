'use client';

import { signOutAppAction, signOutEverywhereAction } from '@/lib/apps/external-actions';
import { changeMyPinAction, enrollThisDeviceAction } from '@/lib/apps/kiosk-actions';
import { agoLabel, precacheUrlsOf } from '@/lib/apps/offline-cache';
import { Download, KeyRound, LogOut, Share, Smartphone, WifiOff } from 'lucide-react';
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
export function AppWorker({
  appId,
  userKey,
  homeSlug = null,
}: {
  appId: string;
  userKey: string;
  /** La pantalla de inicio de quien está dentro: se precachea al instalar (sin mezclar usuarios). */
  homeSlug?: string | null;
}) {
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
        precache: precacheUrlsOf(appId, homeSlug),
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
  }, [appId, userKey, pathname, homeSlug]);
  // Al terminar de instalarse se vuelve a avisar: es cuando la primera pantalla debe quedar guardada.
  useEffect(() => {
    const onInstalled = () => {
      const target = navigator.serviceWorker?.controller;
      target?.postMessage({
        type: 'who',
        userKey,
        url: `${window.location.pathname}${window.location.search}`,
        precache: precacheUrlsOf(appId, homeSlug),
      });
    };
    window.addEventListener('appinstalled', onInstalled);
    return () => window.removeEventListener('appinstalled', onInstalled);
  }, [appId, userKey, homeSlug]);
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
export function SignOutMenu({ appId, kiosk = false }: { appId: string; kiosk?: boolean }) {
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
        <LogOut className="h-3.5 w-3.5" aria-hidden />{' '}
        {kiosk ? 'Cambiar de persona' : 'Cerrar sesión'}
      </button>
      {!kiosk && (
        <button
          type="button"
          disabled={pending}
          onClick={() => leave(true)}
          className="text-micro text-ink-faint hover:text-ink disabled:opacity-50"
        >
          Cerrar todas mis sesiones
        </button>
      )}
    </div>
  );
}

/**
 * SESIÓN DE KIOSCO: se cierra sola tras N minutos sin tocar la pantalla. El
 * servidor ya lo exige por su lado (la sesión vence a los N minutos sin
 * peticiones); esto es lo que lo hace visible al instante y cuenta el uso de
 * verdad (tocar, escribir, mover), no sólo el refresco en vivo de fondo.
 */
export function KioskIdleGuard({ appId, idleMinutes }: { appId: string; idleMinutes: number }) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closing = false;
    const limit = Math.max(1, idleMinutes) * 60_000;
    const close = async () => {
      if (closing) return;
      closing = true;
      navigator.serviceWorker?.controller?.postMessage({ type: 'signout' });
      await signOutAppAction(appId).catch(() => null);
      window.location.assign(`/a/${appId}`);
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(close, limit);
    };
    const events = ['pointerdown', 'keydown', 'touchstart', 'scroll', 'input'] as const;
    for (const e of events) window.addEventListener(e, arm, { passive: true });
    // Si el celular estuvo bloqueado (los timers se congelan), al volver se mira el reloj.
    let last = Date.now();
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - last >= limit) void close();
    };
    const tick = setInterval(() => {
      last = Date.now();
    }, 5_000);
    document.addEventListener('visibilitychange', onVisible);
    arm();
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(tick);
      for (const e of events) window.removeEventListener(e, arm);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [appId, idleMinutes]);
  return null;
}

/**
 * Lo de PIN y kiosco dentro de la app: «Mi PIN» (ponerlo o cambiarlo) para quien
 * trabaja con PIN, y «Dejar este celular en modo kiosco» para el rol con el
 * permiso. En un kiosco el cambio pide el PIN actual.
 */
export function KioskMenu({
  appId,
  kiosk,
  canEnroll,
  enabled,
}: {
  appId: string;
  /** Sesión de kiosco: el cambio de PIN pide el actual. */
  kiosk: boolean;
  canEnroll: boolean;
  /** El kiosco de la app está encendido (si no, ni «Mi PIN» ni nada de esto sale). */
  enabled: boolean;
}) {
  const [open, setOpen] = useState<null | 'pin' | 'device'>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const field =
    'w-full rounded-sm border border-border-strong bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-primary';
  if (!enabled) return null;
  return (
    <div className="flex flex-col items-start gap-1.5">
      <button
        type="button"
        onClick={() => {
          setOpen(open === 'pin' ? null : 'pin');
          setMsg(null);
        }}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-faint hover:text-ink"
      >
        <KeyRound className="h-3.5 w-3.5" aria-hidden /> Mi PIN
      </button>
      {open === 'pin' && (
        <form
          className="w-44 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setMsg(null);
            start(async () => {
              const res = await changeMyPinAction(appId, { current, next });
              if (!res.ok) return setMsg({ ok: false, text: res.error });
              setMsg({ ok: true, text: 'PIN guardado.' });
              setCurrent('');
              setNext('');
            });
          }}
        >
          {kiosk && (
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              value={current}
              onChange={(e) => setCurrent(e.target.value.replace(/\D/g, ''))}
              placeholder="PIN actual"
              aria-label="PIN actual"
              className={field}
            />
          )}
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={next}
            onChange={(e) => setNext(e.target.value.replace(/\D/g, ''))}
            placeholder="PIN nuevo (4 a 6 números)"
            aria-label="PIN nuevo"
            className={field}
          />
          <button
            type="submit"
            disabled={pending || next.length < 4}
            className="text-xs font-semibold text-primary hover:underline disabled:opacity-50"
          >
            Guardar PIN
          </button>
        </form>
      )}
      {canEnroll && !kiosk && (
        <>
          <button
            type="button"
            onClick={() => {
              setOpen(open === 'device' ? null : 'device');
              setMsg(null);
            }}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-faint hover:text-ink"
          >
            <Smartphone className="h-3.5 w-3.5" aria-hidden /> Dejar este celular en modo kiosco
          </button>
          {open === 'device' && (
            <form
              className="w-44 space-y-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                setMsg(null);
                start(async () => {
                  const res = await enrollThisDeviceAction(appId, name);
                  if (!res.ok) return setMsg({ ok: false, text: res.error });
                  window.location.assign(`/a/${appId}`);
                });
              }}
            >
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="Nombre (ej. Muelle 3)"
                aria-label="Nombre del dispositivo"
                className={field}
              />
              <p className="text-micro leading-snug text-ink-muted">
                Se cierra tu sesión y el celular queda pidiendo PIN.
              </p>
              <button
                type="submit"
                disabled={pending || !name.trim()}
                className="text-xs font-semibold text-primary hover:underline disabled:opacity-50"
              >
                Dejarlo en modo kiosco
              </button>
            </form>
          )}
        </>
      )}
      {msg && (
        <output
          className={`block max-w-[11rem] text-micro ${msg.ok ? 'text-emerald' : 'text-rose'}`}
        >
          {msg.text}
        </output>
      )}
    </div>
  );
}
