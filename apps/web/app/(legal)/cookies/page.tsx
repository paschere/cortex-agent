import { LegalPage } from '@/components/legal/LegalDocument';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Aviso de cookies',
  description: 'Cortex sólo usa cookies necesarias: sin analítica ni publicidad.',
};

export default function Page() {
  return <LegalPage slug="cookies" />;
}
