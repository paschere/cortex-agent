import { ModuleGate } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** Módulo «contracts» (0186/0195): apagado, esta pantalla y sus subpáginas dicen que está apagado. */
export default function Layout({ children }: { children: ReactNode }) {
  return <ModuleGate module="contracts">{children}</ModuleGate>;
}
