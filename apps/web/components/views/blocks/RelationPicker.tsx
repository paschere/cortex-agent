'use client';

import { appApiBase } from '@/lib/apps/api-base';
import { recallList, rememberList } from '@/lib/apps/screen-store';
import { clsx } from 'clsx';
import { Check, Loader2, Plus, Search, WifiOff, X } from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { SubmitTarget } from '../ViewCanvas';
import { useCaptureWho } from '../inputs/capture-context';
import { type RelationOption, useFormDataSource } from './form-data-source';
import { reportNetworkFailure } from './useConnection';

/**
 * ELEGIR UNA FILA DE OTRA TABLA, COMO SE ELIGE EN UN TELÉFONO.
 *
 * Un buscador en una hoja que sube desde abajo (en escritorio, un diálogo
 * centrado): filas grandes con su nombre y un dato para reconocerlas, búsqueda
 * sin tildes ni mayúsculas, teclado (flechas, Enter, Esc) y, si el rol puede,
 * «+ Agregar «Acme»» para crear la fila que falta sin salir del formulario.
 * Sin señal usa la última lista que se vio (guardada en el teléfono de ESTA
 * persona, ver lib/apps/screen-store.ts) y lo dice.
 *
 * `useRelationSource` es la parte sin pantalla: la comparten el campo de
 * relación y las líneas de un formulario.
 */

export type { RelationOption };

const fold = (t: string) =>
  t
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

/** Lo último que se eligió: para pintar la tarjeta del elegido aunque el formulario cambie de paso. */
const chosen = new Map<string, RelationOption>();
export const rememberChosen = (o: RelationOption) => {
  if (chosen.size > 200) chosen.clear();
  chosen.set(o.id, o);
};
export const chosenDetail = (id: string): RelationOption | undefined => chosen.get(id);

/** `{"id","label"}` → el elegido; null si no hay o no se entiende. */
export function parseRelation(value: string): { id: string; label: string } | null {
  if (!value) return null;
  try {
    const v = JSON.parse(value) as { id?: string; label?: string };
    return v.id ? { id: v.id, label: v.label || v.id.slice(0, 8) } : null;
  } catch {
    return null;
  }
}

export function relationBase(target: SubmitTarget): string | null {
  if (target.kind === 'app') return `/api/views/${target.viewId}/relation`;
  if (target.kind === 'custom_app') return `${appApiBase(target)}/screens/${target.screen}/relation`;
  if (target.kind === 'public') return '/api/views/public/relation';
  return null;
}

export function relationUrl(
  target: SubmitTarget,
  blockId: string,
  field: string,
  q: string,
): string | null {
  const base = relationBase(target);
  if (!base) return null;
  const qs = new URLSearchParams({ block: blockId, field, q });
  if (target.kind === 'public') qs.set('token', target.token);
  return `${base}?${qs}`;
}

export interface RelationSource {
  search: (q: string, signal?: AbortSignal) => Promise<{ options: RelationOption[]; offline: boolean }>;
  /** Hay un camino para crear (dentro de la app, con sesión). El rol lo decide el servidor. */
  canCreate: boolean;
  create: (label: string) => Promise<RelationOption>;
}

