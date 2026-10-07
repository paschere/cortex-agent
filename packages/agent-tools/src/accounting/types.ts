import type { ProviderWriter } from '../close/writeback/shape';
import type { PurchasePage } from './providers/purchases';
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

export type AccountingEntity = 'customers' | 'products' | 'invoices' | 'payments';
export const ACCOUNTING_ENTITIES: readonly AccountingEntity[] = [
  'customers',
  'products',
  'invoices',
  'payments',
] as const;

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

export type NormalizedRecord =
  | NormalizedCustomer
  | NormalizedProduct
  | NormalizedInvoice
  | NormalizedPayment;

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
  /** Peticiones HTTP hechas (para el registro de la corrida). */
  readonly requests: number;
  /** Al desconectar: avisarle al programa que la llave ya no se usa (OAuth). Nunca lanza. */
  revoke?(): Promise<void>;
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
   * Registrar en el programa (migración 0192, cierre contable): causar una
   * compra, un recibo de caja, un pago a proveedor. Siempre después de la
   * vista previa y la aprobación de una persona (close/writeback/store.ts).
   */
  writer?: ProviderWriter;
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
