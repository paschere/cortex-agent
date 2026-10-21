import type { ProviderWriter } from '../close/writeback/shape';
import type { LiveRequest, LiveResult } from './live/shape';
import type { PayrollPage } from './payroll-provider';
import type { NormalizedPurchase, PurchasePage } from './providers/purchases';
import type { ProviderReports } from './providers/reports';
/**
 * LA FORMA COMÚN DE UN PROGRAMA CONTABLE (migración 0165).
 *
 * Siigo, Alegra y QuickBooks llaman distinto a lo mismo: Siigo dice
 * `identification` y `balance`, QuickBooks `TaxIdentifier` y `Balance`. Cada
 * programa tiene UN archivo en `providers/` que habla su API y traduce a estas
 * formas; todo lo demás —las tablas, la cartera, los pagos, la reanudación, el
 * trabajo programado— sólo conoce estas formas. Por eso sumar un programa no
 * cuesta una tabla nueva ni tocar el motor.
 */

export type AccountingProviderId = 'siigo' | 'alegra' | 'quickbooks';
export const ACCOUNTING_PROVIDER_IDS: readonly AccountingProviderId[] = [
  'siigo',
  'alegra',
  'quickbooks',
] as const;

export type AccountingEntity =
  | 'customers'
  | 'products'
  | 'invoices'
  | 'payments'
  | 'credit_notes'
  // 0234: todo lo demás del programa, como tablas para tableros, apps y reglas.
  | 'purchases'
  | 'supplier_payments'
  | 'journal_lines'
  | 'quotations'
  | 'stock'
  | 'statements'
  | 'payroll_costs'
  | 'cost_centers'
  | 'taxes'
  | 'payment_methods'
  | 'warehouses'
  | 'document_types'
  | 'sellers';

/**
 * El orden de la corrida. Primero los catálogos y los terceros (para que los
 * documentos salgan con nombres de cliente, de centro de costo), después los
 * documentos, y al final lo que se arma a partir de otras lecturas.
 */
export const ACCOUNTING_ENTITIES: readonly AccountingEntity[] = [
  'customers',
  'cost_centers',
  'taxes',
  'payment_methods',
  'warehouses',
  'document_types',
  'sellers',
  'products',
  'stock',
  'invoices',
  'payments',
  'credit_notes',
  'purchases',
  'supplier_payments',
  'quotations',
  'journal_lines',
  'statements',
  'payroll_costs',
] as const;

/**
 * Cosas que NO se piden al programa en una lista propia:
 *   - `stock` sale de la misma lectura de productos (existencias por bodega);
 *   - `statements` y `payroll_costs` se arman del balance de prueba / estado de
 *     resultados mensual (sync-derived.ts), con copia guardada por mes.
 */
export const DERIVED_ENTITIES: readonly AccountingEntity[] = [
  'stock',
  'statements',
  'payroll_costs',
] as const;

/** Catálogos de referencia: tablas pequeñas que se revisan una vez al día. */
export const CATALOG_ENTITIES = [
  'cost_centers',
  'taxes',
  'payment_methods',
  'warehouses',
  'document_types',
  'sellers',
] as const satisfies readonly AccountingEntity[];
export type CatalogEntity = (typeof CATALOG_ENTITIES)[number];

/**
 * Cosas opcionales que se traen aparte de las tablas (0217). No llenan Tablas
 * ni la cartera: la nómina es confidencial y vive en su propia tabla.
 */
export type AccountingOption = 'payroll';
export const ACCOUNTING_OPTIONS: readonly AccountingOption[] = ['payroll'] as const;
/** Lo que una conexión puede traer: las cosas de siempre y las opcionales. */
export type AccountingSelection = AccountingEntity | AccountingOption;

export interface NormalizedCustomer {
  externalId: string;
  name?: string;
  relationship?: 'Cliente' | 'Proveedor' | 'Otro';
  /** Sólo dígitos, sin dígito de verificación: lo que va en `clients.tax_id`. */
  taxId?: string;
  /** Como se escribe: «900123456-7». */
  taxIdDisplay?: string;
  kind?: 'Empresa' | 'Persona';
  city?: string;
  address?: string;
  phone?: string;
  email?: string;
  active?: boolean;
  /** AAAA-MM-DD. */
  createdOn?: string;
}

