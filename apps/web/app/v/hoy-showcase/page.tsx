import { notFound } from 'next/navigation';
import { HoyFixture } from './Showcase';
import { hoyFixture } from './data';

/**
 * «HOY» CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /piloto pide sesión; aquí se pinta la misma pantalla (components/hoy) con
 * Transportes Andinos (la caja) y la cartera de la semilla de /v/cartera-showcase: 16 meses de facturas, pagos y nómina, y una proyección
 * de diez semanas. Parámetros: `?sinplata=1` (módulo de finanzas apagado),
 * `?apuro=1` (caja bajo el mínimo), `?vacio=1` (nada que decidir),
 * `?equipo=1` (quien mira no administra), `?sinoperacion=1` (sin vuelos ni DIAN),
 * `?modo=oscuro`. En producción responde 404.
 */
export const dynamic = 'force-dynamic';

export default async function HoyShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const on = (k: string) => q[k] === '1';
  return (
    <HoyFixture
      dark={q.modo === 'oscuro'}
      view={hoyFixture({
        sinPlata: on('sinplata'),
        apuro: on('apuro'),
        vacio: on('vacio'),
        equipo: on('equipo'),
        sinOperacion: on('sinoperacion'),
      })}
    />
  );
}
