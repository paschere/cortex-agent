'use client';

import {
  acceptLocationAction,
  endShiftAction,
  locationStatusAction,
  pingLocationAction,
  revokeLocationAction,
  startShiftAction,
} from '@/lib/apps/location-actions';
import type { LocationStatus } from '@cortex/agent-tools';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { Loader2, MapPin, MapPinOff, ShieldCheck, X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react';

/**
 * COMPARTIR MI UBICACIÓN CON EL EQUIPO (0216), DEL LADO DE LA PERSONA.
 *
 * Todo lo que prometimos en el texto de consentimiento se cumple aquí y se
 * vuelve a comprobar en el servidor:
 *
 *   - SIN CONSENTIMIENTO NO SE PIDE EL GPS. `navigator.geolocation` sólo se toca
 *     cuando la persona aceptó el texto vigente Y tiene el turno abierto; el
 *     efecto que lo pide depende de eso y de nada más.
 *   - SÓLO CON LA APP ABIERTA. Si la pestaña se oculta, se deja de pedir; al
 *     volver, se retoma.
 *   - SE VE QUE SE COMPARTE. Mientras el turno está abierto hay un aviso fijo
 *     «Compartiendo ubicación» (honesto: si el GPS no responde o el navegador
 *     negó el permiso, dice eso y no «compartiendo»).
 *   - SE APAGA CUANDO QUIERA. «Terminar turno» en el aviso y en el menú, y
 *     «Dejar de compartir mi ubicación» retira la autorización y borra lo
 *     guardado.
 *
 * `LocationProvider` vive arriba del marco de la app (no se desmonta al abrir
 * o cerrar el menú); `LocationMenu` es el control que va en el menú.
 */

const PING_EVERY_MS = 20_000;

type Geo = 'idle' | 'waiting' | 'live' | 'denied' | 'unavailable';

interface LocationCtx {
  status: LocationStatus;
  geo: Geo;
  busy: boolean;
  error: string | null;
  startShift(): void;
  endShift(): void;
  revoke(): void;
  showText(): void;
}

const Ctx = createContext<LocationCtx | null>(null);

function useLocationCtx(): LocationCtx | null {
  return useContext(Ctx);
}

export function LocationProvider({
  appId,
  initial,
  children,
}: {
  appId: string;
  initial: LocationStatus | null;
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<LocationStatus | null>(initial);
  const [geo, setGeo] = useState<Geo>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();
  const [consentOpen, setConsentOpen] = useState<null | 'start' | 'read'>(null);
  const lastOkAt = useRef(0);

  const sharing = Boolean(status?.enabled && status.canShare && status.consented && status.onShift);

  const refresh = useCallback(async () => {
    const res = await locationStatusAction(appId);
    if (res.ok) setStatus(res.status);
  }, [appId]);

  // El GPS: sólo con consentimiento vigente y turno abierto, y sólo con la app a la vista.
  useEffect(() => {
    if (!sharing) {
      setGeo('idle');
      return;
    }
    if (!('geolocation' in navigator)) {
      setGeo('unavailable');
      return;
    }
    let stopped = false;
    let battery: number | null = null;
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{ level: number }>;
    };
    nav.getBattery?.().then(
      (b) => {
        battery = Math.round(b.level * 100);
      },
      () => {},
    );
    const ping = () => {
      if (stopped || document.visibilityState !== 'visible') return;
      setGeo((g) => (g === 'live' ? g : 'waiting'));
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          if (stopped) return;
          const c = pos.coords;
          const res = await pingLocationAction(appId, {
            lat: c.latitude,
            lng: c.longitude,
            accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
            heading: c.heading !== null && Number.isFinite(c.heading) ? c.heading : null,
            speed: c.speed !== null && Number.isFinite(c.speed) ? c.speed : null,
            battery,
          });
          if (stopped) return;
          if (res.ok && (res.saved || res.reason === 'rate')) {
            lastOkAt.current = Date.now();
            setGeo('live');
            setError(null);
          } else if (res.ok && res.reason === 'inactive') {
            // El servidor ya no te tiene en turno (se apagó la función, cambió el texto…): lee el estado.
            await refresh();
          } else if (!res.ok) setError(res.error);
        },
        (err) => {
          if (stopped) return;
          if (err.code === err.PERMISSION_DENIED) {
            setGeo('denied');
            clearInterval(timer);
          } else setGeo('waiting');
        },
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 },
      );
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') ping();
    };
    const timer = setInterval(ping, PING_EVERY_MS);
    ping();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [sharing, appId, refresh]);

  const run = useCallback(
    (work: () => Promise<{ ok: true; status: LocationStatus } | { ok: false; error: string }>) => {
      setError(null);
      startTransition(async () => {
        const res = await work();
        if (res.ok) setStatus(res.status);
        else setError(res.error);
      });
    },
    [],
  );

  const ctx = useMemo<LocationCtx | null>(() => {
    if (!status?.enabled || !status.canShare) return null;
    return {
      status,
      geo,
      busy,
      error,
      startShift: () => {
        if (!status.consented) setConsentOpen('start');
        else run(() => startShiftAction(appId));
      },
      endShift: () => run(() => endShiftAction(appId)),
      revoke: () => {
        if (
          window.confirm(
            '¿Dejar de compartir tu ubicación? Se borran tu posición y tu rastro guardados, y tendrás que aceptar de nuevo para volver a compartir.',
          )
        )
          run(() => revokeLocationAction(appId));
      },
      showText: () => setConsentOpen('read'),
    };
  }, [status, geo, busy, error, run, appId]);

  async function accept() {
    setError(null);
    const res = await acceptLocationAction(appId);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setStatus(res.status);
    if (consentOpen === 'start') {
      const started = await startShiftAction(appId);
      if (started.ok) setStatus(started.status);
      else setError(started.error);
    }
    setConsentOpen(null);
  }

  return (
    <Ctx.Provider value={ctx}>
      {children}
      {ctx && sharing && <SharingBadge />}
      {status && (
        <ConsentDialog
          status={status}
          mode={consentOpen}
          onClose={() => setConsentOpen(null)}
          onAccept={accept}
        />
      )}
    </Ctx.Provider>
  );
}

