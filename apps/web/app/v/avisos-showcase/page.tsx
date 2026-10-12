import { parsePreferences } from '@/lib/notifications/preferences-shape';
import { notFound } from 'next/navigation';
import { AvisosFixture } from './Showcase';

/**
 * AJUSTES › AVISOS CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 * `?modo=oscuro` para el tema oscuro; `?silencio=1` con horas de silencio.
 */
export const dynamic = 'force-dynamic';

export default async function AvisosShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const initial = parsePreferences({
    channels: { briefing: { email: false }, anomalies: { push: false }, views: { bell: false } },
    quiet_enabled: q.silencio === '1',
    quiet_start: '22:00',
    quiet_end: '07:00',
  });
  return <AvisosFixture initial={initial} dark={q.modo === 'oscuro'} />;
}
