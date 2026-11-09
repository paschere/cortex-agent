import { CodeFrameHost } from '@/components/apps/CodeFrameHost';
import type { ReactNode } from 'react';

/**
 * El layout de una app de miembro (/apps/<app>/…): no se desmonta al pasar de una pantalla a
 * otra, así que aquí viven los iframes de las últimas pantallas con código visitadas (ocultos,
 * montados): volver a una es instantáneo. Ver `CodeFrameHost`.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  return <CodeFrameHost>{children}</CodeFrameHost>;
}
