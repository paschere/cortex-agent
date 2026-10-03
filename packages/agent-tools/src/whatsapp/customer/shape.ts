import { z } from 'zod';

/**
 * ATENCIÓN A CLIENTES POR WHATSAPP — LAS FORMAS (migración 0185).
 *
 * Puro: tipos, etiquetas y la lectura tolerante de la configuración. Lo pueden
 * importar las pantallas (`import type`) sin arrastrar el registro.
 */

export const CONVERSATION_STATUSES = ['abierta', 'escalada', 'cerrada'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const CONVERSATION_STATUS_LABEL: Record<ConversationStatus, string> = {
  abierta: 'Abierta',
  escalada: 'Con una persona',
  cerrada: 'Cerrada',
};

export const VERIFICATIONS = [
  'ninguna',
  'telefono',
  'pendiente',
  'verificado',
  'bloqueada',
] as const;
export type Verification = (typeof VERIFICATIONS)[number];

export const VERIFICATION_LABEL: Record<Verification, string> = {
  ninguna: 'Sin identificar',
  telefono: 'Por su teléfono',
  pendiente: 'Esperando NIT y factura',
  verificado: 'Verificado con NIT y factura',
  bloqueada: 'Verificación bloqueada',
};

/** Lo que el clasificador entiende. Nada fuera de esta lista se contesta solo. */
export const INTENTS = [
  'saludo',
  'estado_pedido',
  'saldo',
  'facturas',
  'cotizacion',
  'queja',
  'persona',
  'empresa',
  'faq',
  'baja',
  'alta',
  'gracias',
  'verificacion',
  'otro',
] as const;
export type Intent = (typeof INTENTS)[number];

export const INTENT_LABEL: Record<Intent, string> = {
  saludo: 'Saludo',
  estado_pedido: 'Estado de pedido o guía',
  saldo: 'Saldo',
  facturas: 'Facturas',
  cotizacion: 'Cotización',
  queja: 'Queja',
  persona: 'Pidió una persona',
  empresa: 'Datos de la empresa',
  faq: 'Pregunta frecuente',
  baja: 'Pidió no recibir más mensajes',
  alta: 'Volvió a activar',
  gracias: 'Agradecimiento',
  verificacion: 'Verificación',
  otro: 'Otro',
};

/** Las que necesitan saber de qué cliente es quien escribe. */
export const CLIENT_INTENTS = new Set<Intent>(['saldo', 'facturas']);

export interface FaqEntry {
  q: string;
  a: string;
  keywords?: string[];
}

export interface OrderSource {
  trackerId: string;
  label: string;
  /** Campo de la tabla con el número de guía o pedido. */
  numberField: string;
  /** Campo con el estado — lo ÚNICO que se dice de la fila, con la fecha. */
  statusField: string;
  /** Campo con la fecha estimada de entrega, si se quiere decir. */
  etaField?: string | null;
  /**
   * Campo con el nombre o NIT del cliente. Con él, si quien escribe ya está
   * identificado y la fila es de OTRO cliente, se responde «no la encontré».
   */
  clientField?: string | null;
}

/** «1»…«7» (lunes…domingo) → franjas «HH:MM». */
export type BusinessHours = Record<string, Array<[string, string]>>;

export interface CustomerSettings {
  enabled: boolean;
  timeZone: string;
  businessHours: BusinessHours;
  botAfterHours: boolean;
  greeting: string | null;
  afterHoursMessage: string | null;
  shareOrderStatus: boolean;
  shareInvoices: boolean;
  shareBalance: boolean;
  shareCompanyInfo: boolean;
  companyInfo: string | null;
  faq: FaqEntry[];
  orderSources: OrderSource[];
  escalationUserId: string | null;
  escalationTeam: string | null;
  maxRepliesPerHour: number;
  updatedAt: string | null;
}

export const DEFAULT_CUSTOMER_SETTINGS: CustomerSettings = {
  enabled: false,
  timeZone: 'America/Bogota',
  businessHours: {},
  botAfterHours: true,
  greeting: null,
  afterHoursMessage: null,
  shareOrderStatus: true,
  shareInvoices: true,
  shareBalance: true,
  shareCompanyInfo: true,
  companyInfo: null,
  faq: [],
  orderSources: [],
  escalationUserId: null,
  escalationTeam: null,
  maxRepliesPerHour: 12,
  updatedAt: null,
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export const faqEntrySchema = z.object({
  q: z.string().trim().min(3).max(300),
  a: z.string().trim().min(1).max(1200),
  keywords: z.array(z.string().trim().min(2).max(40)).max(20).optional(),
});

export const orderSourceSchema = z.object({
  trackerId: z.string().uuid(),
  label: z.string().trim().min(1).max(60),
  numberField: z.string().trim().min(1).max(32),
  statusField: z.string().trim().min(1).max(32),
  etaField: z.string().trim().min(1).max(32).nullish(),
  clientField: z.string().trim().min(1).max(32).nullish(),
});

export const businessHoursSchema = z.record(
  z.enum(['1', '2', '3', '4', '5', '6', '7']),
  z
    .array(
      z
        .tuple([z.string().regex(HHMM), z.string().regex(HHMM)])
        .refine(([a, b]) => a < b, 'La franja termina antes de empezar.'),
    )
    .max(4),
);

/** Lo que llega de la pantalla. Validado aquí, no en el componente. */
export const customerSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  timeZone: z.string().trim().min(3).max(60).optional(),
  businessHours: businessHoursSchema.optional(),
  botAfterHours: z.boolean().optional(),
  greeting: z.string().trim().max(600).nullable().optional(),
  afterHoursMessage: z.string().trim().max(600).nullable().optional(),
  shareOrderStatus: z.boolean().optional(),
  shareInvoices: z.boolean().optional(),
  shareBalance: z.boolean().optional(),
  shareCompanyInfo: z.boolean().optional(),
  companyInfo: z.string().trim().max(2000).nullable().optional(),
  faq: z.array(faqEntrySchema).max(60).optional(),
  orderSources: z.array(orderSourceSchema).max(10).optional(),
  escalationUserId: z.string().uuid().nullable().optional(),
  escalationTeam: z.string().trim().max(80).nullable().optional(),
  maxRepliesPerHour: z.number().int().min(1).max(60).optional(),
});
export type SettingsPatch = z.infer<typeof customerSettingsSchema>;

