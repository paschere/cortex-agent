/**
 * Ventas (migración 0182): cotizaciones → pedidos → facturas electrónicas por
 * Siigo o Alegra. Los nombres que salen a la raíz del paquete llevan «sales»
 * o «Sales» para no chocar con los de cartera, libro o clientes.
 */

import './tools';

export { salesInvoiceEmit, salesList, salesQuoteCreate, salesQuoteSend } from './tools';
export {
  quoteEmail as salesQuoteEmail,
  quotePublicUrl as salesQuotePublicUrl,
  resolveSalesDocument,
  salesDocumentHref,
} from './tools';
export {
  NO_PROVIDER_GUIDANCE as SALES_NO_PROVIDER_GUIDANCE,
  emitInvoice as emitSalesInvoice,
  invoiceIdempotencyKey as salesInvoiceIdempotencyKey,
  previewInvoice as previewSalesInvoice,
} from './emit';
export type {
  EmitOutcome as SalesEmitOutcome,
  InvoicePreview as SalesInvoicePreview,
} from './emit';
export {
  DOC_COLUMNS as SALES_DOC_COLUMNS,
  acceptQuote as acceptSalesQuote,
  cancelSalesDocument,
  convertQuoteToOrder as convertSalesQuoteToOrder,
  countQuoteView as countSalesQuoteView,
  createSalesDocument,
  ensureShareToken as ensureSalesShareToken,
  getSalesDocument,
  getSalesDocumentRow,
  getSalesLines,
  listSalesDocuments,
  markQuoteSent as markSalesQuoteSent,
  prepareInvoice as prepareSalesInvoice,
  recordSalesEvent,
  rejectQuote as rejectSalesQuote,
  salesDocumentInputSchema,
  updateSalesDocument,
} from './store';
export type {
  SalesDocumentDetail,
  SalesDocumentInput,
  SalesLineInput,
} from './store';
export { listSellableProducts } from './products';
export type { SellableProduct } from './products';
export { renderSalesPdf } from './pdf';
export type { PdfBrand as SalesPdfBrand } from './pdf';
export type { EinvoiceDraft as SalesEinvoiceDraft } from './einvoice';
export {
  EVENT_LABEL as SALES_EVENT_LABEL,
  KIND_LABEL as SALES_KIND_LABEL,
  STATUS_LABEL as SALES_STATUS_LABEL,
  STATUS_TONE as SALES_STATUS_TONE,
  canInvoice as canInvoiceSalesDocument,
  documentNumber as salesDocumentNumber,
  effectiveStatus as salesEffectiveStatus,
  isEditable as isSalesDocumentEditable,
} from './shape';
export type {
  SalesDocumentRow,
  SalesEventKind,
  SalesEventRow,
  SalesKind,
  SalesLineRow,
  SalesStatus,
} from './shape';
export type { TaxRate as SalesTaxRate } from './totals';
