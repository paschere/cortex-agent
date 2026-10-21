import { z } from 'zod';
import { roleKeySchema } from '../permissions';

/**
 * LA FORMA DE LA ACCIÓN `accounting_draft_invoice` (prefactura para Siigo).
 *
 * Módulo puro. Los textos admiten `{{campos}}` de la fila que disparó la regla;
 * las cantidades y los precios, además, admiten una FÓRMULA que empieza por `=`
 * (`={{kilos}} * 0,80`): sólo números, + − × ÷ y paréntesis; nada de código.
 */

const fieldKey = z.string().trim().min(1).max(32);

export const INVOICE_TAX_RATES = ['iva_19', 'iva_5', 'iva_0', 'excluido'] as const;
export const INVOICE_MAX_ITEMS = 10;

const amount = z.union([z.number().finite().min(0).max(1e13), z.string().trim().min(1).max(200)]);

export const invoiceItemSchema = z.object({
  /** Qué se factura (texto con `{{campos}}`). */
  description: z.string().trim().min(1).max(300),
  /** Código del producto o servicio en Siigo (fijo o `{{campo}}`). */
  productCode: z.string().trim().min(1).max(60).optional(),
  /** Cantidad: número, `{{campo}}` o fórmula `=…`. */
  quantity: amount,
  /** Precio unitario ANTES de IVA, en la moneda de la prefactura: número, `{{campo}}` o fórmula. */
  unitPrice: amount,
  /**
   * Lista de precios de Siigo (nombre o posición, fijo o `{{campo}}`: «la lista
   * del cliente»). Con ella y el código del producto, el precio sale de la
   * tabla «Precios por lista»; `unitPrice` queda de respaldo si ese producto no
   * tiene precio en esa lista.
   */
  priceList: z.string().trim().min(1).max(100).optional(),
  taxRate: z.enum(INVOICE_TAX_RATES).default('iva_19'),
  unit: z.string().trim().min(1).max(40).optional(),
  discountPct: z.number().min(0).max(100).optional(),
});
export type InvoiceItemSpec = z.infer<typeof invoiceItemSchema>;

export const invoiceCustomerSchema = z.object({
  /** NIT del cliente: `{{campo}}` o un valor fijo. */
  taxId: z.string().trim().min(1).max(200),
  /** Nombre (opcional; si falta se usa el de Siigo al revisar). */
  name: z.string().trim().min(1).max(200).optional(),
  /**
   * Campo de RELACIÓN de esta fila: el NIT y el nombre se leen de la fila a la
   * que apunta («al cliente del vuelo»: la atención apunta a su vuelo).
   */
  via: fieldKey.optional(),
});

export const invoiceWriteBackSchema = z.object({
  /** Campo de la fila donde queda el número de la factura de Siigo al aprobarla. */
  invoiceNumber: fieldKey.optional(),
  /** Campo de estado de la fila y qué se escribe al armar la prefactura / al crearla en Siigo. */
  status: z
    .object({
      field: fieldKey,
      pending: z.string().trim().min(1).max(80).optional(),
      created: z.string().trim().min(1).max(80).optional(),
    })
    .optional(),
});
export type InvoiceWriteBack = z.infer<typeof invoiceWriteBackSchema>;

export const invoiceBodySchema = {
  customer: invoiceCustomerSchema,
  items: z.array(invoiceItemSchema).min(1).max(INVOICE_MAX_ITEMS),
  /** Moneda de los precios; si no es COP hace falta `trm` (pesos por unidad). */
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .default('COP'),
  /** TRM: número, `{{campo}}` o fórmula. Los precios se pasan a pesos con ella. */
  trm: amount.optional(),
  /** Observaciones de la factura (texto con `{{campos}}`). */
  observations: z.string().trim().min(1).max(1000).optional(),
  paymentForm: z.enum(['contado', 'credito']).default('contado'),
  paymentDays: z.number().int().min(0).max(365).default(0),
  /** Ids de Siigo (tipo de documento, vendedor, forma de pago); vacíos = los que haya activos. */
  documentTypeId: z.string().trim().min(1).max(40).optional(),
  sellerId: z.string().trim().min(1).max(40).optional(),
  paymentTypeId: z.string().trim().min(1).max(40).optional(),
  writeBack: invoiceWriteBackSchema.optional(),
  /** A quién se le avisa que hay una prefactura por revisar (además del aviso en la bandeja). */
  notifyRoles: z.array(roleKeySchema).max(8).default([]),
  notifyAdmins: z.boolean().default(true),
};
