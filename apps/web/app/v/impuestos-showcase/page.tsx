import { notFound } from 'next/navigation';
import { TaxFixture } from './Showcase';
import { certificatesFixture, draftFixture, exogenaFixture, fixtureData } from './data';

/**
 * IMPUESTOS CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /impuestos pide sesión; aquí se pinta la misma pantalla (components/tax)
 * con Transportes Andinos y el motor de verdad (fechas DIAN 2026). Vive bajo
 * `/v` por la misma razón que /v/piloto-showcase.
 *
 * Parámetros: `?vacio=1` (sin perfil todavía), `?modo=oscuro`.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function ImpuestosShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const { data, links } = fixtureData({ empty: one('vacio') === '1' });
  const vista = one('vista');
  // 0197: `?vista=borrador` (IVA), `borrador-retencion`, `certificados`, `exogena`.
  return (
    <TaxFixture
      dark={one('modo') === 'oscuro'}
      data={data}
      links={links}
      draft={
        vista === 'borrador'
          ? draftFixture('iva')
          : vista === 'borrador-retencion'
            ? draftFixture('retencion')
            : null
      }
      certificates={vista === 'certificados' ? certificatesFixture() : null}
      exogena={vista === 'exogena' ? exogenaFixture() : null}
    />
  );
}
