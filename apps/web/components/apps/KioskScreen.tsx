'use client';

import { pinLoginAction } from '@/lib/apps/kiosk-actions';
import { ChevronRight, Delete, Loader2, Search, Smartphone } from 'lucide-react';
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

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter((w) => /^[\p{L}\p{N}]/u.test(w))
      .slice(0, 2)
      .map((w) => w.charAt(0).toLocaleUpperCase('es-CO'))
      .join('') || '·'
  );
}

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
  // Cada error cambia la llave de los puntos para que vuelvan a sacudirse.
  const [shake, setShake] = useState(0);

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
        setShake((n) => n + 1);
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
    'app-press grid h-[4.5rem] w-[4.5rem] place-items-center justify-self-center rounded-pill border border-border bg-surface text-2xl font-semibold text-ink shadow-card active:bg-primary-soft disabled:opacity-40';

  if (!picked)
    return (
      <div className="mx-auto mt-2 max-w-sm sm:mt-10">
        <div className="app-hero rounded-[1.75rem] border border-border p-5 shadow-card">
          <p className="inline-flex items-center gap-2 rounded-pill bg-surface/80 px-3 py-1 text-micro font-semibold text-ink-muted ring-1 ring-border">
            <Smartphone className="h-3.5 w-3.5" aria-hidden />
            {deviceName}
          </p>
          <h1 className="mt-3 text-xl font-extrabold leading-tight tracking-tight text-ink">
            ¿Quién eres?
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Toca tu nombre en {appName} y escribe tu PIN.
          </p>
        </div>
        {people.length > LONG_LIST && (
          <label className="mt-4 flex min-h-12 items-center gap-2 rounded-pill border border-border-strong bg-surface px-4 focus-within:border-primary">
            <Search className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar mi nombre"
              aria-label="Buscar mi nombre"
              className="min-w-0 flex-1 bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
            />
          </label>
        )}
        {people.length === 0 ? (
          <p className="mt-6 rounded-card border border-dashed border-border-strong bg-surface p-5 text-center text-sm text-ink-muted">
            Nadie tiene PIN todavía. Pídele a quien administra la app que te asigne uno.
          </p>
        ) : (
          <ul className="mt-4 grid gap-2.5">
            {shown.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => {
                    setPicked(p);
                    setPin('');
                    setError(null);
                  }}
                  className="app-press flex min-h-16 w-full items-center gap-3 rounded-card border border-border bg-surface px-4 py-3 text-left text-base font-bold text-ink shadow-card active:bg-primary-soft"
                >
                  <span
                    aria-hidden
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-pill bg-primary-soft text-sm font-extrabold text-primary-ink ring-1 ring-primary/20"
                  >
                    {initialsOf(p.name)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  <ChevronRight className="h-5 w-5 shrink-0 text-ink-faint" aria-hidden />
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
    <div className="mx-auto mt-2 max-w-xs text-center sm:mt-10">
      <span
        aria-hidden
        className="mx-auto grid h-16 w-16 place-items-center rounded-pill bg-primary-soft text-xl font-extrabold text-primary-ink shadow-card ring-1 ring-primary/20"
      >
        {initialsOf(picked.name)}
      </span>
      <p className="mt-3 text-sm text-ink-muted">Hola,</p>
      <h1 className="text-xl font-extrabold tracking-tight text-ink">{picked.name}</h1>
      <div
        key={shake}
        className={`mt-5 flex justify-center gap-3.5 ${shake > 0 ? 'app-shake' : ''}`}
        aria-live="polite"
      >
        {Array.from({ length: MAX }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: seis puntos fijos
            key={i}
            className={`h-4 w-4 rounded-full border-2 transition-colors ${
              i < pin.length
                ? 'app-pop border-primary bg-primary'
                : 'border-border-strong bg-transparent'
            }`}
          />
        ))}
      </div>
      <p className="sr-only">{pin.length} dígitos escritos</p>
      <div className="mt-3 min-h-9">
        {error && (
          <p
            role="alert"
            className="inline-block rounded-sm bg-rose-soft px-3 py-1.5 text-sm font-semibold text-rose"
          >
            {error}
          </p>
        )}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-y-3">
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
          className="app-press min-h-11 justify-self-center px-3 text-sm font-semibold text-ink-muted"
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
          className="app-press grid h-[4.5rem] w-[4.5rem] place-items-center justify-self-center rounded-pill text-ink-muted disabled:opacity-40"
        >
          <Delete className="h-6 w-6" aria-hidden />
        </button>
      </div>
      <button
        type="button"
        disabled={pending || pin.length < MIN}
        onClick={() => submit(pin)}
        className="app-press cortex-primary-button mt-5 inline-flex min-h-14 w-full items-center justify-center gap-2 rounded-pill bg-primary px-4 text-base font-bold text-white shadow-pop hover:bg-primary-strong disabled:opacity-45 disabled:shadow-none"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
        Entrar
      </button>
    </div>
  );
}
