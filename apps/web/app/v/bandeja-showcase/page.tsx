import { notFound } from 'next/navigation';
import { BandejaShowcase } from './Showcase';

/**
 * LA BANDEJA DE ARCHIVOS CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /feed pide sesión; aquí se pinta el mismo `Feed` con un `FeedClient` en
 * memoria: una docena de entradas de una transportadora (Excel de despachos,
 * el PDF de un contrato, la captura de una hoja de Google, una API del ERP,
 * una nota), en todos los estados. Subir, clasificar, guardar y borrar
 * funcionan contra la memoria del navegador.
 *
 * Parámetros: `?modo=oscuro`, `?bandeja=vacia`, `?abrir=1` (con la vista
 * previa de la hoja abierta), `?vista=fuentes` y `?mode=url|text|api`.
 * En producción responde 404.
 */
export const dynamic = 'force-dynamic';

export default async function BandejaShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const mode = q.mode === 'url' || q.mode === 'text' || q.mode === 'api' ? q.mode : 'file';
  return (
    <BandejaShowcase
      dark={q.modo === 'oscuro'}
      empty={q.bandeja === 'vacia'}
      open={q.abrir === '1'}
      view={q.vista === 'fuentes' ? 'sources' : 'entries'}
      mode={mode}
    />
  );
}
