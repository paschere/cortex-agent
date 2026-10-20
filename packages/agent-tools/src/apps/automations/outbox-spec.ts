import { z } from 'zod';
import { CREDIT_NOTE_REASONS } from '../../accounting/outbound/shape';
import { roleKeySchema } from '../permissions';
import { invoiceCustomerSchema, invoiceItemSchema, invoiceWriteBackSchema } from './invoice-draft-spec';

/**
 * LAS FORMAS DE LAS ACCIONES QUE LE ESCRIBEN A SIIGO (0232): cliente, recibo de
 * caja y nota crédito. Módulo puro. Como la prefactura, las tres dejan un
 * BORRADOR en la bandeja «Por enviar a Siigo» y sólo una persona lo aprueba;
 * los textos admiten `{{campos}}` de la fila que disparó la regla.
 */

const fieldKey = z.string().trim().min(1).max(32);
const template = (max: number) => z.string().trim().min(1).max(max);
const amount = z.union([z.number().finite().min(0).max(1e13), z.string().trim().min(1).max(200)]);

const notify = {
  /** A quién se le avisa, además de la bandeja. */
  notifyRoles: z.array(roleKeySchema).max(8).default([]),
  notifyAdmins: z.boolean().default(true),
};

export const customerBodySchema = {
  /** NIT o cédula: `{{campo}}` o un valor fijo (con o sin dígito de verificación). */
  taxId: template(200),
  /** Nombre o razón social (texto con `{{campos}}`). */
  name: template(200),
  email: template(200).optional(),
  phone: template(200).optional(),
  address: template(300).optional(),
  /** Municipio («Bogotá») o código DANE de 5 dígitos. */
  city: template(120).optional(),
  personType: z.enum(['auto', 'company', 'person']).default('auto'),
  regime: z.enum(['responsable_iva', 'no_responsable']).default('no_responsable'),
  /** Campo de RELACIÓN de esta fila: los datos se leen de la fila a la que apunta. */
  via: fieldKey.optional(),
  writeBack: invoiceWriteBackSchema.optional(),
  ...notify,
};

export const receiptBodySchema = {
  customer: invoiceCustomerSchema,
  /** Valor del pago: número, `{{campo}}` o fórmula `=…`. */
  amount,
  /** Fecha del pago (AAAA-MM-DD); vacío = hoy en Bogotá. */
  date: template(60).optional(),
  /**
   * Facturas a cruzar, separadas por coma («FV-1-68, FV-1-70»). Vacío = las
   * facturas con saldo del cliente en Siigo, la que vence primero primero.
   */
  invoices: template(300).optional(),
  reference: template(200).optional(),
  /** Cuenta de banco o caja de donde entró (para elegir la forma de pago en Siigo). */
  bankAccount: template(120).optional(),
  paymentTypeId: z.string().trim().min(1).max(40).optional(),
  writeBack: invoiceWriteBackSchema.optional(),
  ...notify,
};

export const creditNoteBodySchema = {
  /** Número de la factura que se afecta («FV-1-68»): `{{campo}}` o fijo. */
  invoice: template(120),
  /** `total` = anula o devuelve toda la factura (copia sus líneas); `items` = sólo las de `items`. */
  mode: z.enum(['total', 'items']).default('total'),
  items: z.array(invoiceItemSchema).max(10).optional(),
  /** Motivo DIAN: 1 devolución parcial, 2 anulación, 3 rebaja, 4 ajuste de precio, 6 pronto pago, 7 volumen. */
  reason: z
    .number()
    .int()
    .refine((n) => (CREDIT_NOTE_REASONS as readonly number[]).includes(n), 'Motivo DIAN: 1, 2, 3, 4, 6 o 7.')
    .default(2),
  date: template(60).optional(),
  observations: template(1000).optional(),
  documentTypeId: z.string().trim().min(1).max(40).optional(),
  paymentTypeId: z.string().trim().min(1).max(40).optional(),
  writeBack: invoiceWriteBackSchema.optional(),
  ...notify,
};
