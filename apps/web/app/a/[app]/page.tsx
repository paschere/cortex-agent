import { PublicShell } from '@/app/v/[token]/PublicShell';
import { KioskScreen } from '@/components/apps/KioskScreen';
import { openApp } from '@/lib/apps/access';
import { externalBrand } from '@/lib/apps/external-brand';
import { openExternalApp } from '@/lib/apps/external-session';
import { getKioskDevice } from '@/lib/apps/kiosk-session';
import { listKioskPeople } from '@cortex/agent-tools';
import { screenFor } from '@cortex/agent-tools';
import { notFound, redirect } from 'next/navigation';
import { EntryForm } from './EntryForm';

/**
 * La puerta de una aplicación para quien no es del equipo (/a/<app>). Con
 * sesión (de Cortex o la cookie de la app) lleva a su primera pantalla; sin
 * ella, la pantalla de entrada con la marca de la empresa (o, en un celular de
 * planta en modo kiosco, la lista de nombres con PIN). Una app que no
 * existe o no está publicada es 404 sin explicar más.
 */

export const dynamic = 'force-dynamic';

export default async function AppEntryPage({ params }: { params: Promise<{ app: string }> }) {
  const appId = decodeURIComponent((await params).app);
  const opened = await openExternalApp(appId);
  if (!opened) notFound();
  const session = await openApp(opened.app.id);
  if (session) {
    const screen = screenFor(session.access, null);
    if (screen) redirect(`/a/${opened.app.id}/${screen.slug}`);
    return (
      <PublicShell brand={await externalBrand(opened.db, opened.app)}>
        <p className="mx-auto mt-16 max-w-sm text-center text-sm text-ink-muted">
          Tu rol todavía no tiene pantallas en esta aplicación. Pídele a quien te invitó que lo
          revise.
        </p>
      </PublicShell>
    );
  }
  // Un celular dejado en modo kiosco no pide correo: lista de nombres y PIN.
  const kiosk = await getKioskDevice(opened.app.id);
  if (kiosk)
    return (
      <PublicShell brand={await externalBrand(opened.db, opened.app)}>
        <KioskScreen
          appId={opened.app.id}
          appName={opened.app.name}
          deviceName={kiosk.device.name}
          people={await listKioskPeople(opened.db, opened.app.id)}
        />
      </PublicShell>
    );
  return (
    <PublicShell brand={await externalBrand(opened.db, opened.app)}>
      <EntryForm appId={opened.app.id} appName={opened.app.name} />
    </PublicShell>
  );
}
