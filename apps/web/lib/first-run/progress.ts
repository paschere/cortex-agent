/**
 * EL PANEL DE «QUÉ LEÍ HASTA AHORA».
 *
 * Contadores baratos (conteos con tope) que el cliente consulta cada pocos
 * segundos mientras el paso está abierto. Aquí sólo está la forma y las
 * frases; las lecturas viven en `read.ts`.
 */

export interface IngestionCounts {
  /** Documentos del Cerebro ya leídos (status = ready). */
  documentsReady: number;
  /** Documentos todavía en cola o leyéndose. */
  documentsPending: number;
  documentsFailed: number;
  /** Facturas de venta traídas del programa contable. */
  invoices: number;
  /** Facturas por pagar. */
  payables: number;
  /** Hojas de cálculo sincronizadas a tablas. */
  sheets: number;
  /** Hilos del PROPIO correo de quien mira (nunca de otra persona). */
  mailThreads: number;
  mailRunning: boolean;
  /** Algún programa contable está trayendo datos ahora mismo. */
  accountingSyncing: boolean;
  accountingConnected: boolean;
  whatsappConnected: boolean;
  googleConnected: boolean;
}

export interface ProgressView {
  /** Frases ya escritas, una por cosa leída («34 facturas»). */
  lines: string[];
  /** Todavía están llegando cosas: seguir consultando. */
  loading: boolean;
  /** No hay nada leído ni nada en camino. */
  empty: boolean;
}

const nf = new Intl.NumberFormat('es-CO');
export const n = (x: number) => nf.format(x);

function plural(count: number, one: string, many: string): string {
  return `${n(count)} ${count === 1 ? one : many}`;
}

export function describeProgress(c: IngestionCounts): ProgressView {
  const lines: string[] = [];
  const totalDocs = c.documentsReady + c.documentsPending;
  if (totalDocs > 0) {
    lines.push(
      c.documentsPending > 0
        ? `Leí ${n(c.documentsReady)} de ~${n(totalDocs)} documentos`
        : `Leí ${plural(c.documentsReady, 'documento', 'documentos')}`,
    );
  }
  if (c.mailThreads > 0 || c.mailRunning)
    lines.push(
      `${plural(c.mailThreads, 'conversación de tu correo', 'conversaciones de tu correo')}`,
    );
  if (c.invoices > 0) lines.push(plural(c.invoices, 'factura de venta', 'facturas de venta'));
  if (c.payables > 0) lines.push(plural(c.payables, 'factura por pagar', 'facturas por pagar'));
  if (c.sheets > 0) lines.push(plural(c.sheets, 'hoja', 'hojas'));
  if (c.documentsFailed > 0)
    lines.push(
      `${plural(c.documentsFailed, 'documento no se pudo leer', 'documentos no se pudieron leer')}`,
    );
  const loading = c.documentsPending > 0 || c.accountingSyncing || c.mailRunning;
  const connected = c.googleConnected || c.accountingConnected || c.whatsappConnected;
  return { lines, loading, empty: lines.length === 0 && !loading && !connected };
}

/** Lo que todavía falta, dicho en una frase (para el resumen sin hallazgos). */
export function stillLoading(c: IngestionCounts): string[] {
  const out: string[] = [];
  if (c.accountingSyncing) out.push('Tu programa contable sigue trayendo facturas.');
  if (c.documentsPending > 0) out.push(`Faltan ${n(c.documentsPending)} documentos por leer.`);
  if (c.mailRunning) out.push('Tu correo se está leyendo.');
  if (!c.googleConnected && !c.accountingConnected && !c.whatsappConnected)
    out.push('Aún no hay fuentes conectadas.');
  return out;
}
