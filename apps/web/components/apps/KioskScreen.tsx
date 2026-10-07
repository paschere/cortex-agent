'use client';

import { pinLoginAction } from '@/lib/apps/kiosk-actions';
import { Delete, Loader2, Smartphone, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';

/**
 * LA PANTALLA DE UN CELULAR EN MODO KIOSCO (0211): la lista de nombres y, al
 * tocar el suyo, un teclado de PIN. No hay correo ni código aquí: en un
 * dispositivo compartido nadie deja una sesión de 30 días abierta.
 *
 * Al montarse le dice al service worker que no hay nadie (`signout`): la copia
 * sin conexión de la persona anterior se borra antes de que entre la siguiente.
 */

const MIN = 4;
const MAX = 6;
const LONG_LIST = 12;

export function KioskScreen({
  appId,
  appName,
  deviceName,
  people,
}: {
  appId: string;
  appName: string;
  deviceName: string;
  people: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);
  const [pin, setPin] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    navigator.serviceWorker?.controller?.postMessage({ type: 'signout' });
  }, []);

  const shown = useMemo(() => {
    const q = query
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .trim();
    if (!q) return people;
    return people.filter((p) =>
      p.name
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .toLowerCase()
        .includes(q),
    );
  }, [people, query]);

  function submit(value: string) {
    if (!picked || value.length < MIN) return;
    setError(null);
    start(async () => {
      const res = await pinLoginAction(appId, picked.id, value);
      if (!res.ok) {
        setError(res.error);
        setPin('');
        return;
      }
      router.refresh();
    });
  }

  function press(digit: string) {
    if (pending || pin.length >= MAX) return;
    const next = `${pin}${digit}`;
    setPin(next);
    setError(null);
    // A los 6 se envía solo; con 4 o 5 la persona toca «Entrar».
    if (next.length === MAX) submit(next);
  }

  const key =
    'grid h-14 place-items-center rounded-card border border-border bg-surface text-xl font-semibold text-ink transition-colors active:bg-primary-soft disabled:opacity-40';

  if (!picked)
    return (
      <div className="mx-auto mt-6 max-w-sm sm:mt-12">
        <div className="mb-4 flex items-center gap-2 text-xs text-ink-muted">
          <Smartphone className="h-4 w-4" aria-hidden />
          <span>
            {appName} · {deviceName}
          </span>
        </div>
        <h1 className="text-lg font-bold text-ink">¿Quién eres?</h1>
        <p className="mt-1 text-sm text-ink-muted">Toca tu nombre y escribe tu PIN.</p>
        {people.length > LONG_LIST && (
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar mi nombre"
            aria-label="Buscar mi nombre"
            className="mt-4 w-full rounded-sm border border-border-strong bg-surface px-3 py-2.5 text-sm text-ink outline-none focus:border-primary"
          />
        )}
        {people.length === 0 ? (
          <p className="mt-6 rounded-card border border-dashed border-border-strong p-5 text-center text-sm text-ink-muted">
            Nadie tiene PIN todavía. Pídele a quien administra la app que te asigne uno.
          </p>
        ) : (
          <ul className="mt-4 grid gap-2">
            {shown.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setPicked(p);
                    setPin('');
                    setError(null);
                  }}
                  className="flex w-full items-center gap-3 rounded-card border border-border bg-surface px-4 py-3.5 text-left text-base font-semibold text-ink transition-colors active:bg-primary-soft"
                >
                  <span className="grid h-9 w-9 place-items-center rounded-full bg-primary-soft text-primary">
                    <UserRound className="h-4 w-4" aria-hidden />
                  </span>
                  {p.name}
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="text-center text-sm text-ink-muted">Nadie se llama así.</li>
            )}
          </ul>
        )}
      </div>
    );

  return (
    <div className="mx-auto mt-6 max-w-xs text-center sm:mt-12">
      <p className="text-sm text-ink-muted">Hola,</p>
      <h1 className="text-xl font-bold text-ink">{picked.name}</h1>
      <div className="mt-5 flex justify-center gap-3" aria-live="polite">
        {Array.from({ length: MAX }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: seis puntos fijos
            key={i}
            className={`h-3.5 w-3.5 rounded-full border ${
              i < pin.length ? 'border-primary bg-primary' : 'border-border-strong bg-transparent'
            }`}
          />
        ))}
      </div>
      <p className="sr-only">{pin.length} dígitos escritos</p>
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-rose">
          {error}
        </p>
      )}
      <div className="mt-5 grid grid-cols-3 gap-2.5">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" disabled={pending} onClick={() => press(d)} className={key}>
            {d}
          </button>
        ))}
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setPicked(null);
            setPin('');
            setError(null);
          }}
          className={`${key} text-sm`}
        >
          Atrás
        </button>
        <button type="button" disabled={pending} onClick={() => press('0')} className={key}>
          0
        </button>
        <button
          type="button"
          disabled={pending || pin.length === 0}
          aria-label="Borrar"
          onClick={() => setPin(pin.slice(0, -1))}
          className={key}
        >
          <Delete className="h-5 w-5" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        disabled={pending || pin.length < MIN}
        onClick={() => submit(pin)}
        className="cortex-primary-button mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-pill bg-primary px-4 py-3 text-sm font-semibold text-white transition-all duration-150 hover:bg-primary-strong disabled:opacity-45"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Entrar
      </button>
    </div>
  );
}
