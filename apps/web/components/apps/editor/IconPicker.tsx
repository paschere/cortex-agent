'use client';

import { Glyph } from '@/components/apps/AppGlyph';
import { APP_ICON_NAMES } from '@cortex/agent-tools/src/apps/icon-names';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { useState } from 'react';

/**
 * Selector de icono: una cuadrícula con los iconos de la app dibujados (no
 * nombres). Con `emoji` también deja escribir un emoji propio.
 */
export function IconPicker({
  value,
  onChange,
  emoji = false,
  label,
  children,
  align = 'start',
}: {
  value: string;
  onChange: (next: string) => void;
  emoji?: boolean;
  label: string;
  children: React.ReactNode;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button type="button" aria-label={label} className="rounded-lg outline-none">
          {children}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-[min(19rem,calc(100vw-24px))] rounded-card border border-border bg-surface p-3 shadow-pop"
        >
          <p className="mb-2 text-micro font-semibold text-ink-muted">Elige un icono</p>
          <div className="grid max-h-60 grid-cols-6 gap-1 overflow-y-auto">
            {APP_ICON_NAMES.map((n) => (
              <DropdownMenu.Item
                key={n}
                aria-label={n}
                onSelect={() => onChange(n)}
                className={clsx(
                  'grid h-10 w-10 cursor-pointer place-items-center rounded-lg text-ink-muted outline-none transition-colors data-[highlighted]:bg-primary-soft data-[highlighted]:text-primary-ink',
                  value === n && 'bg-primary-soft text-primary-ink',
                )}
              >
                <Glyph name={n} className="h-5 w-5" />
              </DropdownMenu.Item>
            ))}
          </div>
          {emoji && (
            <label className="mt-3 flex items-center gap-2 border-t border-border pt-3">
              <span className="text-micro font-semibold text-ink-muted">O un emoji</span>
              <input
                defaultValue=""
                maxLength={8}
                placeholder="🚚"
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = e.currentTarget.value.trim();
                    if (v) {
                      onChange(v);
                      setOpen(false);
                    }
                  }
                }}
                className="h-8 w-16 rounded-pill border border-border bg-surface px-3 text-center text-sm text-ink outline-none focus:border-primary"
              />
            </label>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
