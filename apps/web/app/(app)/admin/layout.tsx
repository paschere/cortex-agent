import { requireSession } from '@/lib/session';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

/**
 * Quien no administra no ve /admin/*, pero tampoco un 404 mudo.
 *
 * Antes respondía `notFound()`: una persona que seguía un enlace a «Personas»
 * llegaba a «esta página no existe», que es falso y no dice qué hacer. Ahora va
 * a /sin-acceso, que explica que la parte existe y nombra a quién pedírsela.
 *
 * `redirect` y no pintar el aviso aquí mismo: un layout que omite `children`
 * no impide que la página hija se ejecute ni que su contenido viaje en la carga
 * del servidor. `redirect` lanza antes de que nada de eso ocurra, igual que
 * hacía `notFound`.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();
  if (user.role !== 'org_admin') redirect('/sin-acceso?area=admin');
  return <>{children}</>;
}
