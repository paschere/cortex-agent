'use client';

import { normalizeMarks } from '@/lib/screen-marks';
import { ScreenMarks } from '../ScreenMarks';
import type { ResultViewProps } from './registry';

/**
 * `screen.point_at` — «¿dónde le doy?», contestado con un cuadro en la foto.
 *
 * ES LA ÚNICA VISTA DEL REGISTRO QUE NECESITA ALGO QUE NO VIENE EN EL RESULTADO:
 * la foto contra la que se contestó el turno, que vive en `MessageList` porque
 * es quien tiene la conversación abierta, y que viaja hasta aquí por
 * `ResultViewProps.screenFrame`. Sin ella la tarjeta lo dice en voz alta en vez
 * de dibujar cuadros sobre la nada — la foto muere al recargar, y eso es un
 * hecho sobre la respuesta, no un fallo que haya que esconder.
 *
 * SIN MARCAS NO DIBUJA NADA Y TAMPOCO BAJA A PASO, que es por lo que esta
 * herramienta no está en `RICH_NEEDS`. El modelo ya explicó en la respuesta por
 * qué no señaló nada; un renglón que diga «Señalar en tu pantalla» debajo de esa
 * frase es ruido sobre un rectángulo que no existe.
 *
 * Las marcas se vuelven a normalizar aquí en vez de confiarlas: este valor cruzó
 * un stream y, en una conversación reabierta, una fila de la base.
 */
export function MarksResult({ result, screenFrame }: ResultViewProps) {
  const marks = normalizeMarks((result as { marks?: unknown } | undefined)?.marks);
  if (marks.length === 0) return null;
  return <ScreenMarks marks={marks} frame={screenFrame} />;
}
