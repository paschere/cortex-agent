/**
 * Inventario y compras (migración 0183): el catálogo, el libro de existencias,
 * la reposición y las órdenes de compra. Registra seis herramientas al
 * importarse (./tools). Los clientes del navegador sólo importan TIPOS de aquí.
 */

export {
  inventoryMove,
  inventoryReorder,
  inventoryStock,
  purchasingCreatePo,
  purchasingReceive,
  purchasingSendPo,
} from './tools';

export {
  MOVEMENT_KINDS,
  MOVEMENT_KIND_LABEL,
  PO_STATUSES,
  PO_STATUS_LABEL,
  PO_STATUS_TONE,
  REFERENCE_KINDS,
  REFERENCE_KIND_LABEL,
  STOCK_ALERTS,
  STOCK_ALERT_LABEL,
  STOCK_ALERT_TONE,
  PurchaseOrderStateError,
  canMovePo,
  parsePoNumber,
  poLabel,
} from './shape';
export type {
  LocationRow as StockLocationRow,
  MovementKind as StockMovementKind,
  MovementRow as StockMovementRow,
  PoStatus,
  ProductRow,
  ReferenceKind as StockReferenceKind,
  StockAlert,
} from './shape';
export {
  CONSUMPTION_WINDOW_DAYS,
  annualTurnover,
  averageCostAfter,
  consumption as stockConsumption,
  groupBySupplier,
  planReceipt,
  poTotals,
  productAlert,
  reorderFor,
  reorderSuggestions,
  replayAverageCost,
} from './math';
export type { Consumption as StockConsumption, ReorderSuggestion, SupplierGroup } from './math';
export { parseCsv as parseInventoryCsv, parseProductSheet } from './sheet';
export type { SheetParseResult, SheetProductDraft } from './sheet';
export {
  type InventoryOverview,
  type InventoryProduct,
  type ProductInput,
  type ProductOverview,
  ProductInputError,
  adaptProduct,
  createProduct,
  findProduct,
  getProductRow,
  importAccountingProducts,
  importSheetProducts,
  listProducts,
  loadInventoryOverview,
  updateProduct,
} from './products';
export {
  type CountLine,
  type MovementDraft as StockMovementDraft,
  StockMovementError,
  applyStockCount,
  ensureDefaultLocation,
  findLocation,
  listLocations,
  loadLevels,
  levelsToStock,
  productMovements,
  recordMovements,
  saveLocation,
} from './stock';
export {
  type PurchaseOrder,
  type PurchaseOrderLine,
  type ReorderPlan,
  type SupplierRef,
  PO_LEDGER_SYSTEM,
  PurchaseApprovalError,
  approvePurchaseOrder,
  buildReorderPlan,
  cancelPurchaseOrder,
  createOrdersFromSuggestions,
  createPurchaseOrder,
  getPurchaseOrder,
  listOpenPurchaseOrders,
  listPurchaseOrders,
  listSuppliers as listPurchasingSuppliers,
  markPurchaseOrderInvoiced,
  markPurchaseOrderSent,
  receivePurchaseOrder,
  resolveSupplier,
  submitPurchaseOrder,
  updateDraftLines,
} from './purchasing';
export {
  type PoBrand,
  loadPoBrand,
  purchaseOrderEmail,
  purchaseOrderFilename,
  renderPurchaseOrderPdf,
} from './document';
