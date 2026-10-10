'use client';

import { CartesianChart, type CartesianChartProps } from './CartesianChart';

/**
 * Barras verticales, agrupadas o apiladas, con puntas redondeadas, huecos entre
 * tramos y negativos hacia abajo. Para «estado por periodo» usa los colores por
 * significado (`STATUS_TONE` en colors.ts).
 */
export function BarChart(props: Omit<CartesianChartProps, 'lines'>) {
  return <CartesianChart {...props} />;
}
