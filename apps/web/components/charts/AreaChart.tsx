'use client';

import { CartesianChart, type CartesianChartProps } from './CartesianChart';

/** Línea(s) suaves con degradado: la cara «tendencia» del gráfico de ejes. */
export function AreaChart(props: Omit<CartesianChartProps, 'bars' | 'barMode'>) {
  return <CartesianChart {...props} />;
}
