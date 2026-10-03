import { LegalPage } from '@/components/legal/LegalDocument';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Política de privacidad',
  description:
    'Qué datos guarda Cortex, para qué, con quién los comparte y cómo descargarlos o borrarlos.',
};

export default function Page() {
  return <LegalPage slug="privacidad" />;
}
