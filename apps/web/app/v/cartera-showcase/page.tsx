import { notFound } from 'next/navigation';
import { CarteraShowcase } from './Showcase';
import { fixtureModel } from './data';

/**
 * CARTERA CON DATOS COMO LOS DE SIIGO. SÓLO EN DESARROLLO.
 *
 * /payments pide sesión y base de datos; aquí se pintan los mismos componentes
 * con la semilla de data.ts, pasada por el mismo motor (`buildCartera`). Vive
 * bajo `/v` porque el prefijo ya es público en middleware.ts.
 *
 * Parámetros: `?modo=oscuro`, `?plazo=30` (el supuesto de plazo), `?vacia=1`
 * (empresa sin facturas), `?cuadre=1` (con saldos por tercero de la contabilidad).
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function CarteraShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const plazo = Number(one('plazo')) > 0 ? Number(one('plazo')) : 30;
  return (
    <CarteraShowcase
      dark={one('modo') === 'oscuro'}
      plazo={plazo}
      model={fixtureModel({ plazo, empty: one('vacia') === '1', cuadre: one('cuadre') === '1' })}
    />
  );
}
