'use client';

import { type ScopeSpace, listScopeSpacesAction } from '@/app/(chat)/chat/actions';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { Brain, Building2, Check, Loader2, Lock, X } from 'lucide-react';
import { useEffect, useState } from 'react';

/**
 * "CONTÉSTAME SÓLO CON LO DE ADUANAS."
 *
 * ===========================================================================
 * THE FAILURE THIS COMPONENT EXISTS TO PREVENT
 * ===========================================================================
 * Narrowing retrieval is the most valuable thing somebody can tell Cortex and
 * the most dangerous thing to let them forget. A person who filtered to
 * "Aduanas" on Monday and asks about a payroll deadline on Thursday reads "no
 * tengo nada sobre eso" and concludes the brain is empty — a conclusion that is
 * false, unfalsifiable from where they are sitting, and permanent. The feature
 * would then have made the product worse than not having it.
 *
 * So the filter is defended on three levels, and only the first one is this
 * file:
 *
 *   1. IT IS NEVER BEHIND A MENU. While a filter is on, `ScopeStrip` sits above
 *      the textarea on every single turn, in amber, saying which spaces in
 *      words. It cannot be collapsed. It is not a dot on an icon.
 *   2. THE MODEL IS TOLD. /api/chat puts the space names in a `<memory-scope>`
 *      block and instructs the answer to say "busqué sólo en X" instead of "la
 *      empresa no tiene nada". That is the sentence the person actually reads.
 *   3. IT DIES WITH THE CONVERSATION. The scope is stored per conversation
 *      (`turn_context_settings.space_ids`), so a new chat is a full reset that
 *      needs no undo — the argument in turn-context/settings.ts, unchanged.
 *
 * WHY AMBER AND NOT PRIMARY. Indigo is already the composer's own colour — the
 * focus ring, the agent pill, the highlighted row of the `/` menu. A strip in
 * primary would be read as chrome within a week. Amber is used nowhere else
 * here and means what this is: attention, not alarm. Rose is reserved for the
 * irreversible, and this is one click to undo.
 *
 * ===========================================================================
 * WHY ONLY SPACES ARE SELECTABLE
 * ===========================================================================
 * Because the ceiling that already exists is a ceiling of spaces:
 * `ToolContext.kbSpaceIds`, which `kb_search_scoped` intersects with what the
 * person can see. A client or a single document would need a second narrowing
 * path through the same SQL function, and a second path is how the two drift.
 * "Sólo los contratos de este cliente" is asked today with `@Coltrans`, which
 * narrows the QUESTION; this narrows the SEARCH. They are different controls
 * and it is better that they look different.
 */