export interface NormalizedProduct {
  externalId: string;
  name?: string;
  code?: string;
  kind?: 'Producto' | 'Servicio' | 'Combo';
  group?: string;
  price?: number;
  stock?: number;
  unit?: string;
  reference?: string;
  active?: boolean;
  /** 0183: costo por unidad, si el programa lo da (Alegra `unitCost`, QuickBooks `PurchaseCost`). */
  cost?: number;
  /** 0183: existencia mínima / punto de reorden, si el programa lo da. */
  minStock?: number;
  /** 0183: existencias por bodega, si el programa las da (Siigo, Alegra). */
  warehouses?: Array<{ externalId: string; name: string; quantity: number }>;
}

export type InvoiceStatus = 'open' | 'paid' | 'annulled';

export interface NormalizedInvoice {
  externalId: string;
  number: string;
  /** AAAA-MM-DD. */
  date: string;
  dueDate?: string;
  customerExternalId?: string;
  /** Si el programa lo trae en la factura; si no, sale de la tabla de clientes. */
  customerName?: string;
  customerTaxId?: string;
  total: number;
  /** Lo que el programa dice que falta por pagar. Nunca negativo. */
  balance: number;
  /** Tres letras. El programa la dice; si no la dice, la moneda de la empresa en él. */
  currency: string;
  status: InvoiceStatus;
  /** Estado de la factura electrónica (DIAN), ya en español, si aplica. */
  einvoiceStatus?: 'Aceptada' | 'Rechazada' | 'Pendiente' | 'Sin enviar' | 'Otro';
  notes?: string;
  url?: string;
}

export type PaymentKind = 'Abono a factura' | 'Anticipo' | 'Detallado' | 'Otro';

export interface NormalizedPayment {
  externalId: string;
  number?: string;
  date: string;
  customerExternalId?: string;
  customerName?: string;
  customerTaxId?: string;
  amount: number;
  currency: string;
  kind?: PaymentKind;
  method?: string;
  notes?: string;
  /**
   * A qué facturas abona, una línea por factura. `ref` es estable (id del pago +
   * línea): con él reimportar no duplica en Pagos. Vacío = anticipo sin factura.
   */
  applications: Array<{ ref: string; invoiceNumber: string | null; amount: number }>;
}

/** Nota crédito de venta (0232): anula o rebaja una factura. */
export interface NormalizedCreditNote {
  externalId: string;
  number: string;
  date: string;
  customerExternalId?: string;
  customerName?: string;
  customerTaxId?: string;
  /** Número de la factura que afecta («FV-1-68»), si el programa lo dice. */
  invoiceNumber?: string;
  total: number;
  currency: string;
  reason?: string;
  notes?: string;
}

/**
 * Pago a un proveedor (comprobante de egreso). Espejo de `NormalizedPayment`
 * del lado de las compras: a qué compras abona, una línea por compra.
 */
export interface NormalizedSupplierPayment {
  externalId: string;
  number?: string;
  date: string;
  supplierExternalId?: string;
  supplierName?: string;
  supplierTaxId?: string;
  amount: number;
  currency: string;
  method?: string;
  notes?: string;
  annulled?: boolean;
  /** A qué compras abona («FC-1-23»); vacío = anticipo sin compra. */
  applications: Array<{ ref: string; purchaseNumber: string | null; amount: number }>;
}

/** Un movimiento de un comprobante contable: una cuenta, un sentido, un valor. */
export interface NormalizedJournalLine {
  /** `id del comprobante:posición`: único y estable. */
  externalId: string;
  journalId: string;
  journalNumber: string;
  date: string;
  /** Cuenta PUC, sólo dígitos. */
  account: string;
  accountName?: string;
  movement: 'debit' | 'credit';
  /** Siempre positivo; el sentido lo dice `movement`. */
  value: number;
  partyExternalId?: string;
  partyTaxId?: string;
  partyName?: string;
  costCenter?: string;
  description?: string;
  /** Línea de nómina: no se guarda tercero ni descripción (confidencial). */
  confidential?: boolean;
}

export interface NormalizedQuotation {
  externalId: string;
  number: string;
  date: string;
  validUntil?: string;
  customerExternalId?: string;
  customerName?: string;
  customerTaxId?: string;
  sellerExternalId?: string;
  total: number;
  currency: string;
  status?: string;
  notes?: string;
}

/** Existencias de un producto en una bodega. */
export interface NormalizedStockLine {
  /** `id del producto:id de la bodega`. */
  externalId: string;
  productExternalId: string;
  productName?: string;
  productCode?: string;
  warehouseExternalId: string;
  warehouseName: string;
  quantity: number;
  minStock?: number;
  unit?: string;
}

