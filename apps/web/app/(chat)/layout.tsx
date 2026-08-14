import { AppShell } from '@/components/nav/AppShell';
import { requireSession } from '@/lib/session';
import type { ReactNode } from 'react';

/**
 * El chat ocupa el alto completo y gestiona su propio scroll. Ésa es la única
 * diferencia que queda con `app/(app)/layout.tsx`, y es la razón por la que los
 * dos layouts siguen existiendo: todo lo demás —proveedores, rail, conteos,
 * panel— vive en `AppShell`.
 *
 * LA HOJA DE LOS INFORMES YA NO SE INYECTA AQUÍ. Estaba en un
 * `<style dangerouslySetInnerHTML>` porque `REPORT_CSS` es un valor de
 * `@cortex/agent-tools` y sólo un componente de servidor puede importarlo. Eso
 * la ataba a este layout, y en cuanto el panel de al lado pinta un informe hace
 * falta también en el otro. Ahora es una hoja de verdad —`app/report.css` con
 * `Cache-Control: immutable`, enlazada desde `app/layout.tsx`—, que además deja
 * de viajar cuatro kilobytes en cada carga útil de RSC.
 */
export default async function ChatLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();
  return (
    <AppShell user={user}>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
    </AppShell>
  );
}
