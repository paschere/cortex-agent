import { notFound } from 'next/navigation';
import { MandoFixture } from './Fixture';

/**
 * EL CENTRO DE MANDO CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /overview pide sesión y en local redirige al login; aquí se pintan los
 * mismos componentes (FounderOverview, la ficha de una empresa) con cuatro
 * empresas de mentira —una al día, una con cartera vencida, una con procesos
 * fallando y una recién creada— para mirarlos en claro y en oscuro, en
 * escritorio y en teléfono, sin sesión ni base de datos. Vive bajo `/v` por la
 * misma razón que /v/views-showcase: el prefijo ya es público en middleware.ts
 * y un segmento estático gana a `/v/[token]`.
 *
 * Parámetros: `?modo=oscuro`, `?vista=tabla`, `?cargando=1` (las cifras de
 * negocio nunca llegan: el esqueleto), `?ficha=1` (la ficha de una empresa) y
 * `?plan=1` (Plan y uso abierto).
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function CentroDeMandoFixturePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  return (
    <MandoFixture
      dark={one('modo') === 'oscuro'}
      table={one('vista') === 'tabla'}
      loading={one('cargando') === '1'}
      detail={one('ficha') === '1'}
      planOpen={one('plan') === '1'}
    />
  );
}
