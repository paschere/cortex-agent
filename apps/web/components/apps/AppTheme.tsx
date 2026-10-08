'use client';

import { APP_THEME_KEY, type AppThemeChoice, parseAppTheme } from '@/lib/apps/app-nav';
import { clsx } from 'clsx';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * CLARO, OSCURO O LO QUE DIGA EL SISTEMA, PARA UNA APP (0215).
 *
 * El espacio de trabajo parte en claro (ThemeToggle, `cortex-theme`); una app
 * en el teléfono de un operario parte en «Sistema»: si el celular está en
 * oscuro, la app también. La elección de cada persona se guarda aparte, en
 * este navegador (`cortex-app-theme`), con try/catch: sin almacenamiento vale
 * «Sistema» y nada se rompe. Al salir de la app se devuelve el tema que tenía
 * el espacio de trabajo.
 */

function apply(choice: AppThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

function read(): AppThemeChoice {
  try {
    return parseAppTheme(window.localStorage.getItem(APP_THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Aplica el tema de la app mientras está montada. No dibuja nada. */
export function AppThemeScope() {
  useEffect(() => {
    const before = document.documentElement.dataset.theme;
    apply(read());
    return () => {
      if (before === undefined) delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = before;
    };
  }, []);
  return null;
}

const OPTIONS: Array<{ value: AppThemeChoice; label: string; icon: typeof Sun }> = [
  { value: 'system', label: 'Sistema', icon: Monitor },
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Oscuro', icon: Moon },
];

export function AppThemeToggle({ className }: { className?: string }) {
  const [choice, setChoice] = useState<AppThemeChoice>('system');
  useEffect(() => setChoice(read()), []);

  function pick(next: AppThemeChoice) {
    setChoice(next);
    try {
      window.localStorage.setItem(APP_THEME_KEY, next);
    } catch {
      /* Sin almacenamiento: vale por esta visita. */
    }
    apply(next);
  }

  return (
    <fieldset
      className={clsx(
        'flex items-center gap-0.5 rounded-pill border border-border bg-canvas p-0.5',
        className,
      )}
    >
      <legend className="sr-only">Tema</legend>
      {OPTIONS.map((o) => {
        const Icon = o.icon;
        const active = o.value === choice;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => pick(o.value)}
            className={clsx(
              'flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-pill px-3 text-micro font-semibold transition-colors motion-reduce:transition-none md:min-h-8 md:gap-1 md:px-1.5',
              active
                ? 'bg-surface text-ink shadow-card ring-1 ring-border'
                : 'text-ink-faint hover:text-ink',
            )}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            {o.label}
          </button>
        );
      })}
    </fieldset>
  );
}