const GEO_TEXT: Record<Geo, string> = {
  idle: 'Compartiendo ubicación',
  waiting: 'Compartiendo ubicación · buscando señal del GPS…',
  live: 'Compartiendo ubicación',
  denied: 'Sin permiso del navegador: no se está compartiendo',
  unavailable: 'Este teléfono no da la ubicación: no se está compartiendo',
};

/** El aviso fijo: se ve en todas las pantallas mientras haya turno abierto. */
function SharingBadge() {
  const ctx = useLocationCtx();
  if (!ctx) return null;
  const ok = ctx.geo === 'live' || ctx.geo === 'idle' || ctx.geo === 'waiting';
  return (
    <output
      aria-live="polite"
      className="view-no-print block fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-3 z-40 max-w-[calc(100vw-1.5rem)] md:hidden"
    >
      <div
        className={clsx(
          'flex items-center gap-2 rounded-pill border py-1.5 pl-3 pr-1.5 text-xs font-semibold shadow-pop',
          ok ? 'border-emerald/40 bg-surface text-ink' : 'border-rose/40 bg-rose-soft text-rose',
        )}
      >
        <span aria-hidden className="relative grid h-2.5 w-2.5 place-items-center">
          {ok && ctx.geo === 'live' && (
            <span className="absolute h-2.5 w-2.5 animate-ping rounded-pill bg-emerald/60" />
          )}
          <span className={clsx('h-2 w-2 rounded-pill', ok ? 'bg-emerald' : 'bg-rose')} />
        </span>
        <span className="min-w-0 truncate">{GEO_TEXT[ctx.geo]}</span>
        <button
          type="button"
          onClick={ctx.endShift}
          disabled={ctx.busy}
          className="shrink-0 rounded-pill bg-surface-2 px-2.5 py-1 text-micro font-bold text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
        >
          Terminar turno
        </button>
      </div>
    </output>
  );
}

const SHIFT_TIME = new Intl.DateTimeFormat('es-CO', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: 'America/Bogota',
});

