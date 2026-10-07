'use client';

import {
  clearUserPinAction,
  createKioskPairingAction,
  revokeKioskDeviceAction,
  setKioskSettingsAction,
  setUserPinAction,
} from '@/lib/apps/kiosk-admin-actions';
import { clsx } from 'clsx';
import { Copy, KeyRound, Smartphone, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  type EditorAppUser,
  type EditorKiosk,
  ErrorLine,
  INPUT,
} from './shared';

/**
 * «Dispositivos de planta» (modo kiosco, fase 4): un celular compartido que
 * queda ligado a la app y al que cada operario entra con su PIN. Aquí se
 * enciende, se fijan los minutos sin uso, se agregan celulares con un enlace de
 * un solo uso y se revocan. El PIN de cada persona se asigna en su fila
 * (`PinControl`).
 */

const STATE: Record<EditorKiosk['devices'][number]['state'], { label: string; cls: string }> = {
  active: { label: 'Activo', cls: 'bg-emerald-soft text-emerald' },
  pending: { label: 'Esperando el celular', cls: 'bg-amber-soft text-amber' },
  revoked: { label: 'Revocado', cls: 'bg-surface-2 text-ink-muted' },
};

function when(iso: string | null): string {
  if (!iso) return 'Sin uso todavía';
  return `Visto ${new Intl.DateTimeFormat('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'America/Bogota',
  }).format(new Date(iso))}`;
}

export function KioskPanel({ appId, kiosk }: { appId: string; kiosk: EditorKiosk }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [minutes, setMinutes] = useState(String(kiosk.idleMinutes));
  const [name, setName] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const run = (task: () => Promise<{ ok: boolean; error?: string }>) => {
    setError(null);
    start(async () => {
      const res = await task();
      if (!res.ok) return setError(res.error ?? 'No se pudo.');
      router.refresh();
    });
  };

  return (
    <section className={clsx(CARD, 'space-y-4')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-xl">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-ink">
            <Smartphone className="h-4 w-4" aria-hidden /> Dispositivos de planta (modo kiosco)
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            Para un celular que usan varias personas: queda ligado a esta app y cada operario toca
            su nombre y escribe su PIN. Lo que registra queda a su nombre y su sesión se cierra sola
            tras unos minutos sin uso. El PIN sólo funciona en estos celulares.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-semibold text-ink">
          <input
            type="checkbox"
            checked={kiosk.enabled}
            disabled={pending}
            onChange={(e) =>
              run(() => setKioskSettingsAction(appId, { enabled: e.target.checked }))
            }
          />
          {kiosk.enabled ? 'Modo kiosco activo' : 'Activar modo kiosco'}
        </label>
      </div>
      <ErrorLine error={error} />

      {kiosk.enabled && (
        <>
          <div className="flex flex-wrap items-end gap-2">
            <label>
              <span className="mb-1 block text-micro font-semibold text-ink-muted">
                Minutos sin uso para cerrar la sesión
              </span>
              <input
                type="number"
                min={1}
                max={120}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                className={clsx(INPUT, 'w-24')}
              />
            </label>
            <button
              type="button"
              disabled={pending || Number(minutes) === kiosk.idleMinutes}
              onClick={() =>
                run(() => setKioskSettingsAction(appId, { idleMinutes: Number(minutes) }))
              }
              className={BTN_SECONDARY}
            >
              Guardar
            </button>
          </div>

          {kiosk.devices.length > 0 && (
            <ul className="space-y-2">
              {kiosk.devices.map((d) => (
                <li
                  key={d.id}
                  className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface p-3"
                >
                  <div className="min-w-0 flex-1 basis-40">
                    <p className="truncate text-sm font-semibold text-ink">{d.name}</p>
                    <p className="text-micro text-ink-faint">{when(d.lastSeenAt)}</p>
                  </div>
                  <span
                    className={clsx(
                      'rounded-pill px-2.5 py-1 text-micro font-semibold',
                      STATE[d.state].cls,
                    )}
                  >
                    {STATE[d.state].label}
                  </span>
                  {d.state !== 'revoked' && (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `¿Revocar «${d.name}»? El celular deja de ser kiosco y se cierran las sesiones abiertas en él.`,
                          )
                        )
                          run(() => revokeKioskDeviceAction(appId, d.id));
                      }}
                      className={BTN_DANGER}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden /> Revocar
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              setLink(null);
              start(async () => {
                const res = await createKioskPairingAction(appId, name);
                if (!res.ok) return setError(res.error);
                setLink(`${window.location.origin}${res.path}`);
                setName('');
                router.refresh();
              });
            }}
          >
            <label className="min-w-0 flex-1 basis-48">
              <span className="mb-1 block text-micro font-semibold text-ink-muted">
                Agregar un celular
              </span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="Nombre del celular (ej. Muelle 3)"
                className={clsx(INPUT, 'w-full')}
              />
            </label>
            <button type="submit" disabled={pending || !name.trim()} className={BTN_PRIMARY}>
              Crear enlace
            </button>
          </form>
          {link && (
            <div className="space-y-1.5 rounded-card bg-primary-soft p-3">
              <p className="text-xs text-ink">
                Abre este enlace en el celular de planta y toca «Dejar este celular en modo kiosco».
                Sirve una vez y vence en 15 minutos.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="max-w-full break-all rounded-sm bg-surface px-2 py-1 text-micro text-ink-muted">
                  {link}
                </code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(link);
                    setCopied(true);
                  }}
                  className={BTN_SECONDARY}
                >
                  <Copy className="h-3.5 w-3.5" aria-hidden /> {copied ? 'Copiado' : 'Copiar'}
                </button>
              </div>
            </div>
          )}
          <p className="text-micro text-ink-faint">
            También puede dejar un celular en modo kiosco el rol que tenga marcada «Deja celulares
            en kiosco» (por ejemplo el supervisor), desde el menú de la app.
          </p>
        </>
      )}
    </section>
  );
}