/** Una fila de `wa_customer_settings` → la configuración. Tolerante: lo raro cae al defecto. */
export function adaptSettings(row: Record<string, unknown> | null | undefined): CustomerSettings {
  if (!row) return { ...DEFAULT_CUSTOMER_SETTINGS };
  const hours = businessHoursSchema.safeParse(row.business_hours);
  const faq = z.array(faqEntrySchema).safeParse(row.faq);
  const sources = z.array(orderSourceSchema).safeParse(row.order_sources);
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const flag = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
  const max = Number(row.max_replies_per_hour);
  return {
    enabled: row.enabled === true,
    timeZone: text(row.time_zone) ?? DEFAULT_CUSTOMER_SETTINGS.timeZone,
    businessHours: hours.success ? (hours.data as BusinessHours) : {},
    botAfterHours: flag(row.bot_after_hours, true),
    greeting: text(row.greeting),
    afterHoursMessage: text(row.after_hours_message),
    shareOrderStatus: flag(row.share_order_status, true),
    shareInvoices: flag(row.share_invoices, true),
    shareBalance: flag(row.share_balance, true),
    shareCompanyInfo: flag(row.share_company_info, true),
    companyInfo: text(row.company_info),
    faq: faq.success ? faq.data : [],
    orderSources: sources.success ? sources.data : [],
    escalationUserId: text(row.escalation_user_id),
    escalationTeam: text(row.escalation_team),
    maxRepliesPerHour: Number.isInteger(max) && max >= 1 && max <= 60 ? max : 12,
    updatedAt: text(row.updated_at),
  };
}

