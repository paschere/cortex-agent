import { ModuleGate } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** Módulo «fleet» (0186): apagado, esta pantalla y sus subpáginas dicen que está apagado. */
export default function Layout({ children }: { children: ReactNode }) {
  return <ModuleGate module="fleet">{children}</ModuleGate>;
}
