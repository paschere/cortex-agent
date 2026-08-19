'use client';

import { usePanel } from '@/components/panel/PanelHost';
import type { PanelId } from '@/lib/panels/shape';
import { Pin } from 'lucide-react';

/**
 * FIJAR AL LADO, DESDE UNA TARJETA.
 *
 * Una tarjeta RICH en el chat es la respuesta. Este botón no navega a otra
 * pantalla: abre la misma superficie en el marco de al lado, sin desmontar la
 * conversación. El navegador nombra un `panelId` (y a veces una clave de
 * entidad); nunca un `toolId`. Ver `lib/panels/shape.ts`.
 *
 * Dentro de un panel no se dibuja: ya estás al lado. Fuera del shell tampoco,
 * porque no hay marco que abrir.
 */
export function PinSurface({
  surface,
  surfaceKey,
  hidden,
}: {
  surface: PanelId;
  /** Para `client`, el id (o el nombre) de esta organización. Nunca un toolId. */
  surfaceKey?: string;
  /** La tarjeta ya vive dentro del marco. */
  hidden?: boolean;
}) {
  const { open, available, panelId, panelKey } = usePanel();

  if (hidden || !available) return null;
  if (panelId === surface && (surfaceKey ?? null) === panelKey) return null;

  return (
    <button
      type="button"
      onClick={() => open(surface, surfaceKey)}
      aria-label="Fijar al lado"
      title="Fijar al lado, sin salir del chat"
      className="inline-flex items-center gap-1 rounded-pill px-1.5 py-0.5 text-micro font-medium text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
    >
      <Pin className="h-3 w-3" aria-hidden />
      Fijar al lado
    </button>
  );
}
