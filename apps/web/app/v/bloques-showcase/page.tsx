import { notFound } from 'next/navigation';
import { Showcase } from './Showcase';
import { SECTIONS, buildView } from './sections';

/**
 * EL ESCAPARATE DEL DISEÑO DE BLOQUES. SÓLO EN DESARROLLO.
 *
 * Cada bloque con TODAS sus variantes, superficies, tamaños, tonos y énfasis
 * (`design` de cada bloque), con la fixture de /v/views-showcase: sin sesión ni
 * base. Parámetros: `?seccion=superficies|tamanos|metric|cards|table|board|
 * chart|detail|calendar|gallery|progress|links|text`, `?modo=oscuro`,
 * `?marca=andina|amarilla|ninguna`, `?diseno=operario|tv`.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function BloquesShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  return (
    <Showcase
      section={one('seccion') ?? 'superficies'}
      sections={SECTIONS}
      view={buildView(one('seccion') ?? 'superficies', one('diseno'))}
      dark={one('modo') === 'oscuro'}
      brand={one('marca') ?? 'andina'}
      layout={one('diseno')}
    />
  );
}
