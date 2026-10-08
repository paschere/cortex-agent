'use client';

import { type ThreadRow, groupThreads, threadTitle } from '@/lib/chat-thread-groups';
import * as Dialog from '@radix-ui/react-dialog';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Check,
  MessageSquare,
  MoreHorizontal,
  PanelLeft,
  Pencil,
  Pin,
  PinOff,
  Search,
  SquarePen,
  Trash2,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

/**
 * LA LISTA DE CHATS.
 *
 * Antes eran tres pastillas en la cabecera y un menú de ocho títulos. Ahora es
 * una lista de verdad: agrupada por antigüedad, con búsqueda, el chat actual
 * marcado y un menú «…» por fila para renombrar, fijar y eliminar.
 *
 *   · escritorio (lg+): panel a la izquierda del chat, que se pliega y recuerda
 *     cómo lo dejó la persona;
 *   · teléfono y tableta: el mismo contenido en una hoja que entra por la
 *     izquierda.
 *
 * Los fijados se guardan en este navegador (localStorage) — no hay columna en la
 * base y fijar es una comodidad de quien mira, no un dato de la empresa.
 * Renombrar y eliminar van contra /api/conversations/[id], que comprueba que la
 * conversación sea de quien pregunta.
 */

interface Conversation extends ThreadRow {
  title: string | null;
}

async function fetchConversations(): Promise<Conversation[]> {
  const r = await fetch('/api/conversations');
  if (!r.ok) return [];
  const j = await r.json();
  return (j.conversations as Conversation[]) ?? [];
}

// ---------------------------------------------------------------------------
// Estado compartido entre la cabecera, el panel y la hoja (sin contexto: el
// chat se vuelve a montar al cambiar de conversación y no debe perder nada).
// ---------------------------------------------------------------------------

const KEY_COLLAPSED = 'cortex.chat.list.collapsed';
const KEY_PINNED = 'cortex.chat.list.pinned';

const listeners = new Set<() => void>();
let sheetOpen = false;

function emit() {
  for (const l of listeners) l();
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}
function readLS(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLS(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* sin almacenamiento: la preferencia dura lo que dure la pestaña */
  }
  emit();
}

function useCollapsed(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => readLS(KEY_COLLAPSED) === '1',
    () => false,
  );
}
function useSheetOpen(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => sheetOpen,
    () => false,
  );
}
function setSheetOpen(next: boolean) {
  sheetOpen = next;
  emit();
}

function usePinned(): [ReadonlySet<string>, (id: string) => void] {
  const raw = useSyncExternalStore(
    subscribe,
    () => readLS(KEY_PINNED) ?? '',
    () => '',
  );
  const set = useMemo(() => new Set(raw ? raw.split(',').filter(Boolean) : []), [raw]);
  const toggle = (id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeLS(KEY_PINNED, [...next].join(','));
  };
  return [set, toggle];
}

