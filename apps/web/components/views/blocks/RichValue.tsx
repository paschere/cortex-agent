'use client';

import type { ComputedDetail } from '@cortex/agent-tools';
import { mapsUrl } from '@cortex/agent-tools/src/trackers/schema';
import { MapPin } from 'lucide-react';
import { FileValue } from '../inputs/FileValue';

/**
 * Un valor de tabla o tarjeta que no es texto: la foto o el archivo de un campo
 * `file` (miniatura que abre grande, `FileValue`) y la ubicación (enlace al
 * mapa). El cálculo entrega el valor crudo junto al texto; sin él, o sin una
 * dirección de mapa válida, se pinta el texto de siempre.
 */
export function RichValue({
  kind,
  raw,
  text,
  size = 36,
}: {
  kind?: ComputedDetail['kind'];
  raw?: string | number | null;
  text: string;
  size?: number;
}) {
  if (kind === 'file' && raw !== undefined && raw !== null && raw !== '')
    return <FileValue value={String(raw)} size={size} />;
  if (kind === 'location' && raw !== undefined && raw !== null && raw !== '') {
    const href = mapsUrl(String(raw));
    if (href)
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-primary hover:underline"
        >
          <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Ver en el mapa
        </a>
      );
  }
  return <>{text}</>;
}
