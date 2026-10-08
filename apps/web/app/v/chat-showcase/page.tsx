import { notFound } from 'next/navigation';
import { ChatShowcase } from './Showcase';

/**
 * EL CHAT CON MENSAJES LARGOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /chat pide sesión; aquí se pintan los casos que se salían de la burbuja
 * (URLs de Drive, tabla de ocho columnas, código largo, chips con argumentos
 * largos, el aviso de error). Parámetros: `?modo=oscuro`, `?error=limite`,
 * `?error=ninguno`.
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
  return <ChatShowcase dark={one('modo') === 'oscuro'} error={one('error')} />;
}
