import { notFound } from 'next/navigation';
import { HojaShowcase } from './HojaShowcase';
import { CLIENTES_DEMO, HOJA_SUBTITLE, HOJA_TITLE, TARIFAS_DEMO, hojaView } from './fixture';

/**
 * EL ESCAPARATE DE LA HOJA. SÓLO EN DESARROLLO.
 *
 * El bloque «sheet» con una hoja de prefacturación inventada (manifiestos y
 * guías en dos niveles), calculada con `computeView` y pintada con el lienzo
 * real de las vistas, sin sesión ni base. Parámetros: `?modo=oscuro`,
 * `?marca=ninguna`. En producción responde 404.
 */
export const dynamic = 'force-dynamic';

export default async function HojaShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  return (
    <HojaShowcase
      view={hojaView()}
      title={HOJA_TITLE}
      subtitle={HOJA_SUBTITLE}
      dark={one('modo') === 'oscuro'}
      brand={one('marca') ?? 'andina'}
      options={{
        cliente: CLIENTES_DEMO.map((c) => ({ id: c.id, label: c.nombre, detail: `NIT ${c.nit}` })),
        tarifa: TARIFAS_DEMO.map((t) => ({ id: t.id, label: t.nombre, detail: `${t.tarifa} USD/kg · ${t.notas}` })),
      }}
    />
  );
}
