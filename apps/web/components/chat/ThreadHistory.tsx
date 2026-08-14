'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { History, SquarePen } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

/**
 * CAMBIAR DE TEMA SIN PERDER EL HILO.
 *
 * Estos hilos vivían en la barra lateral, inyectados entre Chat y Aprobaciones,
 * donde partían la navegación en dos mitades que había que leer por separado.
 * Un hilo no es un destino: es el contenido de un destino, y pertenece a la
 * cabecera de ese destino. Eso ya estaba resuelto.
 *
 * ===========================================================================
 * LO QUE CAMBIA: TRES HILOS A LA VISTA, SIN ABRIR NADA
 * ===========================================================================
 * Estaban todos detrás del icono de historial, o sea a un clic y a una lectura
 * de ocho títulos. Ahora los tres últimos se dibujan en la cabecera y el resto
 * sigue en el menú. Las otras dos formas se descartaron, y no por gusto:
 *
 *   PESTAÑAS. Una pestaña promete que la cosa está ABIERTA y que se puede
 *     cerrar, y que el juego es acotado. Aquí ninguna de las tres es verdad:
 *     una conversación no se abre ni se cierra, hay decenas y crecen solas —
 *     cada mensaje de una rutina o de Google Chat crea una—, y borrar tiene su
 *     sitio, que es el archivo. Una tira de pestañas de treinta elementos es
 *     una barra de desplazamiento disfrazada.
 *
 *   UNA FILA CON TODOS, DESPLAZABLE. Es un menú que además hay que arrastrar:
 *     lo que no cabe está igual de escondido que en el desplegable, pero encima
 *     ocupa la cabecera entera y compite con el aviso de lo que te espera.
 *
 * TRES, PORQUE ES LO QUE CABE SIN QUE EL TÍTULO DEJE DE LEERSE. Un título de
 * conversación mide sesenta caracteres; recortado a diez es un jeroglífico, y
 * cuatro chips de diez caracteres son peor que ninguno. Tres a `10rem` se leen,
 * y cubren el comportamiento real: la gente rebota entre el hilo de ahora y el
 * de hace un rato, no entre treinta. Para los demás está el menú, que sigue
 * ahí entero y con la puerta al archivo.
 *
 * Y SE ESCONDEN EN PANTALLA ESTRECHA (`lg`), donde la cabecera ya lleva el
 * agente y el aviso. Nada se vuelve inalcanzable: el desplegable se dibuja en
 * todos los anchos y contiene exactamente lo mismo.
 *
 * BORRAR NO ESTÁ AQUÍ, a propósito. /conversations es el archivo, ya tiene su
 * botón, y enseña los hilos que esta lista no puede — los que llegaron de
 * Google Chat, de Claude y de las rutinas.
 *
 * LA CONSULTA. Ahora corre al montar, porque los chips existen sin que nadie
 * abra nada; es una lista de ocho títulos con `staleTime` de un minuto,
 * compartida con el desplegable, así que abrirlo no vuelve a pedir nada.
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
  'flex cursor-pointer items-center rounded-sm px-2.5 py-[7px] text-sm outline-none transition-colors duration-150 data-[highlighted]:bg-surface-2 motion-reduce:transition-none';

/** Cuántos se dibujan sin abrir el menú. Ver la cabecera: tres, y por qué. */
const PINNED = 3;

export function ThreadHistory() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { data: conversations = [], isPending } = useQuery({
    queryKey: ['conversations'],
    queryFn: fetchConversations,
    staleTime: 60_000,
  });

  const recent = conversations.slice(0, 8);
  const pinned = conversations.slice(0, PINNED);

  return (
    <div className="flex min-w-0 shrink items-center gap-1">
      <div className="hidden min-w-0 items-center gap-1 lg:flex">
        {pinned.map((c) => {
          const href = `/chat/${c.id}`;
          const active = pathname === href;
          const title = c.title?.trim() || 'Sin título';
          return (
            <Link
              key={c.id}
              href={href}
              title={title}
              aria-current={active ? 'page' : undefined}
              className={clsx(
                'max-w-[10rem] truncate rounded-pill px-2.5 py-1 text-xs transition-colors duration-150 motion-reduce:transition-none',
                active
                  ? 'bg-primary-soft font-semibold text-primary-ink'
                  : 'text-ink-faint hover:bg-surface-2 hover:text-ink',
              )}
            >
              {title}
            </Link>
          );
        })}
      </div>

      <Link
        href="/chat"
        title="Nuevo chat"
        aria-label="Nuevo chat"
        className="shrink-0 rounded-full p-2 text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <SquarePen strokeWidth={1.75} className="h-[18px] w-[18px]" />
      </Link>

      <DropdownMenu.Root open={open} onOpenChange={setOpen}>
        <DropdownMenu.Trigger
          title="Historial"
          aria-label="Ver conversaciones recientes"
          className="shrink-0 rounded-full p-2 text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 data-[state=open]:bg-surface-2 data-[state=open]:text-ink motion-reduce:transition-none"
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
              <div className="px-2.5 py-2 text-xs text-ink-faint">Cargando…</div>
            ) : recent.length === 0 ? (
              // Not an error and not a dead end: a person with no threads here
              // may still have conversations in the archive, because this list
              // drops MCP sessions (see app/api/conversations/route.ts) and
              // routine deliveries only show up over there.
              <div className="px-2.5 py-2 text-xs text-ink-faint">
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
