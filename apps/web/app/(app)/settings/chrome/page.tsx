import { PageHeader } from '@/components/ui/page-header';
import { Plug } from 'lucide-react';
import { ChromePanel } from './ChromePanel';
import { readChromeState } from './actions';

export const dynamic = 'force-dynamic';

export default async function ChromePage() {
  const initial = await readChromeState();
  return (
    <>
      <PageHeader
        title="Cortex en tu Chrome"
        subtitle="Para lo que solo se puede hacer con tu sesión abierta —el portal del banco, la DIAN—, Cortex trabaja en tu propio Chrome. Tú lo emparejas, tú decides en qué sitios, y puedes detenerlo o revocarlo cuando quieras."
        icon={<Plug className="h-5 w-5" />}
      />
      <ChromePanel initial={initial} />
    </>
  );
}
