import { PublicShell } from '@/app/v/[token]/PublicShell';
import { externalBrand } from '@/lib/apps/external-brand';
import { openExternalApp } from '@/lib/apps/external-session';
import { notFound } from 'next/navigation';
import { ClaimForm } from './ClaimForm';

/**
 * El enlace de emparejamiento de un celular de planta (/a/<app>/kiosco?c=…),
 * que crea quien administra desde el editor. Sólo muestra el botón: el código
 * se gasta al tocarlo, no al abrir el enlace.
 */

export const dynamic = 'force-dynamic';

export default async function KioskPairingPage({
  params,
  searchParams,
}: {
  params: Promise<{ app: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const appId = decodeURIComponent((await params).app);
  const { c } = await searchParams;
  const opened = await openExternalApp(appId);
  if (!opened || !c) notFound();
  return (
    <PublicShell brand={await externalBrand(opened.db, opened.app)}>
      <ClaimForm appId={opened.app.id} appName={opened.app.name} code={c} />
    </PublicShell>
  );
}
