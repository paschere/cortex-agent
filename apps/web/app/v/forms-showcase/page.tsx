import { notFound } from 'next/navigation';
import { FormsShowcase } from './FormsShowcase';

/**
 * EL ESCAPARATE DE LOS FORMULARIOS TÉCNICOS. SÓLO EN DESARROLLO.
 *
 * Pinta el selector de horarios de las rutinas (y el diálogo de edición con
 * una rutina inventada) y el asistente «Conectar una API» de Feed con un
 * transporte falso, para mirarlos sin sesión y sin base de datos. Vive bajo
 * `/v` por la misma razón que /v/views-showcase: ese prefijo ya es público en
 * middleware.ts y un segmento estático gana a `/v/[token]`.
 *
 * Parámetros: `?modo=oscuro`, `?panel=rutina|api`, `?dialogo=1` (abre el
 * diálogo de edición), `?admin=0` (el asistente como alguien que no
 * administra), `?falla=1` (la prueba de la API responde 401).
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function FormsShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  return (
    <FormsShowcase
      dark={one('modo') === 'oscuro'}
      panel={one('panel')}
      dialog={one('dialogo') === '1'}
      admin={one('admin') !== '0'}
      failing={one('falla') === '1'}
    />
  );
}