/** El control del menú de la app: iniciar y terminar turno, qué se comparte y dejar de compartir. */
export function LocationMenu() {
  const ctx = useLocationCtx();
  if (!ctx) return null;
  const { status } = ctx;
  return (
    <section
      aria-label="Ubicación"
      className="w-full rounded-card border border-border bg-surface-2/50 p-3"
    >
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-bold text-ink">
        {status.onShift ? (
          <MapPin className="h-3.5 w-3.5 text-emerald" aria-hidden />
        ) : (
          <MapPinOff className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
        )}
        {status.onShift ? 'En turno · compartiendo ubicación' : 'Mi ubicación'}
      </p>
      {status.onShift ? (
        <>
          {status.shiftSince && (
            <p className="mb-2 text-micro text-ink-muted">
              Desde las {SHIFT_TIME.format(new Date(status.shiftSince))}. El equipo te ve mientras
              esta app esté abierta.
            </p>
          )}
          <button
            type="button"
            onClick={ctx.endShift}
            disabled={ctx.busy}
            className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3 text-sm font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-50"
          >
            {ctx.busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Terminar turno
          </button>
        </>
      ) : (
        <>
          <p className="mb-2 text-micro text-ink-muted">
            {status.consentOutdated
              ? 'Cambió el texto de lo que se comparte: léelo y acéptalo de nuevo para seguir.'
              : 'Si inicias turno, el equipo ve dónde estás mientras la app esté abierta.'}
          </p>
          <button
            type="button"
            onClick={ctx.startShift}
            disabled={ctx.busy}
            className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-pill bg-primary px-3 text-sm font-semibold text-white disabled:opacity-50"
          >
            {ctx.busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            Iniciar turno
          </button>
        </>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={ctx.showText}
          className="text-micro font-semibold text-ink-muted underline-offset-2 hover:text-ink hover:underline"
        >
          Qué se comparte
        </button>
        {status.consented && (
          <button
            type="button"
            onClick={ctx.revoke}
            disabled={ctx.busy}
            className="text-micro font-semibold text-rose underline-offset-2 hover:underline disabled:opacity-50"
          >
            Dejar de compartir mi ubicación
          </button>
        )}
      </div>
      {ctx.error && (
        <p className="mt-2 rounded-sm bg-rose-soft px-2.5 py-1.5 text-micro text-rose" role="alert">
          {ctx.error}
        </p>
      )}
    </section>
  );
}

function ConsentDialog({
  status,
  mode,
  onClose,
  onAccept,
}: {
  status: LocationStatus;
  mode: null | 'start' | 'read';
  onClose: () => void;
  onAccept: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const text = status.text;
  const needsAccept = mode === 'start' || (mode === 'read' && !status.consented);
  return (
    <Dialog.Root open={mode !== null} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] animate-veil bg-canvas/70 backdrop-blur-[2px]" />
        <Dialog.Content
          className={clsx(
            'cortex-workspace fixed z-[61] flex max-h-[90dvh] flex-col overflow-hidden border border-border bg-surface shadow-pop outline-none animate-veil',
            'inset-x-0 bottom-0 rounded-t-card',
            'sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-[min(32rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-card',
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-primary-soft text-primary-ink">
                <ShieldCheck className="h-4.5 w-4.5" aria-hidden />
              </span>
              <div className="min-w-0">
                <Dialog.Title className="text-base font-bold text-ink">{text.title}</Dialog.Title>
                <Dialog.Description className="text-micro text-ink-faint">
                  Léelo con calma. Compartir es voluntario y lo apagas cuando quieras.
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink"
            >
              <X className="h-4 w-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="scroll-slim min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
            {text.points.map((p) => (
              <div key={p.title}>
                <h3 className="text-sm font-bold text-ink">{p.title}</h3>
                <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">{p.body}</p>
              </div>
            ))}
            <p className="border-t border-border pt-3 text-micro leading-relaxed text-ink-faint">
              {text.footer}
            </p>
          </div>
          <div className="flex flex-col-reverse gap-2 border-t border-border px-5 py-3 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={onClose}
              className="min-h-11 rounded-pill border border-border px-4 text-sm font-semibold text-ink-muted hover:text-ink"
            >
              {needsAccept ? 'Ahora no' : 'Cerrar'}
            </button>
            {needsAccept && (
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await onAccept();
                  setBusy(false);
                }}
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-pill bg-primary px-4 text-sm font-semibold text-white disabled:opacity-50"
              >
                {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                {mode === 'start' ? 'Acepto: iniciar turno' : 'Acepto compartir mi ubicación'}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