export const CATALOG_KIND_LABEL: Record<CatalogEntity, string> = {
  cost_centers: 'Centro de costo',
  taxes: 'Impuesto o retención',
  payment_methods: 'Forma de pago',
  warehouses: 'Bodega',
  document_types: 'Tipo de documento',
  sellers: 'Vendedor',
};

/** Una fila de un catálogo de referencia (centro de costo, impuesto, bodega…). */
export interface NormalizedCatalogItem {
  externalId: string;
  catalog: CatalogEntity;
  name: string;
  code?: string;
  /** Impuestos: «IVA», «ReteFuente»…; formas de pago: «Contado»/«Crédito»; documentos: su sigla. */
  kind?: string;
  /** Impuestos: 19, 2.5… */
  percentage?: number;
  active?: boolean;
}

export type StatementKind = 'Estado de resultados' | 'Balance general';

/** Un renglón de un estado financiero de un mes. */
export interface NormalizedStatementLine {
  /** `pnl|AAAA-MM|sección|código o nombre`. */
  externalId: string;
  /** AAAA-MM. */
  period: string;
  statement: StatementKind;
  section: string;
  code?: string;
  name: string;
  amount: number;
  /** El mes todavía no cierra. */
  inProgress: boolean;
}

/** Costo de personal de un mes por área y concepto: sólo totales de la empresa. */
export interface NormalizedPayrollCost {
  externalId: string;
  period: string;
  area: string;
  group: string;
  concept: string;
  amount: number;
  inProgress: boolean;
}

export type { NormalizedPurchase };

export type NormalizedRecord =
  | NormalizedCustomer
  | NormalizedProduct
  | NormalizedInvoice
  | NormalizedPayment
  | NormalizedCreditNote
  | NormalizedPurchase
  | NormalizedSupplierPayment
  | NormalizedJournalLine
  | NormalizedQuotation
  | NormalizedStockLine
  | NormalizedCatalogItem
  | NormalizedStatementLine
  | NormalizedPayrollCost;

/** Un filtro de un listado del programa, opaco para el motor (se guarda para reanudar). */
export type ProviderQuery = Record<string, string>;

export interface ProviderPage {
  records: NormalizedRecord[];
  hasMore: boolean;
  total?: number;
  /** Registros que el programa devolvió pero no se pudieron leer (sin número, sin fecha). */
  skipped?: number;
}

/** El token de sesión del programa, cifrado entre corridas. */
export interface ProviderToken {
  token: string;
  /** Epoch en milisegundos. */
  expiresAt: number;
}

export interface ProviderTokenStore {
  load(): Promise<ProviderToken | null>;
  save(token: ProviderToken): Promise<void>;
  /**
   * Guarda la llave entera otra vez, cifrada. Lo usa un programa con OAuth
   * (QuickBooks): cada renovación puede devolver un refresh token nuevo y el
   * viejo deja de servir, así que perderlo es perder la conexión. A diferencia
   * de `save`, un error aquí NO se traga.
   */
  saveCredentials?(credentials: Record<string, string>): Promise<void>;
}

export interface ProviderRuntime {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  tokenStore?: ProviderTokenStore;
  /** Espera mínima entre peticiones (los tests la ponen en 0). */
  minIntervalMs?: number;
}

