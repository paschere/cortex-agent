'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { History, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

/**
 * RECENT THREADS, IN THE CHAT'S OWN HEADER.
 *
 * These used to live in the sidebar, injected between Chat and Aprobaciones,
 * where they split the navigation into two halves that had to be scanned
 * separately — the rail asked you to read past four conversation titles to get
 * from "Chat" to "Aprobaciones". Threads are not destinations; they are the
 * contents of one destination, and they belong where that destination is.
 *
 * DELETING IS NOT HERE, ON PURPOSE. The sidebar list carried a hover-revealed
 * bin because it was the only list of conversations anybody ever saw. It is not
 * any more: /conversations is the archive, it already has
 * DeleteConversationButton, and it shows the threads this list cannot — the ones
 * that arrived from Google Chat, from Claude and from routines. So this menu
 * does one thing, which is jump between recent threads, and points at the
 * archive for everything else.
 *
 * The query only runs once the menu is opened. A chat page should not pay for a
 * list nobody asked to see.
 */

interface Conversation {
  id: string;
  title: string | null;
}

async function fetchConversations(): Promise<Conversation[]> {
  const r = await fetch('/api/conversations');
  if (!r.ok) return [];
  const j = await r.json();
  return (j.conversations as Conversation[]) ?? [];
}

const itemClass =
  'flex cursor-pointer items-center rounded-sm px-2.5 py-[7px] text-[13px] outline-none transition-colors duration-150 data-[highlighted]:bg-surface-2 motion-reduce:transition-none';

export function ThreadHistory() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { data: conversations = [], isPending } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    staleTime: 60_000,
    enabled: open,
  });

  const recent = conversations.slice(0, 8);

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1">
      <Link
        href="/chat"
        title="Nuevo chat"
        aria-label="Nuevo chat"
        className="rounded-full p-2 text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <SquarePen strokeWidth={1.75} className="h-[18px] w-[18px]" />
      </Link>

      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger
          title="Historial"
          aria-label="Ver conversaciones recientes"
          className="rounded-full p-2 text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 data-[state=open]:bg-surface-2 data-[state=open]:text-ink motion-reduce:transition-none"
        >
          <History strokeWidth={1.75} className="h-[18px] w-[18px]" />
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 w-[280px] rounded-card border border-border bg-surface p-1.5 shadow-pop"
          >
            {isPending ? (
              <div className="px-2.5 py-2 text-[12.5px] text-ink-faint">Cargando…</div>
            ) : recent.length === 0 ? (
              // Not an error and not a dead end: a person with no threads here
              // may still have conversations in the archive, because this list
              // drops MCP sessions (see app/api/conversations/route.ts) and
              // routine deliveries only show up over there.
              <div className="px-2.5 py-2 text-[12.5px] text-ink-faint">
                Todavía no hay conversaciones recientes.
              </div>
            ) : (
              recent.map((c) => {
                const href = `/chat/${c.id}`;
                const active = pathname === href;
                return (
                  <DropdownMenu.Item key={c.id} asChild>
                    <Link
                      href={href}
                      title={c.title ?? 'Sin título'}
                      className={clsx(
                        itemClass,
                        active
                          ? 'bg-primary-soft font-semibold text-primary-ink'
                          : 'text-ink-muted hover:text-ink',
                      )}
                    >
                      <span className="truncate">{c.title?.trim() || 'Sin título'}</span>
                    </Link>
                  </DropdownMenu.Item>
                );
              })
            )}

            <DropdownMenu.Separator className="my-1.5 h-px bg-border" />
            <DropdownMenu.Item asChild>
              <Link
                href="/conversations"
                className={clsx(itemClass, 'text-ink-muted hover:text-ink')}
              >
                Todas las conversaciones
              </Link>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
