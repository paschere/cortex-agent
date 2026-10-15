import { PageHeader } from '@/components/ui/page-header';
import { Plug } from 'lucide-react';
import { notFound } from 'next/navigation';
import { ChromePanel } from '../../(app)/settings/chrome/ChromePanel';

/**
 * «CORTEX EN TU CHROME» (AJUSTES) CON DATOS INVENTADOS. SÓLO EN DESARROLLO.
 *
 * /settings/chrome pide sesión; aquí se pinta con dos Chrome (uno conectado,
 * otro no) y sitios decididos. `?modo=oscuro`, `?vacio=1` (sin dispositivos).
 */
export const dynamic = 'force-dynamic';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const later = (ms: number) => new Date(Date.now() + ms).toISOString();

export default async function ChromeShowcasePage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === 'production') notFound();
  const q = await searchParams;
  const dark = q.modo === 'oscuro';
  const empty = q.vacio === '1';
  return (
    <div className={dark ? 'dark' : undefined} data-theme={dark ? 'dark' : 'light'}>
      <div className="min-h-screen bg-canvas px-4 py-6 text-ink sm:px-8">
        <PageHeader
          title="Cortex en tu Chrome"
          subtitle="Para lo que solo se puede hacer con tu sesión abierta —el portal del banco, la DIAN—, Cortex trabaja en tu propio Chrome. Tú lo emparejas, tú decides en qué sitios, y puedes detenerlo o revocarlo cuando quieras."
          icon={<Plug className="h-5 w-5" />}
        />
        <ChromePanel
          initial={
            empty
              ? { devices: [], sites: [] }
              : {
                  devices: [
                    {
                      id: 'd1',
                      name: 'Chrome en macOS',
                      online: true,
                      lastSeenAt: ago(5_000),
                      extVersion: '0.1.0',
                      expiresAt: later(80 * 86_400_000),
                      revoked: false,
                    },
                    {
                      id: 'd2',
                      name: 'Portátil de la oficina',
                      online: false,
                      lastSeenAt: ago(3 * 86_400_000),
                      extVersion: '0.1.0',
                      expiresAt: later(20 * 86_400_000),
                      revoked: false,
                    },
                  ],
                  sites: [
                    { id: 's1', deviceId: 'd1', site: 'bancolombia.com', decision: 'always' },
                    { id: 's2', deviceId: 'd1', site: 'dian.gov.co', decision: 'always' },
                    { id: 's3', deviceId: 'd2', site: 'casino-raro.com', decision: 'never' },
                  ],
                }
          }
        />
      </div>
    </div>
  );
}