function useConversations() {
  return useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Contenido de la lista
// ---------------------------------------------------------------------------

const menuItem =
  'flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-sm text-ink-muted outline-none transition-colors duration-150 data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink motion-reduce:transition-none';

function ThreadItem({
  row,
  active,
  pinned,
  onTogglePin,
  onNavigate,
}: {
  row: Conversation;
  active: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [mode, setMode] = useState<'view' | 'rename' | 'confirm'>('view');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const title = threadTitle(row);

  useEffect(() => {
    if (mode === 'rename') inputRef.current?.select();
  }, [mode]);

  const rename = async () => {
    const next = draft.replace(/\s+/g, ' ').trim();
    if (!next || next === title) {
      setMode('view');
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const r = await fetch(`/api/conversations/${row.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      if (!r.ok) throw new Error('rename');
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      if (active) router.refresh();
      setMode('view');
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setFailed(false);
    try {
      const r = await fetch(`/api/conversations/${row.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('delete');
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      if (active) router.push('/chat');
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };

  if (mode === 'rename') {
    return (
      <li className="px-1 py-0.5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void rename();
          }}
          className="flex items-center gap-1 rounded-sm border border-primary/40 bg-surface px-2 py-1 ring-2 ring-primary/15"
        >
          <input
            ref={inputRef}
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMode('view');
            }}
            aria-label="Nuevo nombre del chat"
            className="min-w-0 flex-1 bg-transparent py-1 text-sm text-ink outline-none"
          />
          <button
            type="submit"
            disabled={busy}
            aria-label="Guardar nombre"
            className="rounded-full p-1 text-primary-ink hover:bg-primary-soft disabled:opacity-40"
          >
            <Check className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setMode('view')}
            aria-label="Cancelar"
            className="rounded-full p-1 text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </form>
        {failed && (
          <p className="px-2 pt-1 text-micro text-rose">No se pudo guardar. Intenta otra vez.</p>
        )}
      </li>
    );
  }

  if (mode === 'confirm') {
    return (
      <li className="px-1 py-0.5">
        <div className="rounded-sm border border-rose/30 bg-rose-soft px-3 py-2">
          <p className="break-words text-sm text-ink">
            ¿Eliminar «<span className="font-medium">{title}</span>»?
          </p>
          <p className="mt-0.5 text-micro text-ink-muted">Se borra con todos sus mensajes.</p>
          {failed && (
            <p className="mt-1 text-micro text-rose">No se pudo eliminar. Intenta otra vez.</p>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="rounded-pill bg-rose px-3 py-1 text-xs font-semibold text-white disabled:opacity-50"
            >
              {busy ? 'Eliminando…' : 'Eliminar'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setMode('view')}
              className="rounded-pill border border-border bg-surface px-3 py-1 text-xs font-medium text-ink-muted hover:text-ink"
            >
              Cancelar
            </button>
          </div>
        </div>
      </li>
    );
  }

  return (
    <li className="group/item relative px-1">
      <Link
        href={`/chat/${row.id}`}
        title={title}
        aria-current={active ? 'page' : undefined}
        onClick={onNavigate}
        className={clsx(
          'flex min-w-0 items-center gap-2 rounded-sm py-2 pl-2.5 pr-9 text-sm transition-colors duration-150 motion-reduce:transition-none',
          active
            ? 'bg-primary-soft font-medium text-primary-ink'
            : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
        )}
      >
        {pinned && <Pin className="h-3 w-3 shrink-0 text-ink-faint" aria-hidden />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
      </Link>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={`Opciones de «${title}»`}
          className={clsx(
            'absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-ink-faint transition-opacity duration-150 hover:bg-surface hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 data-[state=open]:opacity-100 motion-reduce:transition-none',
            // En táctil no hay hover: el botón queda siempre a mano.
            'opacity-100 lg:opacity-0 lg:group-hover/item:opacity-100',
          )}
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-[70] w-44 rounded-card border border-border bg-surface p-1.5 shadow-pop"
          >
            <DropdownMenu.Item
              className={menuItem}
              onSelect={() => {
                setDraft(title === 'Sin título' ? '' : title);
                setFailed(false);
                setMode('rename');
              }}
            >
              <Pencil className="h-4 w-4" /> Renombrar
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} onSelect={onTogglePin}>
              {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
              {pinned ? 'Quitar de fijados' : 'Fijar'}
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item
              className={clsx(menuItem, 'text-rose data-[highlighted]:text-rose')}
              onSelect={() => {
                setFailed(false);
                setMode('confirm');
              }}
            >
              <Trash2 className="h-4 w-4" /> Eliminar
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}

function ThreadList({
  onNavigate,
  onCollapse,
}: { onNavigate?: () => void; onCollapse?: () => void }) {
  const pathname = usePathname();
  const { data = [], isPending, isError, refetch } = useConversations();
  const [pinned, togglePin] = usePinned();
  const [query, setQuery] = useState('');
  const groups = useMemo(() => groupThreads(data, { query, pinned }), [data, query, pinned]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pb-2 pt-3">
        <Link
          href="/chat"
          onClick={onNavigate}
          className="inline-flex min-w-0 flex-1 items-center justify-center gap-2 rounded-pill bg-primary px-3.5 py-2 text-sm font-semibold text-white shadow-card transition-colors duration-150 hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
        >
          <SquarePen className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
          <span className="truncate">Nuevo chat</span>
        </Link>
        {onCollapse && (
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Ocultar lista de chats"
            title="Ocultar lista"
            className="hidden shrink-0 rounded-full p-2 text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink lg:inline-flex motion-reduce:transition-none"
          >
            <PanelLeft className="h-[18px] w-[18px]" strokeWidth={1.75} />
          </button>
        )}
      </div>

      <div className="px-3 pb-2">
        <label className="flex items-center gap-2 rounded-pill border border-border bg-surface px-3 py-1.5 text-sm focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/15">
          <Search className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar chats"
            aria-label="Buscar chats por título"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Limpiar búsqueda"
              className="rounded-full p-0.5 text-ink-faint hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </label>
      </div>

      <nav aria-label="Chats" className="scroll-slim min-h-0 flex-1 overflow-y-auto pb-3">
        {isPending ? (
          <div className="space-y-2 px-4 pt-2" aria-hidden>
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="h-7 animate-pulse rounded-sm bg-surface-2 motion-reduce:animate-none"
                style={{ width: `${88 - i * 9}%` }}
              />
            ))}
          </div>
        ) : isError ? (
          <div className="px-4 pt-3 text-sm text-ink-muted">
            No pude cargar tus chats.{' '}
            <button
              type="button"
              onClick={() => void refetch()}
              className="font-medium text-primary underline underline-offset-2"
            >
              Reintentar
            </button>
          </div>
        ) : data.length === 0 ? (
          <div className="flex flex-col items-center px-6 pt-10 text-center">
            <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-2 text-ink-faint">
              <MessageSquare className="h-5 w-5" aria-hidden />
            </span>
            <p className="mt-3 text-sm font-medium text-ink">Aún no hay chats</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-muted">
              Tus conversaciones con Cortex aparecerán aquí.
            </p>
          </div>
        ) : groups.length === 0 ? (
          <p className="px-4 pt-3 text-sm text-ink-muted">
            Ningún chat se llama así. Prueba con otra palabra.
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="mt-2 first:mt-0">
              <h3 className="px-4 pb-1 pt-2 text-micro font-semibold text-ink-faint">{g.label}</h3>
              <ul className="space-y-px">
                {g.rows.map((row) => (
                  <ThreadItem
                    key={row.id}
                    row={row as Conversation}
                    active={pathname === `/chat/${row.id}`}
                    pinned={pinned.has(row.id)}
                    onTogglePin={() => togglePin(row.id)}
                    {...(onNavigate ? { onNavigate } : {})}
                  />
                ))}
              </ul>
            </section>
          ))
        )}
        <div className="mt-3 px-4">
          <Link
            href="/conversations"
            onClick={onNavigate}
            className="text-xs text-ink-faint underline-offset-2 hover:text-ink hover:underline"
          >
            Archivo completo (Google Chat, rutinas…)
          </Link>
        </div>
      </nav>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Piezas montadas por ChatRoot
// ---------------------------------------------------------------------------

/** Panel fijo a la izquierda del chat, sólo en escritorio. */
export function ThreadAside() {
  const collapsed = useCollapsed();
  if (collapsed) return null;
  return (
    <aside
      aria-label="Lista de chats"
      className="hidden w-72 shrink-0 border-r border-border bg-surface lg:block"
    >
      <ThreadList onCollapse={() => writeLS(KEY_COLLAPSED, '1')} />
    </aside>
  );
}

/** Botones de la cabecera + la hoja que se abre en pantallas estrechas. */
export function ThreadHistory() {
  const collapsed = useCollapsed();
  const open = useSheetOpen();
  const pathname = usePathname();

  // Navegar cierra la hoja aunque el clic no pase por un enlace de la lista.
  // biome-ignore lint/correctness/useExhaustiveDependencies: la ruta es el disparador.
  useEffect(() => {
    setSheetOpen(false);
  }, [pathname]);

  const btn =
    'shrink-0 rounded-full p-2 text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none';

  return (
    <div className="flex min-w-0 shrink items-center gap-1">
      <Link
        href="/chat"
        title="Nuevo chat"
        aria-label="Nuevo chat"
        className={clsx(btn, 'hover:bg-primary-soft hover:text-primary-ink')}
      >
        <SquarePen strokeWidth={1.75} className="h-[18px] w-[18px]" />
      </Link>

      {/* Escritorio: pliega o despliega el panel. Sólo hace falta cuando está plegado. */}
      {collapsed && (
        <button
          type="button"
          onClick={() => writeLS(KEY_COLLAPSED, '0')}
          title="Mostrar lista de chats"
          aria-label="Mostrar lista de chats"
          className={clsx(btn, 'hidden lg:inline-flex')}
        >
          <PanelLeft strokeWidth={1.75} className="h-[18px] w-[18px]" />
        </button>
      )}

      {/* Teléfono y tableta: la lista entra en una hoja. */}
      <Dialog.Root open={open} onOpenChange={setSheetOpen}>
        <Dialog.Trigger title="Chats" aria-label="Ver mis chats" className={clsx(btn, 'lg:hidden')}>
          <PanelLeft strokeWidth={1.75} className="h-[18px] w-[18px]" />
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-[60] animate-veil bg-ink/40 backdrop-blur-[2px] lg:hidden" />
          <Dialog.Content
            aria-describedby={undefined}
            className="cortex-workspace fixed inset-y-0 left-0 z-[61] flex w-[min(20rem,88vw)] flex-col border-r border-border bg-surface pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] shadow-pop focus:outline-none lg:hidden"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <Dialog.Title className="text-base font-semibold text-ink">Mis chats</Dialog.Title>
              <Dialog.Close
                aria-label="Cerrar"
                className="rounded-full p-1.5 text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                <X className="h-5 w-5" />
              </Dialog.Close>
            </div>
            <div className="min-h-0 flex-1">
              <ThreadList onNavigate={() => setSheetOpen(false)} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
