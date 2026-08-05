'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { Plus, Search, ShieldAlert, X } from 'lucide-react';
import { type BuilderTool, familyLabel } from '../_lib/playbook';

/**
 * Searchable tool picker for one step. The catalog is passed down from the
 * server page (the registry never reaches the client bundle). Amber = write
 * action, still confirmation-gated when the agent runs the step.
 */
export function ToolPicker({
  tools,
  selected,
  onChange,
}: {
  tools: BuilderTool[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const atCapacity = selected.length >= 8;

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = tools.filter(
      (t) => !q || t.id.toLowerCase().includes(q) || t.description.toLowerCase().includes(q),
    );
    const byFamily = new Map<string, BuilderTool[]>();
    for (const t of matched) {
      const list = byFamily.get(t.family);
      if (list) list.push(t);
      else byFamily.set(t.family, [t]);
    }
    return [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tools, query]);

  function toggle(id: string) {
    if (selected.includes(id)) onChange(selected.filter((s) => s !== id));
    else if (!atCapacity) onChange([...selected, id]);
  }

  const byId = useMemo(() => new Map(tools.map((t) => [t.id, t])), [tools]);

  return (
    <div className="mt-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {selected.map((id) => {
          const t = byId.get(id);
          const write = t?.requiresConfirmation ?? false;
          return (
            <span
              key={id}
              title={
                t?.description ?? 'Esta herramienta ya no existe en el registro: quítala del paso'
              }
              className={clsx(
                'inline-flex items-center gap-1 rounded-pill border px-1.5 py-0.5 font-mono text-[10.5px] font-semibold',
                write
                  ? 'border-amber/40 bg-amber-soft text-amber'
                  : 'border-primary/30 bg-primary-soft text-primary',
                !t && 'border-rose/40 bg-rose-soft text-rose',
              )}
            >
              {write && <ShieldAlert className="h-3 w-3" />}
              {id}
              <button
                type="button"
                onClick={() => onChange(selected.filter((s) => s !== id))}
                aria-label={`Quitar ${id}`}
                className="opacity-60 transition-opacity hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          );
        })}

        <div ref={boxRef} className="relative">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded-pill border border-dashed border-border-strong px-1.5 py-0.5 text-[10.5px] font-semibold text-ink-muted transition-all duration-150 hover:-translate-y-px hover:border-primary hover:text-primary motion-reduce:transform-none motion-reduce:transition-none"
          >
            <Plus className="h-3 w-3" />
            Herramienta
          </button>

          {open && (
            <div className="absolute left-0 top-7 z-30 w-[340px] overflow-hidden rounded-card border border-border bg-surface shadow-pop">
              <div className="relative flex items-center border-b border-border transition-colors duration-150 focus-within:bg-primary-soft/40 motion-reduce:transition-none">
                <Search className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-ink-faint" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Busca una herramienta…"
                  className="h-9 w-full bg-transparent pl-9 pr-3 text-[12.5px] text-ink placeholder:text-ink-faint focus:outline-none"
                />
              </div>
              <div className="max-h-[280px] overflow-y-auto p-1.5">
                {groups.length === 0 && (
                  <p className="px-2 py-4 text-center text-[12px] text-ink-muted">
                    Ninguna herramienta coincide con eso. Borra lo que escribiste para ver todas.
                  </p>
                )}
                {groups.map(([family, list]) => (
                  <div key={family} className="mb-1">
                    <div className="field-label px-2 py-1">{familyLabel(family)}</div>
                    {list.map((t) => {
                      const on = selected.includes(t.id);
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => toggle(t.id)}
                          disabled={!on && atCapacity}
                          className={clsx(
                            'flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left transition-colors',
                            on ? 'bg-primary-soft' : 'hover:bg-surface-2',
                            !on && atCapacity && 'cursor-not-allowed opacity-40',
                          )}
                        >
                          <span
                            className={clsx(
                              'mt-1 h-2 w-2 shrink-0 rounded-full',
                              t.requiresConfirmation ? 'bg-amber' : 'bg-emerald',
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span
                              className={clsx(
                                'block font-mono text-[11px] font-semibold',
                                on ? 'text-primary' : 'text-ink',
                              )}
                            >
                              {t.id}
                            </span>
                            <span className="line-clamp-2 block text-[11px] leading-snug text-ink-faint">
                              {t.description}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between border-t border-border bg-surface-2 px-3 py-1.5 text-[10.5px] text-ink-faint">
                <span className="inline-flex items-center gap-2">
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-emerald" /> solo lee
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full bg-amber" /> pide confirmación
                  </span>
                </span>
                <span className="tabular">{selected.length}/8</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
