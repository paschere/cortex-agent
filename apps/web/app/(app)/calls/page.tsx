import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { PhoneCall } from 'lucide-react';
import { CallsSurface } from './_components/CallsSurface';

export const dynamic = 'force-dynamic';

/**
 * Llamadas — las reuniones en las que Cortex está metido ahora.
 *
 * QUÉ ES ESTA PANTALLA. Cuando alguien le dice a Cortex «métete a este Meet»,
 * el bot entra y escucha. Antes, la sala en vivo era una tarjeta dentro del
 * chat: servía cinco minutos y después se perdía scroll arriba mientras la
 * reunión seguía una hora. Aquí la sala tiene pantalla propia y fija en el
 * menú, debajo de Chat: se abre, se deja a la vista, y desde el chat solo
 * queda un aviso corto que apunta aquí.
 *
 * Lo que se ve es lo de AHORA: el bot guarda las sesiones en memoria y las
 * olvida poco después de que terminan. Lo que ya pasó queda como transcript
 * guardado, y eso se pregunta en el chat («¿qué hablamos ayer con Acme?»).
 */
export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string }>;
}) {
  await requireSession();
  const { session } = await searchParams;

  return (
    <>
      <PageHeader
        title="Llamadas"
        subtitle="Las reuniones en las que Cortex está ahora, y las que ya escuchó: quién estaba, lo que se dijo y un chat para preguntar."
        icon={<PhoneCall className="h-5 w-5" />}
      />
      <CallsSurface initialSession={session ?? null} />
    </>
  );
}
