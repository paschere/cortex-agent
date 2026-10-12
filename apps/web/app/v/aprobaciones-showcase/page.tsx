import { notFound } from 'next/navigation';
import { ApprovalsShowcase } from './Showcase';

/**
 * LAS TARJETAS DE APROBACIÓN CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * La tarjeta «Aprobar el plan», la tarjeta de una acción con su antes → después,
 * un correo (irreversible) y la barra «Aprobar las N». Parámetros: `?modo=oscuro`,
 * `?plan=aprobado` (el plan ya aprobado, con «Detener el plan»).
 */
export const dynamic = 'force-dynamic';

export default async function ApprovalsShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  return <ApprovalsShowcase dark={one('modo') === 'oscuro'} granted={one('plan') === 'aprobado'} />;
}
