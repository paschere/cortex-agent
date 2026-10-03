import { LegalPage } from '@/components/legal/LegalDocument';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Política de tratamiento de datos personales',
  description:
    'Política de tratamiento de datos personales de Cortex conforme a la Ley 1581 de 2012: finalidades, derechos del titular, consultas y reclamos.',
};

export default function Page() {
  return <LegalPage slug="tratamiento-de-datos" />;
}
