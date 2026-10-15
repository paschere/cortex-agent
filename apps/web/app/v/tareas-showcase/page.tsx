import { notFound } from 'next/navigation';
import { TareasShowcase } from './Showcase';

/**
 * «TAREAS» CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /tareas pide sesión; aquí se pintan la lista y la pantalla de una tarea con
 * todos los estados. Parámetros: `?modo=oscuro`, `?vista=tarea` (el detalle de
 * una tarea terminada), `?vista=necesita` (una que espera tu visto bueno),
 * `?admin=1` (la lista como la ve quien administra: con la dueña de cada una).
 */
export const dynamic = 'force-dynamic';

export default async function TareasShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  return (
    <TareasShowcase
      dark={one('modo') === 'oscuro'}
      view={
        one('vista') === 'tarea'
          ? 'tarea'
          : one('vista') === 'necesita'
            ? 'necesita'
            : one('vista') === 'galeria'
              ? 'galeria'
              : 'lista'
      }
      admin={one('admin') === '1'}
    />
  );
}