/** Una sesión abierta con la llave de una empresa. */
export interface ProviderSession {
  /** «Probar y conectar»: autentica y lee una fila. Lanza con un mensaje en español. */
  verify(): Promise<{ token: ProviderToken | null }>;
  listPage(entity: AccountingEntity, query: ProviderQuery, page: number): Promise<ProviderPage>;
  /**
   * Vuelve a leer estas facturas por su número («FV-1-68»), sin filtros de
   * fecha (0232). Un recibo de caja baja el saldo de una factura SIN marcarla
   * como modificada, así que al llegar un pago se refrescan las facturas que
   * abona en vez de esperar al repaso diario. Máximo unas decenas por vez.
   */
  refreshInvoices?(numbers: string[]): Promise<NormalizedInvoice[]>;
  /**
   * Lo mismo para las compras: un comprobante de egreso baja el saldo de la
   * compra sin marcarla como modificada, así que al llegar un pago a
   * proveedor se vuelven a leer las compras que abona (por su número, «FC-2-22»).
   */
  refreshPurchases?(numbers: string[]): Promise<NormalizedPurchase[]>;
  /**
   * Cuántos registros dice tener el programa de una cosa, sin filtros (una sola
   * petición de una fila). Sirve para comprobar que la tabla sincronizada no
   * se quedó corta. `null` si el programa no lo puede decir.
   */
  remoteTotal?(entity: AccountingEntity): Promise<number | null>;
  /** Peticiones HTTP hechas (para el registro de la corrida). */
  readonly requests: number;
  /** Al desconectar: avisarle al programa que la llave ya no se usa (OAuth). Nunca lanza. */
  revoke?(): Promise<void>;
  /**
   * Comprobantes contables de nómina desde `since` (AAAA-MM-DD), página a
   * página (0217). Sólo lectura; payroll.ts dice qué cuentas cuentan.
   */
  listPayroll?(since: string, page: number): Promise<PayrollPage>;
  /**
   * Compras / facturas de proveedor desde `since` (AAAA-MM-DD), página a
   * página (0181, cuentas por pagar). Sólo lectura; providers/purchases.ts.
   */
  listPurchases?(since: string, page: number): Promise<PurchasePage>;
  /**
   * Emitir facturas de venta (migración 0182). Sólo los programas que saben
   * hacerlo (Siigo, Alegra); la ÚNICA escritura de Cortex en un programa
   * contable, y siempre después de la aprobación de una persona (ver
   * packages/agent-tools/src/sales/emit.ts).
   */
  invoicing?: ProviderInvoicing;
  /**
   * Balance general y estado de resultados (migración 0191, estados
   * financieros). Sólo lectura; providers/reports*.ts dice qué expone cada
   * programa y cómo se lee.
   */
  reports?: ProviderReports;
  /**
   * Consulta EN VIVO de documentos y catálogos (facturas, compras, comprobantes,
   * terceros…), sólo lectura, para `accounting.query`. Sólo los programas que
   * ya lo permiten; los demás no la traen y la herramienta lo dice.
   */
  live?: (req: LiveRequest) => Promise<LiveResult>;
  /**
   * Registrar en el programa (migración 0192, cierre contable): causar una
   * compra, un recibo de caja, un pago a proveedor. Siempre después de la
   * vista previa y la aprobación de una persona (close/writeback/store.ts).
   */
  writer?: ProviderWriter;
  /**
   * Avisos del programa (webhooks) de productos y existencias (0234). Sólo
   * Siigo. Suscribir es CONFIGURACIÓN en el programa, no datos: lo pide un
   * administrador, nunca la sincronización sola.
   */
  webhooks?: {
    subscribe(url: string): Promise<{ topics: string[]; failed: string[] }>;
  };
  /**
   * Escrituras hacia el programa desde las apps (0232): cliente (tercero),
   * recibo de caja contra varias facturas y nota crédito. Igual que `invoicing`,
   * sólo después de la revisión y aprobación de una persona (bandeja
   * «Por enviar a Siigo»); nunca desatendido.
   */
  outbound?: ProviderOutbound;
}

/** Un documento creado en el programa. */
export interface CreatedProviderDocument {
  id: string;
  number: string | null;
  total: number | null;
  /** Estado de la DIAN en español, si aplica (nota crédito electrónica). */
  einvoiceStatus?: string | null;
}

export interface ProviderOutbound {
  /** Crea el tercero si no existe (por NIT); si ya existe devuelve el que hay. Nunca pisa datos. */
  upsertCustomer(
    payload: import('./outbound/shape').CustomerPayload,
    opts: { idempotencyKey: string },
  ): Promise<{ id: string; name: string | null; created: boolean }>;
  /** Un recibo de caja que cruza una o varias facturas del mismo cliente. */
  createReceipt?(
    payload: import('./outbound/shape').ReceiptPayload,
    opts: { idempotencyKey: string; paymentTypeId?: string },
  ): Promise<CreatedProviderDocument>;
  /** Una nota crédito contra una factura. */
  createCreditNote?(
    payload: import('./outbound/shape').CreditNotePayload,
    opts: { idempotencyKey: string; paymentTypeId?: string; documentTypeId?: string; stamp?: boolean },
  ): Promise<CreatedProviderDocument>;
}

