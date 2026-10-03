/**
 * Pronósticos (migración 0191, módulo «budget»): resultados a 12 meses con
 * estacionalidad o al ritmo reciente, ventas por cliente, demanda por producto
 * y `forecast.pnl`. Puro salvo ./store. Los clientes del navegador sólo
 * importan TIPOS de aquí.
 */
export { forecastMarkdown, forecastPnlTool } from './tools';
export { addMonths as forecastAddMonths, forecastPnl, seasonalIndex } from './pnl';
export type { ForecastMethod, ForecastMonth, PnlForecast, RecurringHint } from './pnl';
export { clientSalesForecast, productDemandForecast } from './demand';
export type { ClientForecast, ClientsForecast, ProductDemand } from './demand';
export { loadForecast } from './store';
export type { ForecastBundle } from './store';
