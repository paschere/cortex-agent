import { notFound } from 'next/navigation';
import { ChartsShowcase } from './Showcase';

/**
 * EL KIT DE GRÁFICOS, CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * Cada tipo de gráfico de `components/charts` con cifras realistas, sus
 * estados vacíos (sin datos, un solo punto, todo en cero) y el claro/oscuro
 * (`?tema=oscuro` o el botón de arriba). En producción responde 404.
 */
export const dynamic = 'force-dynamic';

export default async function ChartsShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  return <ChartsShowcase dark={q.tema === 'oscuro'} />;
}