/** El PIN de una persona: asignarlo o reiniciarlo (también la destraba), o quitarlo. */
export function PinControl({
  appId,
  user,
  busy,
}: {
  appId: string;
  user: EditorAppUser;
  busy: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const locked = user.pinLockedUntil && new Date(user.pinLockedUntil).getTime() > Date.now();
  return (
    <div className="flex basis-full flex-wrap items-center gap-2 text-micro">
      <KeyRound className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
      <span className={clsx(locked ? 'font-semibold text-rose' : 'text-ink-muted')}>
        {locked ? 'PIN bloqueado por intentos fallidos' : user.hasPin ? 'Tiene PIN' : 'Sin PIN'}
      </span>
      <button
        type="button"
        disabled={busy || pending}
        onClick={() => setOpen((v) => !v)}
        className="font-semibold text-primary hover:underline disabled:opacity-50"
      >
        {user.hasPin ? 'Reiniciar PIN' : 'Asignar PIN'}
      </button>
      {user.hasPin && (
        <button
          type="button"
          disabled={busy || pending}
          onClick={() =>
            start(async () => {
              const res = await clearUserPinAction(appId, user.id);
              if (!res.ok) return setError(res.error);
              router.refresh();
            })
          }
          className="font-semibold text-ink-faint hover:text-ink disabled:opacity-50"
        >
          Quitar
        </button>
      )}
      {open && (
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            start(async () => {
              const res = await setUserPinAction(appId, user.id, pin);
              if (!res.ok) return setError(res.error);
              setPin('');
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            placeholder="4 a 6 números"
            aria-label={`PIN de ${user.name}`}
            className={clsx(INPUT, 'w-32')}
          />
          <button type="submit" disabled={pending || pin.length < 4} className={BTN_SECONDARY}>
            Guardar
          </button>
        </form>
      )}
      {error && <span className="text-rose">{error}</span>}
    </div>
  );
}
