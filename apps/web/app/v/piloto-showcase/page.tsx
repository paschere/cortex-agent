import { notFound } from 'next/navigation';
import { PilotoFixture } from './Showcase';
import { fixtureData } from './data';

/**
 * EL PILOTO AUTOMÁTICO CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /piloto pide sesión; aquí se pintan las mismas pantallas
 * (components/autopilot) con Transportes Andinos
 * (packages/agent-tools/src/autopilot/autopilot.fixtures.ts), planeada con
 * los recolectores y la política de verdad. Vive bajo `/v` por la misma razón
 * que /v/equipo-showcase: el prefijo ya es público y un segmento estático gana
 * a `/v/[token]`.
 *
 * Parámetros: `?pantalla=inicio|corrida|ensayo|tarjeta`, `?apagado=1`,
 * `?vacio=1` (encendido, todavía no corrió hoy), `?modo=oscuro`.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function PilotoShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  const raw = one('pantalla');
  const pantalla =
    raw === 'corrida' || raw === 'tarjeta' || raw === 'ensayo' ? raw : ('inicio' as const);
  const data = fixtureData({ off: one('apagado') === '1', empty: one('vacio') === '1' });
  return <PilotoFixture dark={one('modo') === 'oscuro'} pantalla={pantalla} data={data} />;
}
