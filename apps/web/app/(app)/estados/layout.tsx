import { ModuleGate } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** /estados es del módulo «Estados financieros» (0186): apagado, la pantalla de módulo apagado. */
export default function StatementsLayout({ children }: { children: ReactNode }) {
  return <ModuleGate module="statements">{children}</ModuleGate>;
}
