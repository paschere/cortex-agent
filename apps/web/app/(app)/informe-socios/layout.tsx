import { ModuleGate } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** /informe-socios es del módulo «Informe para socios» (0186), con sus subpáginas. */
export default function BoardLayout({ children }: { children: ReactNode }) {
  return <ModuleGate module="board_report">{children}</ModuleGate>;
}
