import { ModuleGate } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** /presupuesto es del módulo «Presupuesto y pronósticos» (0186). */
export default function BudgetLayout({ children }: { children: ReactNode }) {
  return <ModuleGate module="budget">{children}</ModuleGate>;
}
