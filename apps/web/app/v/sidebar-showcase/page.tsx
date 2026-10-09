import { notFound } from 'next/navigation';
import { SidebarShowcase } from './Showcase';

/**
 * EL RAIL, CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * Pinta `SidebarBody` en expandido, contraído (56px), sin tarjeta de puesta en
 * marcha, sin insignias y en el ancho del cajón del teléfono, más la barra de
 * pestañas. `?tema=oscuro` fuerza el tema oscuro.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function SidebarShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  return <SidebarShowcase dark={q.tema === 'oscuro'} />;
}
