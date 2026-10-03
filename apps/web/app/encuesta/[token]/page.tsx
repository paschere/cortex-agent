import { PublicShell } from '@/app/v/[token]/PublicShell';
import { readBranding, toViewBrand } from '@/lib/branding/store';
import { openPublicSurvey } from '@/lib/crm/public';
import { listNpsResponses, markNpsSurveyOpened } from '@cortex/agent-tools';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SurveyForm } from './SurveyForm';

/**
 * LA ENCUESTA DE SATISFACCIÓN, VISTA POR EL CLIENTE (migración 0193).
 *
 * Fuera del shell de la app a propósito, igual que /cotizacion/<token>: quien
 * abre esto es el cliente y ve la marca de la empresa. El token es la
 * credencial (lib/crm/public.ts); uno que no abre es 404 sin explicación.
 * Abrirla deja la hora de la primera apertura.
 */

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Encuesta',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default async function PublicSurveyPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const opened = await openPublicSurvey(token);
  if (!opened) notFound();
  const { survey, db, organizationName } = opened;
  const [branding, answered] = await Promise.all([
    readBranding(db),
    survey.status === 'respondida'
      ? listNpsResponses(db, { limit: 1, surveyId: survey.id }).catch(() => [])
      : Promise.resolve([]),
  ]);
  const brand = toViewBrand(
    branding,
    organizationName,
    (v) => `/api/crm/public/logo?token=${encodeURIComponent(token)}&v=${v}`,
  );
  void markNpsSurveyOpened(db, survey).catch(() => undefined);
  const first = answered[0];
  return (
    <PublicShell brand={brand}>
      <SurveyForm
        token={token}
        companyName={brand.name}
        contactName={survey.contact_name}
        answered={first ? { score: first.score, comment: first.comment } : null}
      />
    </PublicShell>
  );
}
