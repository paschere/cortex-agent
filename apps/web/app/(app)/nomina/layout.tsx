import { ModuleGate } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** /nomina es del módulo «Nómina» (0186, 0194): apagado, sale la pantalla de apagado. */
export default function PayrollLayout({ children }: { children: ReactNode }) {
  return <ModuleGate module="payroll">{children}</ModuleGate>;
}
