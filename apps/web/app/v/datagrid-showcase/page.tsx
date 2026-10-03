import { notFound } from 'next/navigation';
import { DatagridShowcase } from './Showcase';

/**
 * EL VISUALIZADOR DE DATOS CON 5.000 GUÍAS DE MENTIRA. SÓLO EN DESARROLLO.
 *
 * Ejercita todo el `DataGrid` (components/datagrid) sin sesión ni base:
 * filtros, orden, grupos, columnas, vistas guardadas, tablero, tarjetas,
 * calendario, edición en celda con deshacer, selección en bloque, CSV.
 * Vive bajo `/v` por la misma razón que /v/equipo-showcase: el prefijo ya es
 * público y un segmento estático gana a `/v/[token]`.
 *
 * Parámetros: `?pantalla=grilla|tablas|tabla`, `?modo=oscuro`, `?vacia=1`
 * (sin filas), `?servidor=1` (páginas desde un «servidor» de mentira),
 * `?filas=N`. La vista también viaja en `?vista=…` como en el producto.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function DatagridShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const pantalla = one('pantalla');
  return (
    <DatagridShowcase
      pantalla={pantalla === 'tablas' || pantalla === 'tabla' ? pantalla : 'grilla'}
      dark={one('modo') === 'oscuro'}
      empty={one('vacia') === '1'}
      server={one('servidor') === '1'}
      rows={Math.max(0, Math.min(Number(one('filas') ?? 5000) || 5000, 20_000))}
    />
  );
}
