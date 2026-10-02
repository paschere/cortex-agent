import { readDashboardParams } from '@/lib/finance/dashboard-shape';
import { notFound } from 'next/navigation';
import { FinanzasFixture } from './Showcase';
import { fixtureDashboard } from './data';

/**
 * EL PANEL DE FINANZAS CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /finance pide sesión y en local redirige al login; aquí se pinta el mismo
 * panel (components/finance) con Transportes del Valle, la empresa de prueba
 * de la proyección, calculada con el motor de verdad. Vive bajo `/v` por la
 * misma razón que /v/views-showcase: el prefijo ya es público en middleware.ts
 * y un segmento estático gana a `/v/[token]`.
 *
 * Parámetros: `?modo=oscuro`, `?rol=miembro` (nómina confidencial, sin
 * botones de admin), `?vacia=1` (empresa nueva), `?falla=1` (dos lecturas
 * caídas: «sin dato»), y los mismos del panel: `?escenario=esc-nexa`,
 * `?estimadas=1`, `?minimo=…`.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function FinanzasShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const params = readDashboardParams(q);
  const keep = new URLSearchParams();
  for (const k of ['modo', 'rol', 'vacia', 'falla']) {
    const v = one(k);
    if (v) keep.set(k, v);
  }
  const self = `/v/finanzas-showcase${keep.size ? `?${keep}` : ''}`;
  const data = fixtureDashboard({
    isAdmin: one('rol') !== 'miembro',
    empty: one('vacia') === '1',
    failing: one('falla') === '1',
    ...params,
  });
  return <FinanzasFixture dark={one('modo') === 'oscuro'} data={data} self={self} />;
}
