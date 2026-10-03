import { ModuleGate } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** Módulo «compliance» (0186/0195): apagado, esta pantalla dice que está apagado. */
export default function Layout({ children }: { children: ReactNode }) {
  return <ModuleGate module="compliance">{children}</ModuleGate>;
}