/** Lo que el programa necesita que se elija antes de facturar, ya traducido. */
export interface InvoicingCatalog {
  /** Tipos de documento de factura de venta (Siigo: FV). Alegra: numeraciones. */
  documentTypes: Array<{
    id: string;
    name: string;
    electronic: boolean;
    /** Siigo: cómo lee `discount` cada ítem. Alegra siempre en porcentaje. */
    discountType?: 'percentage' | 'value';
  }>;
  /** Vendedores (Siigo exige uno). */
  sellers: Array<{ id: string; name: string }>;
  /** Formas de pago (Siigo). En Alegra la forma de pago es CASH/CREDIT. */
  paymentTypes: Array<{ id: string; name: string; credit: boolean }>;
  /** Impuestos configurados en el programa. */
  taxes: Array<{
    id: string;
    name: string;
    kind: 'iva' | 'retefuente' | 'reteica' | 'reteiva' | 'other';
    percentage: number;
  }>;
}

export interface CreatedProviderInvoice {
  id: string;
  number: string | null;
  cufe: string | null;
  /** Estado de la DIAN en español, si el programa lo devolvió. */
  einvoiceStatus: string | null;
  url: string | null;
  total: number | null;
}

export interface ProviderInvoicing {
  catalog(): Promise<InvoicingCatalog>;
  /** El cliente en el programa por NIT (sólo dígitos, sin DV). `null` si no está. */
  findCustomer(taxId: string): Promise<{ id: string; name: string | null } | null>;
  /**
   * POST de la factura. `idempotencyKey` va en la cabecera cuando el programa
   * la acepta (Siigo: `Idempotency-Key`); NUNCA se reintenta solo ante una
   * falla de red: quien llama decide.
   */
  createInvoice(
    payload: unknown,
    opts: { idempotencyKey: string },
  ): Promise<CreatedProviderInvoice>;
}

export interface CredentialField {
  key: string;
  label: string;
  /** Se escribe como contraseña y nunca se vuelve a mostrar. */
  secret: boolean;
  placeholder?: string;
}

export interface AccountingProvider {
  id: AccountingProviderId;
  name: string;
  /** Una línea para la tarjeta: de dónde se saca la llave. */
  credentialsHelp: string;
  credentialFields: CredentialField[];
  /** El campo de la llave que identifica la cuenta sin ser secreto. */
  accountLabelField: string;
  entities: readonly AccountingEntity[];
  /** Cosas opcionales (apagadas por defecto) que este programa también sabe traer. */
  options?: readonly AccountingOption[];
  /** Cómo se llaman los pagos en este programa («Recibos de caja»). */
  paymentsLabel?: string;
  /**
   * Cómo se conecta: pegando una llave en la tarjeta (`credentials`, Siigo y
   * Alegra) o entrando al programa (`oauth`, QuickBooks). En `oauth` los
   * `credentialFields` son lo que se guarda cifrado, no un formulario.
   */
  connect?: 'credentials' | 'oauth';
  /**
   * Lo que le falta a ESTA instalación para poder conectar el programa (p. ej.
   * la app de QuickBooks sin registrar), en español, o `null` si está listo.
   */
  setupMissing?(): string | null;
  open(credentials: Record<string, string>, runtime?: ProviderRuntime): ProviderSession;
  /**
   * Qué listados pedir para una cosa:
   *   - `initial`: la primera carga (el último año de documentos; todos los
   *     clientes y productos);
   *   - `sweep`: el repaso diario de las facturas recientes, por los abonos
   *     que no marcan la factura como modificada;
   *   - `incremental`: lo creado o cambiado desde `since` (ISO, ya con margen).
   */
  queries(entity: AccountingEntity, input: QueryPlanInput): ProviderQuery[];
}

export interface QueryPlanInput {
  mode: 'initial' | 'sweep' | 'incremental';
  since?: string;
  now: Date;
}

/** Lo que la pantalla necesita saber de un programa, sin nada que ejecutar. */
export interface ProviderInfo {
  id: AccountingProviderId;
  name: string;
  available: boolean;
  credentialsHelp: string;
  credentialFields: CredentialField[];
  entities: AccountingEntity[];
  /** Opcionales que se pueden activar (nómina). */
  options: AccountingOption[];
  paymentsLabel: string;
  connect: 'credentials' | 'oauth';
  /** Qué falta configurar en la instalación para conectarlo; `null` si nada. */
  setupMissing: string | null;
}

/**
 * Una escritura que el programa rechazó por el CONTENIDO (un 400/422): el
 * mensaje ya está en español para la persona, y `details` trae lo que dijo el
 * programa, para el registro. Distinta de una falla de red: ésta es segura de
 * corregir y volver a mandar.
 */
export class ProviderValidationError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderValidationError';
  }
}

/** No se sabe si la escritura llegó (la red se cortó después de mandarla). */
export class ProviderUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUncertainError';
  }
}