/** The strip that makes a filter impossible to forget. Renders nothing when off. */
export function ScopeStrip({
  selected,
  onRemove,
  onClear,
  disabled,
}: {
  selected: ScopeSpace[];
  onRemove: (id: string) => void;
  onClear: () => void;
  disabled?: boolean;
}) {
  if (selected.length === 0) return null;

  return (
    <div
      // Announced, not just drawn: somebody on a screen reader has no amber.
      role="status"
      aria-live="polite"
      className="animate-rise mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-card border border-amber/25 bg-amber-soft px-3 py-2"
    >
      <Brain className="h-3.5 w-3.5 shrink-0 text-amber" aria-hidden />
      <span className="text-[12px] font-semibold text-amber">Contestando sólo con</span>

      <ul className="flex min-w-0 flex-wrap items-center gap-1">
        {selected.map((space) => (
          <li key={space.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRemove(space.id)}
              aria-label={`Dejar de buscar sólo en ${space.name}`}
              className="group inline-flex max-w-[14rem] items-center gap-1 rounded-pill border border-amber/30 bg-surface px-2 py-0.5 text-[12px] font-medium text-ink transition-colors duration-150 hover:border-amber hover:bg-amber/10 disabled:opacity-50 motion-reduce:transition-none"
            >
              <span className="truncate">{space.name}</span>
              <X className="h-3 w-3 shrink-0 text-ink-faint group-hover:text-amber" aria-hidden />
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        disabled={disabled}
        onClick={onClear}
        className="ml-auto shrink-0 rounded-pill px-2 py-0.5 text-[12px] font-semibold text-amber underline decoration-amber/40 underline-offset-2 transition-colors duration-150 hover:decoration-amber disabled:opacity-50 motion-reduce:transition-none"
      >
        Buscar en todo
      </button>
    </div>
  );
}

/** The composer button that opens the picker. */
export function ScopePicker({
  selected,
  onChange,
  disabled,
}: {
  selected: ScopeSpace[];
  onChange: (next: ScopeSpace[]) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [spaces, setSpaces] = useState<ScopeSpace[] | null>(null);

  // Fetched the first time somebody opens it, never on page load: most turns
  // never touch this, and a chat that costs one extra query per visit to draw a
  // menu nobody opened is a chat that got slower for nothing.
  useEffect(() => {
    if (!open || spaces) return;
    let alive = true;
    void listScopeSpacesAction().then((rows) => {
      if (alive) setSpaces(rows);
    });
    return () => {
      alive = false;
    };
  }, [open, spaces]);

  const selectedIds = new Set(selected.map((s) => s.id));
  const active = selected.length > 0;

  function toggle(space: ScopeSpace) {
    onChange(
      selectedIds.has(space.id) ? selected.filter((s) => s.id !== space.id) : [...selected, space],
    );
  }

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={
            active
              ? `Memoria: buscando sólo en ${selected.map((s) => s.name).join(', ')}`
              : 'Elegir de qué memoria contesta Cortex'
          }
          title="De qué memoria contesta"
          className={clsx(
            'grid h-8 w-8 place-items-center rounded-full transition-colors duration-150 disabled:opacity-40 motion-reduce:transition-none',
            active
              ? 'bg-amber-soft text-amber ring-1 ring-inset ring-amber/30'
              : 'text-ink-faint hover:bg-surface-2 hover:text-ink',
          )}
        >
          <Brain className="h-4 w-4" aria-hidden />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={8}
          className="scroll-slim z-50 max-h-72 w-[19rem] overflow-y-auto rounded-card border border-border bg-surface p-1.5 shadow-pop"
        >
          <DropdownMenu.Label className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold leading-snug text-ink-faint">
            Cortex busca en todo lo que puedes ver. Acótalo cuando quieras una respuesta de una sola
            parte del cerebro.
          </DropdownMenu.Label>

          <DropdownMenu.Item
            onSelect={() => onChange([])}
            className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-[13px] outline-none transition-colors duration-150 data-[highlighted]:bg-primary-soft motion-reduce:transition-none"
          >
            <span className="grid h-4 w-4 shrink-0 place-items-center">
              {!active && <Check className="h-3.5 w-3.5 text-primary" aria-hidden />}
            </span>
            <span className={clsx('font-medium', active ? 'text-ink-muted' : 'text-ink')}>
              Todo lo que puedes ver
            </span>
          </DropdownMenu.Item>

          <div className="my-1 h-px bg-border" aria-hidden />

          {spaces === null && (
            <div className="flex items-center gap-2 px-2.5 py-3 text-[12.5px] text-ink-faint">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Buscando tus espacios…
            </div>
          )}

          {spaces !== null && spaces.length === 0 && (
            <p className="px-2.5 py-3 text-[12.5px] leading-snug text-ink-faint">
              Todavía no hay espacios en Brain Knowledge. Sube un documento y aparecerán aquí.
            </p>
          )}

          {(spaces ?? []).map((space) => {
            const on = selectedIds.has(space.id);
            const Icon = space.kind === 'personal' ? Lock : Building2;
            return (
              <DropdownMenu.CheckboxItem
                key={space.id}
                checked={on}
                // The menu stays open: choosing two spaces is one gesture, not
                // two round-trips through a button.
                onSelect={(e) => {
                  e.preventDefault();
                  toggle(space);
                }}
                className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-[13px] outline-none transition-colors duration-150 data-[highlighted]:bg-primary-soft motion-reduce:transition-none"
              >
                <span className="grid h-4 w-4 shrink-0 place-items-center">
                  {on && <Check className="h-3.5 w-3.5 text-primary" aria-hidden />}
                </span>
                <Icon className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium text-ink">{space.name}</span>
                <span className="shrink-0 text-[11px] text-ink-faint">
                  {space.kind === 'personal' ? 'tuyo' : 'la empresa'}
                </span>
              </DropdownMenu.CheckboxItem>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
