import { CommandMenuProvider } from '@/components/nav/CommandMenuContext';
import { MobileSidebarProvider } from '@/components/nav/MobileSidebarContext';
import { Sidebar } from '@/components/nav/Sidebar';
import { PanelHost, PanelProvider } from '@/components/panel/PanelHost';
import { countNavSignals } from '@/lib/nav-signals';
import type { SessionUser } from '@cortex/core';
import type { ReactNode } from 'react';

/**
 * EL SHELL, EN UN SOLO SITIO.
 *
 * `app/(chat)/layout.tsx` y `app/(app)/layout.tsx` tenían copiados los mismos
 * tres proveedores, el mismo `Sidebar` y la misma llamada a `countNavSignals`.
 * Cinco líneas duplicadas no son un problema; que sean cinco líneas de las que
 * DEPENDE una invariante sí lo es, y ahora dependen dos: que el ⌘K esté en las
 * dos mitades de la aplicación, y que `PanelProvider` envuelva SIEMPRE al rail
 * y al contenido a la vez. Un shell que se pueda montar a medias es un shell
 * donde una fila del rail abre un panel que no existe.
 *
 * LOS DOS LAYOUTS NO SE FUSIONAN, y no por pereza. La diferencia que queda es
 * real —el chat ocupa el alto completo y gestiona su propio scroll; el resto
 * centra su contenido en una columna con padding y una barra superior— y
 * fusionarlos costaría un puñado de props condicionales para ahorrar seis
 * líneas. Así que cada layout sigue trayendo su propio interior como
 * `children`, y esto trae lo que los dos tenían igual.
 *
 * ES UN COMPONENTE DE SERVIDOR a propósito: `countNavSignals` lee la base de
 * datos, y ponerlo aquí es lo que permite que los dos layouts dejen de hacerlo.
 *
 * ============================================================================
 * EL ORDEN DE ESTE ÁRBOL ES LA PROMESA DEL PANEL
 * ============================================================================
 * `PanelProvider` recibe `{children}` como PROP y `PanelHost` se dibuja como
 * HERMANO de `{children}`, nunca como padre. Las dos cosas juntas son lo que
 * garantiza que abrir el panel no desmonte `ChatRoot`:
 *
 *   · como prop → cuando el proveedor cambia de estado, `children` sigue siendo
 *     el mismo elemento y React descarta ese subárbol sin recorrerlo;
 *   · como hermano → `ChatRoot` no cambia de posición en el árbol cuando el
 *     panel aparece o desaparece, y una posición que no cambia no se remonta.
 *
 * `components/panel/mount.test.ts` lo vigila con este archivo en la mano,
 * porque es la clase de invariante que se rompe con un movimiento de llaves.
 */
export async function AppShell({
  user,
  children,
}: {
  user: SessionUser;
  /** El interior propio de cada layout. Ocupa la columna central. */
  children: ReactNode;
}) {
  const counts = await countNavSignals(user.organization.id, user.id);

  return (
    <MobileSidebarProvider>
      <CommandMenuProvider role={user.role}>
        <PanelProvider>
          <div className="flex h-screen overflow-hidden bg-canvas print:h-auto print:overflow-visible">
            {/* `user.organization` baja hasta el pie del rail para que el
                selector de espacio pinte el nombre con el HTML y no medio
                segundo después: el shell ya lo sabe, y el dato de en qué
                empresa estás no puede llegar más tarde que sus cifras. */}
            <div className="print:hidden">
              <Sidebar role={user.role} counts={counts} organization={user.organization} />
            </div>
            {children}
            <PanelHost />
          </div>
        </PanelProvider>
      </CommandMenuProvider>
    </MobileSidebarProvider>
  );
}
