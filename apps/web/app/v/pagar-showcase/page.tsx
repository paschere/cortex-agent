import { notFound } from 'next/navigation';
import { PagarFixture } from './Showcase';
import { fixture } from './data';

/**
 * POR PAGAR CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /pagar pide sesión; aquí se pintan los mismos componentes
 * (components/payables + la grilla compartida) con las facturas de proveedor
 * de Transportes del Valle, revisadas con el motor de verdad. Vive bajo `/v`
 * porque el prefijo ya es público en middleware.ts.
 *
 * Parámetros: `?tab=programa|proveedores`, `?modo=oscuro`, `?falla=1` (sin
 * proyección de caja), `?vacia=1` (empresa sin facturas).
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function PagarShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const tab =
    one('tab') === 'programa'
      ? 'programa'
      : one('tab') === 'proveedores'
        ? 'proveedores'
        : 'bandeja';
  return (
    <PagarFixture
      dark={one('modo') === 'oscuro'}
      tab={tab}
      data={fixture({ empty: one('vacia') === '1', failing: one('falla') === '1' })}
    />
  );
}
