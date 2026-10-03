import { ModuleGate } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** /cierre es del módulo «Cierre contable» (0186, 0192): apagado, dice que está apagado. */
export default function CierreLayout({ children }: { children: ReactNode }) {
  return <ModuleGate module="accounting_close">{children}</ModuleGate>;
}
