import { ModuleGate } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** Módulo «whatsapp_service» (0186): apagado, esta pantalla y sus subpáginas dicen que está apagado. */
export default function Layout({ children }: { children: ReactNode }) {
  return <ModuleGate module="whatsapp_service">{children}</ModuleGate>;
}
