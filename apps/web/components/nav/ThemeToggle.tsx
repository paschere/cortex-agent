'use client';

import { clsx } from 'clsx';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * CLARO, OSCURO O LO QUE DIGA EL SISTEMA.
 *
 * La elección vive en `localStorage` (`cortex-theme`) y se aplica como
 * `data-theme` en <html>. El script de `app/layout.tsx` hace lo mismo ANTES del
 * primer pintado — sin él, quien eligió oscuro vería un destello blanco en cada
 * carga. Este componente sólo cambia la elección y la vuelve a aplicar.
 *
 * Por defecto es CLARO, no «Sistema»: el diseño aprobado es el claro, y quien
 * quiera seguir al sistema lo dice una vez aquí. `globals.css` explica qué hace
 * cada valor con la paleta.
 */

export type ThemeChoice = 'light' | 'dark' | 'system';
export const THEME_KEY = 'cortex-theme';

interface Option {
  value: ThemeChoice;
  label: string;
  icon: typeof Sun;
}
const LIGHT: Option = { value: 'light', label: 'Claro', icon: Sun };
const OPTIONS: Option[] = [
  LIGHT,
  { value: 'dark', label: 'Oscuro', icon: Moon },
  { value: 'system', label: 'Sistema', icon: Monitor },
];

export function applyTheme(choice: ThemeChoice) {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
}

function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'dark' || stored === 'system') return stored;
  } catch {}
  return 'light';
}

/**
 * `icon`: un solo botón que rota Claro → Oscuro → Sistema (el rail lo usa al
 * lado de Ajustes). Sin `icon`: los tres a la vista, con su palabra.
 */
export function ThemeToggle({ icon = false }: { icon?: boolean }) {
  const [choice, setChoice] = useState<ThemeChoice>('light');
  useEffect(() => setChoice(readChoice()), []);

  function choose(next: ThemeChoice) {
    setChoice(next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {}
    applyTheme(next);
  }

  if (icon) {
    const index = Math.max(
      0,
      OPTIONS.findIndex((o) => o.value === choice),
    );
    const current = OPTIONS[index] ?? LIGHT;
    const next = OPTIONS[(index + 1) % OPTIONS.length] ?? LIGHT;
    const Icon = current.icon;
    return (
      <button
        type="button"
        onClick={() => choose(next.value)}
        title={`Tema: ${current.label}. Cambiar a ${next.label.toLowerCase()}`}
        aria-label={`Tema: ${current.label}. Cambiar a ${next.label.toLowerCase()}`}
        className="grid h-10 w-10 shrink-0 place-items-center rounded-pill text-rail-ink-muted transition-colors hover:bg-rail-2 hover:text-rail-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <Icon className="h-[18px] w-[18px]" strokeWidth={2} />
      </button>
    );
  }

  return (
    <fieldset className="flex items-center gap-0.5 rounded-pill border border-rail-border bg-canvas p-0.5">
      <legend className="sr-only">Tema</legend>
      {OPTIONS.map((option) => {
        const Icon = option.icon;
        const active = option.value === choice;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => choose(option.value)}
            className={clsx(
              'flex min-h-8 flex-1 items-center justify-center gap-1.5 rounded-pill px-2 text-micro font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none',
              active
                ? 'bg-surface text-rail-ink shadow-card ring-1 ring-rail-border'
                : 'text-rail-ink-faint hover:text-rail-ink',
            )}
          >
            <Icon className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            {option.label}
          </button>
        );
      })}
    </fieldset>
  );
}
