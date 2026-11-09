import { CodeFrameHost } from '@/components/apps/CodeFrameHost';
import type { ReactNode } from 'react';

/** Lo mismo que /apps/<app>/layout.tsx, para el panel de la app al lado del chat. */
export default function PanelAppViewLayout({ children }: { children: ReactNode }) {
  return <CodeFrameHost>{children}</CodeFrameHost>;
}
