import { PublicShell } from '@/app/v/[token]/PublicShell';
import { readBranding, toViewBrand } from '@/lib/branding/store';
import { openPublicPqrsForm } from '@/lib/compliance/public';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PqrsPublicForm } from './PqrsPublicForm';

/**
 * EL FORMULARIO PÚBLICO DE PQRS DE UNA EMPRESA (migración 0195).
 *
 * Fuera del shell de la app, con la marca de la empresa, igual que
 * /cotizacion/<token>. Quien escribe recibe su radicado y la fecha límite de
 * respuesta. El token es la credencial (lib/compliance/public.ts).
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Peticiones, quejas y reclamos',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function PublicPqrsPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const opened = await openPublicPqrsForm(token);
  if (!opened) notFound();
  const branding = await readBranding(opened.db);
  const brand = toViewBrand(
    branding,
    opened.organizationName,
    (v) => `/api/pqrs/public/logo?token=${encodeURIComponent(token)}&v=${v}`,
  );
  return (
    <PublicShell brand={brand}>
      <PqrsPublicForm
        token={token}
        companyName={brand.name}
        policyUrl={opened.profile.privacyPolicyUrl}
      />
    </PublicShell>
  );
}
