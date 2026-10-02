import { requireSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Sólo quien administra: esta pantalla muestra trabajo de toda la empresa
 * (corridas y tareas de otras personas) y es vocabulario de quien construye
 * Cortex, no del día a día. Igual que /admin: `redirect` antes de que la
 * página se ejecute, hacia /sin-acceso, que dice a quién pedírselo.
 */
export default async function AdminOnlyLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();
  if (user.role !== 'org_admin') redirect('/sin-acceso?area=avanzado');
  return <>{children}</>;
}
