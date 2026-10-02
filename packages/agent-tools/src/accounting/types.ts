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
}
