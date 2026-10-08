import { notFound } from 'next/navigation';
import { AppsFixture } from './Showcase';

/**
 * EL MARCO DE UNA APP Y SU INICIO, CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /apps y /a piden sesión y una base con la migración 0215; aquí se pintan los
 * mismos componentes (AppRunner, AppHome) con tarjetas inventadas. Vive bajo
 * `/v` porque el prefijo ya es público.
 *
 * Parámetros: `?marca=amarillo|verde` (color propio de la app),
 * `?pantallas=3|8` (cuántas pestañas), `?vacio=1` (sin tarjetas),
 * `?vista=entrada|kiosco|error|carga|desconectado` (la puerta con código, el
 * kiosco con PIN, y los estados de error, carga y sin señal).
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function AppsShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  return (
    <AppsFixture
      marca={q.marca === 'amarillo' || q.marca === 'verde' ? q.marca : null}
      pantallas={q.pantallas === '8' ? 8 : 3}
      vacio={q.vacio === '1'}
      vista={typeof q.vista === 'string' ? q.vista : null}
    />
  );
}