/** La configuración → columnas, sólo lo que trae el parche. */
export function settingsToRow(patch: SettingsPatch): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  const map: Array<[keyof SettingsPatch, string]> = [
    ['enabled', 'enabled'],
    ['timeZone', 'time_zone'],
    ['businessHours', 'business_hours'],
    ['botAfterHours', 'bot_after_hours'],
    ['greeting', 'greeting'],
    ['afterHoursMessage', 'after_hours_message'],
    ['shareOrderStatus', 'share_order_status'],
    ['shareInvoices', 'share_invoices'],
    ['shareBalance', 'share_balance'],
    ['shareCompanyInfo', 'share_company_info'],
    ['companyInfo', 'company_info'],
    ['faq', 'faq'],
    ['orderSources', 'order_sources'],
    ['escalationUserId', 'escalation_user_id'],
    ['escalationTeam', 'escalation_team'],
    ['maxRepliesPerHour', 'max_replies_per_hour'],
  ];
  for (const [key, column] of map) {
    if (patch[key] === undefined) continue;
    const value = patch[key];
    row[column] = typeof value === 'string' && !value.trim() ? null : value;
  }
  return row;
}

export interface ConversationRow {
  id: string;
  phone: string;
  jid: string;
  push_name: string | null;
  client_id: string | null;
  contact_id: string | null;
  status: ConversationStatus;
  assigned_to: string | null;
  verification: Verification;
  verified_until: string | null;
  verify_attempts: number;
  pending_intent: string | null;
  opted_out: boolean;
  opted_out_at: string | null;
  last_message_at: string;
  last_inbound_at: string | null;
  escalated_at: string | null;
  escalation_reason: string | null;
  closed_at: string | null;
  work_item_id: string | null;
  created_at: string;
}

export const CONVERSATION_COLUMNS =
  'id, phone, jid, push_name, client_id, contact_id, status, assigned_to, verification, verified_until, verify_attempts, pending_intent, opted_out, opted_out_at, last_message_at, last_inbound_at, escalated_at, escalation_reason, closed_at, work_item_id, created_at';

export interface MessageSource {
  kind: 'invoice' | 'order' | 'faq' | 'company' | 'client';
  id: string;
  label: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  direction: 'in' | 'out';
  body: string;
  intent: string | null;
  answered_by: 'bot' | 'persona' | null;
  author_id: string | null;
  sources: MessageSource[];
  delivery: 'pendiente' | 'enviando' | 'enviado' | 'fallido' | null;
  sent_at: string | null;
  created_at: string;
}

export const MESSAGE_COLUMNS =
  'id, conversation_id, direction, body, intent, answered_by, author_id, sources, delivery, sent_at, created_at';

/** El número como lo lee una persona: «+57 300 111 2233». */
export function displayPhone(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('57') && d.length === 12) {
    return `+57 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  }
  return `+${d}`;
}

/** La ventana en la que una persona del equipo puede contestar: 24 h desde el último mensaje del cliente. */
export const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Por qué una persona NO puede contestar ahora, o null si sí puede. */
export function replyRefusal(
  conv: Pick<ConversationRow, 'status' | 'opted_out' | 'last_inbound_at'>,
  now: Date,
): string | null {
  if (conv.status === 'cerrada') {
    return 'La conversación está cerrada. Sólo se contesta dentro de una conversación abierta: si el cliente vuelve a escribir, se abre otra.';
  }
  if (conv.opted_out) {
    return 'Este cliente pidió no recibir más mensajes por aquí. No se le escribe hasta que él vuelva a activar.';
  }
  if (!conv.last_inbound_at) {
    return 'El cliente todavía no ha escrito en esta conversación. El número nunca escribe primero.';
  }
  const since = now.getTime() - Date.parse(conv.last_inbound_at);
  if (!(since >= 0 && since <= REPLY_WINDOW_MS)) {
    return 'Pasaron más de 24 horas desde el último mensaje del cliente. Para no escribirle en frío, se espera a que vuelva a escribir.';
  }
  return null;
}
