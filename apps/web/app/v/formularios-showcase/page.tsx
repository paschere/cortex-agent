import { notFound } from 'next/navigation';
import { FormulariosShowcase } from './FormulariosShowcase';

/**
 * EL ESCAPARATE DE LOS FORMULARIOS DE VISTA. SÓLO EN DESARROLLO.
 *
 * Pinta un formulario completo —relaciones con «+ Agregar», dinero en pesos,
 * fórmula, lista de ítems con cantidad, fotos, lectura de un documento— contra
 * un servidor de mentira (sin sesión ni base), para mirarlo en claro y oscuro,
 * en teléfono y escritorio, y probar la cola sin conexión con el modo offline
 * del navegador. Vive bajo `/v` por la misma razón que /v/views-showcase.
 *
 * Parámetros: `?modo=oscuro`, `?diseno=operario` (controles grandes), `?pasos=1`
 * (por pasos con resumen), `?escaner=0` (sin «Tomar foto del documento»),
 * `?escanerfalla=1` (la lectura responde con error), `?lineas=0` (sin ítems).
 *
 * En producción responde 404: no es una página del producto.
 */
export const dynamic = 'force-dynamic';

export default async function FormulariosShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  return (
    <FormulariosShowcase
      dark={one('modo') === 'oscuro'}
      operator={one('diseno') === 'operario'}
      steps={one('pasos') === '1'}
      scan={one('escaner') !== '0'}
      scanFails={one('escanerfalla') === '1'}
      lines={one('lineas') !== '0'}
    />
  );
}
