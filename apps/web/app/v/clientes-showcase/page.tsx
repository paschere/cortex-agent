import { notFound } from 'next/navigation';
import { ClientesFixture } from './Showcase';
import { TEAM, TODAY, fixture360, fixtureList, fixtureReview } from './data';

/**
 * CLIENTES CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /clients pide sesión; aquí se pintan los mismos componentes
 * (components/clients + la grilla compartida) con los clientes de Transportes
 * del Valle, calculados con el motor de verdad (clients/hub.ts). Vive bajo
 * `/v` porque el prefijo ya es público en middleware.ts y un segmento estático
 * gana a `/v/[token]`.
 *
 * Parámetros: `?pantalla=confirmar|ficha`, `?modo=oscuro`, `?falla=1` (la
 * plata y otras lecturas caídas: «sin dato»), `?vacia=1` (empresa sin
 * clientes).
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function ClientesShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const pantalla =
    one('pantalla') === 'confirmar' ? 'confirmar' : one('pantalla') === 'ficha' ? 'ficha' : 'lista';
  const failing = one('falla') === '1';
  return (
    <ClientesFixture
      dark={one('modo') === 'oscuro'}
      pantalla={pantalla}
      list={fixtureList({ failing, empty: one('vacia') === '1' })}
      ficha={fixture360({ failing })}
      review={fixtureReview({ failing })}
      team={TEAM}
      today={TODAY}
    />
  );
}
