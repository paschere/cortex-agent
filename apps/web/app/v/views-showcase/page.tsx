import { notFound } from 'next/navigation';
import { Showcase } from './Showcase';
import { SCREEN_KINDS, SCREEN_TITLES, type ScreenKind, screensView } from './screens-fixture';

/**
 * EL ESCAPARATE DE LAS VISTAS. SÓLO EN DESARROLLO.
 *
 * Pinta una vista inventada con un bloque de cada tipo (fixture.ts) dentro del
 * mismo marco que el enlace público, con una marca de ejemplo, para mirar el
 * lienzo entero en claro y en oscuro, en escritorio y en teléfono, sin sesión
 * y sin base de datos. Vive junto a /v/visual-fixture por la misma razón: `/v`
 * ya es público en middleware.ts y un segmento estático gana a `/v/[token]`.
 *
 * Parámetros: `?modo=oscuro`, `?marca=amarilla|ninguna`, `?paginas=1`,
 * `?vacia=1`, `?pantalla=detalle|tarjetas|agenda|tv` (los tipos de pantalla
 * nuevos, calculados de verdad; `&fila=<id>` abre un registro), `?portada=1`, `?lugar=app` (como se ve adentro, sin la barra pública), `?panel=marca` (la pantalla
 * de la marca de /company) y `?panel=cargando` (el esqueleto).
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function ViewsShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const kind = one('pantalla');
  const screen = SCREEN_KINDS.includes(kind as ScreenKind) ? (kind as ScreenKind) : null;
  return (
    <Showcase
      screen={
        screen
          ? {
              kind: screen,
              ...SCREEN_TITLES[screen],
              view: screensView(screen, { fila: one('fila'), d: one('d') }),
            }
          : null
      }
      dark={one('modo') === 'oscuro'}
      brand={one('marca') ?? 'andina'}
      pages={one('paginas') === '1'}
      empty={one('vacia') === '1'}
      hero={one('portada') === '1'}
      inApp={one('lugar') === 'app'}
      panel={one('panel')}
      layout={one('diseno')}
      look={one('estilo')}
    />
  );
}
