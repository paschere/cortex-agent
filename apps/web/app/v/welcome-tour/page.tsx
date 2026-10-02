import { notFound } from 'next/navigation';
import { TourFixture } from './TourFixture';

/**
 * EL RECORRIDO DE BIENVENIDA Y LA MARCA EN EL INICIO. SÓLO EN DESARROLLO.
 *
 * Las páginas de adentro redirigen sin sesión, así que aquí se pintan con
 * datos inventados las piezas nuevas del Inicio: la cabecera con el logo, la
 * invitación al recorrido (y el recorrido abierto en un paso), las vistas
 * fijadas con la marca y las miniaturas de /views con la marca. Sin base de
 * datos. Vive bajo `/v` porque ese prefijo ya es público en middleware.ts.
 *
 * Parámetros: `?marca=andina|amarilla|ninguna`, `?paso=1…5` (abre el
 * recorrido en ese paso), `?modo=oscuro`, `?seccion=biblioteca`.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function WelcomeTourFixturePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const step = Number(one('paso'));
  return (
    <TourFixture
      brand={one('marca') ?? 'andina'}
      step={Number.isInteger(step) && step >= 1 ? step - 1 : null}
      dark={one('modo') === 'oscuro'}
      library={one('seccion') === 'biblioteca'}
    />
  );
}
