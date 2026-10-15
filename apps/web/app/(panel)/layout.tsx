import { EmbedChrome } from '@/components/apps/panel/EmbedChrome';
import { requireSession } from '@/lib/session';
import type { ReactNode } from 'react';

/**
 * El marco SIN espacio de trabajo: lo que se abre dentro del iframe del panel de
 * la app al lado del chat. Sin rail ni barra superior; sólo el contenido, con
 * la paleta del espacio de trabajo. La sesión se exige igual que en el resto.
 */
export const dynamic = 'force-dynamic';

export default async function PanelLayout({ children }: { children: ReactNode }) {
  await requireSession();
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <EmbedChrome />
      {children}
    </div>
  );
}
