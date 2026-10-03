import { requireModulePage } from '@/lib/modules/page';
import type { ReactNode } from 'react';

/** Módulo «crm» (0186/0193): apagado, esta pantalla dice que está apagado. */
export default async function Layout({ children }: { children: ReactNode }) {
  const off = await requireModulePage('crm');
  return off ?? <>{children}</>;
}
