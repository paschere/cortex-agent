import { ModuleGate } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** /sst es del módulo «Seguridad y salud en el trabajo» (0186, 0194). */
export default function SstLayout({ children }: { children: ReactNode }) {
  return <ModuleGate module="sst">{children}</ModuleGate>;
}
