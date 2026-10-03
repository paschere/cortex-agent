'use client';

import { ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

/**
 * «‹ Ajustes»: la salida de vuelta al recibidor desde cada subpantalla
 * (voz, memoria, módulos, privacidad, aprendizaje del correo). En /settings
 * mismo no se pinta. Conserva el espacio de trabajo en la dirección.
 */
export function SettingsCrumb() {
  const pathname = usePathname();
  const params = useSearchParams();
  if (pathname === '/settings') return null;
  const workspace = params.get('workspace');
  const href = workspace ? `/settings?workspace=${encodeURIComponent(workspace)}` : '/settings';
  return (
    <Link
      href={href}
      className="mb-4 inline-flex items-center gap-1 rounded-pill px-2 py-1 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
    >
      <ChevronLeft className="h-4 w-4" aria-hidden />
      Ajustes
    </Link>
  );
}
