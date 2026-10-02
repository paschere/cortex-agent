import { notFound } from 'next/navigation';
import { PendientesFixture } from './Showcase';
import { fixtureActions, fixtureWaiting, fixtureWeekly } from './data';

/**
 * PERSEGUIR LO PENDIENTE, CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /actions, /dashboard y el pulso piden sesión; aquí se pintan los mismos
 * componentes con filas inventadas y las funciones de verdad (ver data.ts).
 * Vive bajo `/v` por la misma razón que /v/equipo-showcase: el prefijo ya es
 * público y un segmento estático gana a `/v/[token]`.
 *
 * Parámetros: `?pantalla=acciones|semana|espera`, `?modo=oscuro`.
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function PendientesShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const raw = typeof q.pantalla === 'string' ? q.pantalla : 'acciones';
  const pantalla = raw === 'semana' || raw === 'espera' ? raw : 'acciones';
  return (
    <PendientesFixture
      dark={q.modo === 'oscuro'}
      pantalla={pantalla}
      actions={fixtureActions()}
      weekly={fixtureWeekly()}
      waiting={fixtureWaiting()}
    />
  );
}