export function useRelationSource(
  target: SubmitTarget,
  blockId: string,
  fieldKey: string,
): RelationSource {
  const demo = useFormDataSource();
  const who = useCaptureWho();
  const appKey = who.appKey ?? null;
  const userKey = who.userKey ?? null;
  const targetKey = JSON.stringify(target);

  // biome-ignore lint/correctness/useExhaustiveDependencies: target se compara por su contenido.
  return useMemo<RelationSource>(() => {
    if (demo?.relation) {
      const d = demo.relation;
      return {
        search: (q) => d.search(fieldKey, q).then((options) => ({ options, offline: false })),
        canCreate: Boolean(d.create),
        create: (label) => (d.create ? d.create(fieldKey, label) : Promise.reject(new Error('No'))),
      };
    }
    const emptyUrl = relationUrl(target, blockId, fieldKey, '');
    return {
      canCreate: target.kind === 'app' || target.kind === 'custom_app',
      async search(q, signal) {
        const url = relationUrl(target, blockId, fieldKey, q);
        if (!url) return { options: [], offline: false };
        try {
          const res = await fetch(url, { signal });
          const body = (await res.json().catch(() => null)) as { options?: RelationOption[] } | null;
          if (!res.ok || !body?.options) throw new Error('bad');
          if (!q.trim() && appKey && userKey && emptyUrl)
            void rememberList({ appKey, userKey }, emptyUrl, body.options);
          return { options: body.options, offline: false };
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') throw err;
          reportNetworkFailure();
          // Sin señal: la última lista vista, filtrada aquí.
          if (appKey && userKey && emptyUrl) {
            const hit = await recallList<RelationOption>({ appKey, userKey }, emptyUrl);
            if (hit) {
              const needle = fold(q);
              return {
                options: hit.options
                  .filter((o) => !needle || fold(`${o.label} ${o.detail ?? ''}`).includes(needle))
                  .slice(0, 30),
                offline: true,
              };
            }
          }
          throw new Error('No se pudo buscar.');
        }
      },
      async create(label) {
        const base = relationBase(target);
        if (!base) throw new Error('Aquí no se pueden agregar filas.');
        let res: Response;
        try {
          res = await fetch(base, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ block: blockId, field: fieldKey, label }),
          });
        } catch {
          reportNetworkFailure();
          throw new Error('Sin conexión: no se puede agregar ahora. Elige uno de la lista.');
        }
        const body = (await res.json().catch(() => null)) as {
          option?: RelationOption;
          error?: string;
        } | null;
        if (!res.ok || !body?.option) throw new Error(body?.error ?? 'No se pudo agregar ahora.');
        return body.option;
      },
    };
  }, [demo, targetKey, blockId, fieldKey, appKey, userKey]);
}

