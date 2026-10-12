import { notFound } from 'next/navigation';
import { ChatShowcase } from './Showcase';

/**
 * EL CHAT CON MENSAJES LARGOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /chat pide sesión; aquí se pintan los casos que se salían de la burbuja
 * (URLs de Drive, tabla de ocho columnas, código largo, chips con argumentos
 * largos, el aviso de error). Parámetros: `?modo=oscuro`, `?error=limite`,
 * `?error=ninguno`, `?vacio=1` (chat nuevo), `?panel=1` (panel derecho abierto; `fuentes` o `actividad` abren esa pestaña), `?aprobar=1` (tarjeta de aprobación),
 * `?arroba=1` (menú de @ abierto), `?archivos=1` (pestaña «Archivos» del panel con archivos de mentira), `?tarea=1` / `?tarea=necesita` (la franja de una tarea en segundo plano), `?navegador=1` (panel Navegador con una sesión de mentira; `ayuda` pide tus manos).
 */
export const dynamic = 'force-dynamic';

export default async function ChatShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const one = (k: string) => (typeof q[k] === 'string' ? (q[k] as string) : null);
  return (
    <ChatShowcase
      dark={one('modo') === 'oscuro'}
      error={one('error')}
      empty={one('vacio') === '1'}
      panel={one('panel') === '1'}
      tab={
        one('panel') === 'fuentes' ? 'fuentes' : one('panel') === 'actividad' ? 'actividad' : null
      }
      archivos={one('archivos') === '1'}
      tarea={one('tarea') === 'necesita' ? 'necesita' : one('tarea') === '1' ? 'trabajando' : null}
      approve={one('aprobar') === '1'}
      mention={one('arroba') === '1'}
      navegador={
        one('navegador') === 'ayuda' ? 'ayuda' : one('navegador') === '1' ? 'normal' : null
      }
    />
  );
}
