import { LegalPage } from '@/components/legal/LegalDocument';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Términos y condiciones',
  description: 'Las reglas de uso de Cortex.',
};

export default function Page() {
  return <LegalPage slug="terminos" />;
}
