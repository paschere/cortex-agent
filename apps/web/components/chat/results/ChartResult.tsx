'use client';

import { ChartCard } from '../ChartCard';
import type { ResultViewProps } from './registry';

/**
 * `reports.chart` — el gráfico, pedido por su id.
 *
 * La herramienta devuelve un id y no un dibujo, y eso es deliberado: un
 * resultado de herramienta se reenvía al modelo en cada turno posterior de la
 * conversación, así que veinte kilobytes de SVG ahí se pagarían una y otra vez
 * para un lector que no puede verlos. `ChartCard` lo va a buscar.
 *
 * Sin `chartId` esta vista no llega a montarse: el registro lo declara en
 * `RICH_NEEDS` y la llamada vuelve a ser un renglón, que es lo que hacía antes.
 * Se conserva a propósito — el gráfico que no se pudo dibujar ya lo explicó el
 * modelo en la respuesta, y una tarjeta vacía diciéndolo otra vez es peor.
 */
export function ChartResult({ result }: ResultViewProps) {
  if (!result || typeof result !== 'object') return null;
  const { chartId, heading } = result as { chartId?: unknown; heading?: unknown };
  if (typeof chartId !== 'string') return null;
  return (
    <ChartCard chartId={chartId} heading={typeof heading === 'string' ? heading : 'Gráfico'} />
  );
}