/** La hoja de búsqueda. */
export function RelationSheet({
  open,
  onOpenChange,
  title,
  addNoun,
  source,
  selectedId,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** «Cliente»: el título de la hoja. */
  title: string;
  /** «cliente»: lo que dice «+ Agregar «Acme» como cliente». */
  addNoun: string;
  source: RelationSource;
  selectedId?: string | null;
  onSelect: (option: RelationOption) => void;
}) {
  const listId = useId();
  const [q, setQ] = useState('');
  const [options, setOptions] = useState<RelationOption[]>([]);
  const [state, setState] = useState<'loading' | 'idle' | 'error'>('loading');
  const [offline, setOffline] = useState(false);
  const [active, setActive] = useState(0);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const searchRef = useRef(source.search);
  searchRef.current = source.search;

  // Busca al abrir y al escribir (con una pausa corta); una respuesta vieja se descarta.
  useEffect(() => {
    if (!open) return;
    const ctl = new AbortController();
    setState('loading');
    const t = window.setTimeout(
      async () => {
        try {
          const res = await searchRef.current(q, ctl.signal);
          if (ctl.signal.aborted) return;
          setOptions(res.options);
          setOffline(res.offline);
          setState('idle');
          setActive(0);
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') return;
          if (!ctl.signal.aborted) setState('error');
        }
      },
      q ? 200 : 0,
    );
    return () => {
      ctl.abort();
      window.clearTimeout(t);
    };
  }, [open, q]);

  useEffect(() => {
    if (!open) {
      setQ('');
      setAddError(null);
    }
  }, [open]);

  const typed = q.replace(/\s+/g, ' ').trim();
  const exact = options.some((o) => fold(o.label) === fold(typed));
  const showAdd = source.canCreate && !offline && typed.length >= 2 && !exact && state !== 'error';
  const rows = options.length + (showAdd ? 1 : 0);

  const choose = (o: RelationOption) => {
    rememberChosen(o);
    onSelect(o);
    onOpenChange(false);
  };
  const add = useCallback(async () => {
    setAdding(true);
    setAddError(null);
    try {
      choose(await source.create(typed));
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'No se pudo agregar ahora.');
    } finally {
      setAdding(false);
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: choose cambia en cada render y sólo usa onSelect.
  }, [source, typed]);

  const activate = (i: number) => {
    const o = options[i];
    if (o) choose(o);
    else if (showAdd && i === options.length) void add();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-ink/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className={clsx(
            'fixed z-50 flex flex-col overflow-hidden border border-border bg-surface shadow-pop outline-none',
            'inset-x-0 bottom-0 max-h-[85dvh] min-h-[55dvh] rounded-t-card pb-[env(safe-area-inset-bottom)]',
            'sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-[14vh] sm:max-h-[70vh] sm:min-h-0 sm:w-[28rem] sm:-translate-x-1/2 sm:rounded-card sm:pb-0',
          )}
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Dialog.Title className="min-w-0 flex-1 truncate text-base font-extrabold text-ink">
              {title}
            </Dialog.Title>
            <Dialog.Close
              aria-label="Cerrar"
              className="grid h-10 w-10 place-items-center rounded-pill text-ink-muted hover:bg-surface-2"
            >
              <X className="h-5 w-5" aria-hidden />
            </Dialog.Close>
          </div>
          <div className="relative px-4 pt-3">
            <Search
              className="pointer-events-none absolute left-7 top-1/2 mt-1.5 h-4 w-4 -translate-y-1/2 text-ink-faint"
              aria-hidden
            />
            <input
              // biome-ignore lint/a11y/noAutofocus: la hoja se abre para buscar.
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={rows ? `${listId}-${active}` : undefined}
              aria-label={`Buscar ${addNoun}`}
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(rows - 1, a + 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(0, a - 1));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  activate(active);
                }
              }}
              placeholder={`Buscar ${addNoun}…`}
              className="h-12 w-full rounded-sm border border-border-strong bg-surface pl-10 pr-3 text-base text-ink outline-none placeholder:text-ink-faint focus:border-primary focus-visible:ring-4 focus-visible:ring-primary/15"
            />
          </div>
          {offline && (
            <p className="mx-4 mt-3 flex items-center gap-2 rounded-sm bg-amber-soft px-3 py-2 text-xs font-semibold text-amber">
              <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
              Sin conexión: esta es la última lista que viste.
            </p>
          )}
          <ul
            id={listId}
            // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: lista de opciones de un combobox.
            role="listbox"
            aria-label={title}
            className="mt-2 min-h-24 flex-1 overflow-y-auto px-2 pb-3"
          >
            {options.map((o, i) => (
              <li
                key={o.id}
                id={`${listId}-${i}`}
                // biome-ignore lint/a11y/useSemanticElements: opción de un combobox, no un select nativo.
                role="option"
                aria-selected={o.id === selectedId}
                tabIndex={-1}
                onMouseMove={() => setActive(i)}
                onKeyDown={() => {}}
                onClick={() => choose(o)}
                className={clsx(
                  'flex min-h-14 cursor-pointer items-center gap-3 rounded-sm px-3 py-2',
                  i === active ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
              >
                <Initial label={o.label} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-base font-semibold text-ink">{o.label}</span>
                  {o.detail && (
                    <span className="block truncate text-xs text-ink-muted">{o.detail}</span>
                  )}
                </span>
                {o.id === selectedId && <Check className="h-5 w-5 shrink-0 text-primary" aria-hidden />}
              </li>
            ))}
            {showAdd && (
              <li
                id={`${listId}-${options.length}`}
                // biome-ignore lint/a11y/useSemanticElements: opción de un combobox, no un select nativo.
                role="option"
                aria-selected={false}
                tabIndex={-1}
                onMouseMove={() => setActive(options.length)}
                onKeyDown={() => {}}
                onClick={() => void add()}
                className={clsx(
                  'flex min-h-14 cursor-pointer items-center gap-3 rounded-sm px-3 py-2 text-primary-ink',
                  active === options.length ? 'bg-primary-soft' : 'hover:bg-primary-soft',
                )}
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-primary-soft text-primary">
                  {adding ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                  ) : (
                    <Plus className="h-4 w-4" aria-hidden />
                  )}
                </span>
                <span className="min-w-0 flex-1 break-words text-base font-semibold">
                  Agregar «{typed}» como {addNoun}
                </span>
              </li>
            )}
            {state === 'loading' && (
              <li className="flex items-center gap-2 px-3 py-3 text-xs text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Buscando…
              </li>
            )}
            {state === 'error' && (
              <li className="px-3 py-3 text-xs font-semibold text-amber">
                No se pudo buscar. Revisa la conexión e inténtalo otra vez.
              </li>
            )}
            {state === 'idle' && rows === 0 && (
              <li className="px-3 py-3 text-xs text-ink-muted">
                {typed ? 'Nada con ese nombre.' : 'Todavía no hay nada para elegir.'}
              </li>
            )}
          </ul>
          {addError && (
            <p role="alert" className="border-t border-border bg-amber-soft px-4 py-2 text-xs font-semibold text-amber">
              {addError}
            </p>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Las iniciales en un círculo: la cara de una fila sin foto. */
export function Initial({ label, className }: { label: string; className?: string }) {
  const letter = [...label.trim()].find((c) => /[\p{L}\p{N}]/u.test(c)) ?? '·';
  return (
    <span
      aria-hidden
      className={clsx(
        'grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-primary-soft text-sm font-extrabold text-primary-ink ring-1 ring-primary/15',
        className,
      )}
    >
      {letter.toLocaleUpperCase('es-CO')}
    </span>
  );
}
