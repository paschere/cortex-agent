import { z } from 'zod';
import { filterSchema, thenSchema } from '../../views/spec';
import { roleKeySchema } from '../permissions';
import { ACCOUNTING_EVENTS, ACCOUNTING_EVENT_LABEL, accountingEventTableSlug } from '../../accounting/events';
import { ACCOUNTING_PROVIDER_IDS } from '../../accounting/types';
import { invoiceBodySchema } from './invoice-draft-spec';
import { creditNoteBodySchema, customerBodySchema, receiptBodySchema } from './outbox-spec';
import { REPORT_MAX_RECIPIENTS, reportBodySchema } from './report-spec';

/**
 * LA FORMA DE UNA AUTOMATIZACIÓN (migración 0210): Cuando / Si / Entonces.
 *
 * Todo es JSON validado aquí, no en la base: cambiar una regla no es una
 * migración. Este módulo es PURO (sin base, sin reloj, sin red) para que el
 * editor, las herramientas del chat y el motor hablen exactamente el mismo
 * idioma. Los campos que nombra son llaves de campo de una tabla y se
 * comprueban contra la tabla real en `validateAutomation` (store.ts).
 *
 * Variables: `{{campo}}` es el valor del campo de la fila (después del
 * cambio); `{{antes.campo}}` el de antes; también `{{nombre}}` (la etiqueta de
 * la fila), `{{app}}`, `{{enlace}}` y `{{motivo}}` (de un rechazo). Un
 * nombre que no existe se pinta vacío: una plantilla mal escrita no tumba la
 * corrida.
 */

export const TRIGGER_KINDS = [
  'row_created',
  'row_updated',
  'row_flagged_duplicate',
  'form_submitted',
  'approval_decided',
  'schedule',
  'button',
  'rows_poll',
  'row_deleted',
  'accounting_event',
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Los que miran una tabla (el resto no tiene fila). */
export const ROW_TRIGGER_KINDS: ReadonlySet<TriggerKind> = new Set([
  'row_created',
  'row_updated',
  'row_flagged_duplicate',
  'form_submitted',
  'approval_decided',
  'rows_poll',
  'row_deleted',
  'accounting_event',
]);

const slug = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,47}$/, 'Un identificador en minúsculas, sin espacios.');
const fieldKey = z.string().trim().min(1).max(32);
const plain = z.union([z.string().max(300), z.number()]);

/** Mínimos de «cada X minutos»: el despachador pasa cada minuto, pero nadie necesita menos de 10. */
export const POLL_MIN_MINUTES = 10;
export const POLL_MAX_ROWS = 25;
export const POLL_DEFAULT_ROWS = 10;

/**
 * La ventana de fechas de «cada X minutos»: sólo filas cuya fecha (y hora, si
 * hay campo de hora) está entre `beforeHours` antes y `afterHours` después.
 * Ej.: un vuelo se sigue desde 6 h antes de su hora hasta 24 h después.
 */
export const pollWindowSchema = z.object({
  /** Campo de fecha (o fecha y hora en texto) de la fila. */
  field: fieldKey,
  /** Campo con la hora «HH:MM»; vacío = el comienzo del día. */
  timeField: fieldKey.optional(),
  beforeHours: z.number().min(0).max(720).default(0),
  afterHours: z.number().min(0).max(720).default(24),
});
export type PollWindow = z.infer<typeof pollWindowSchema>;

export const automationTriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('row_created'), tracker: slug }),
  z.object({
    type: z.literal('row_updated'),
    tracker: slug,
    /** Sólo si cambió este campo. */
    field: fieldKey.optional(),
    /** Y sólo si pasó a este valor («pasó a Despachada»). */
    to: plain.optional(),
  }),
  z.object({ type: z.literal('row_flagged_duplicate'), tracker: slug }),
  /** Se borra una fila (la fila ya no existe: sus valores van en el suceso). */
  z.object({ type: z.literal('row_deleted'), tracker: slug }),
  z.object({
    type: z.literal('form_submitted'),
    tracker: slug,
    /** Pantalla (slug) donde se llenó; vacío = cualquiera. */
    screen: slug.optional(),
    /** Bloque del formulario; vacío = cualquiera. */
    block: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/)
      .optional(),
  }),
  z.object({
    type: z.literal('approval_decided'),
    tracker: slug,
    decision: z.enum(['approved', 'rejected', 'any']).default('any'),
  }),
  z.object({
    type: z.literal('schedule'),
    cadence: z.enum(['daily', 'weekly']),
    /** Hora de Bogotá, 0–23. */
    hour: z.number().int().min(0).max(23),
    /** 1 = lunes … 7 = domingo; sólo para `weekly`. */
    weekday: z.number().int().min(1).max(7).optional(),
  }),
  z.object({
    type: z.literal('rows_poll'),
    tracker: slug,
    /** Cada cuántos minutos se mira la tabla (mínimo 10). */
    everyMinutes: z.number().int().min(POLL_MIN_MINUTES).max(1440),
    /** Frecuencia mínima por fila; vacío = la misma de `everyMinutes`. */
    perRowMinutes: z.number().int().min(POLL_MIN_MINUTES).max(10080).optional(),
    /** Tope de filas por vuelta (las que más tiempo llevan sin atenderse van primero). */
    maxRows: z.number().int().min(1).max(POLL_MAX_ROWS).default(POLL_DEFAULT_ROWS),
    window: pollWindowSchema.optional(),
  }),
  /**
   * UN SUCESO CONTABLE («una factura queda pagada en Siigo»). Sale de comparar
   * antes y después las filas que la sincronización escribe en las tablas del
   * programa; la fila de partida es la factura, el recibo, la nota o el cliente
   * (sus campos sirven en `{{numero}}`, `{{saldo}}`, `{{cliente}}`…).
   */
  z.object({
    type: z.literal('accounting_event'),
    event: z.enum(ACCOUNTING_EVENTS),
    provider: z.enum(ACCOUNTING_PROVIDER_IDS as unknown as [string, ...string[]]).default('siigo'),
    /**
     * Sólo para `stock_low`: avisa cuando las existencias de una bodega llegan a
     * este número o menos. Sin él, usa el mínimo de cada producto.
     */
    threshold: z.number().min(0).max(1_000_000_000).optional(),
  }),
  z.object({
    type: z.literal('button'),
    /** Pantalla (slug) donde sale el botón. */
    screen: slug,
    /** Identificador estable del botón dentro de la app. */
    id: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,31}$/),
    label: z.string().trim().min(1).max(40),
    /** Al tocarlo, además abre otra pantalla de la app (con valores fijos prellenados). */
    next: thenSchema.optional(),
  }),
]);
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

export const changedConditionSchema = z.object({
  type: z.literal('changed'),
  field: fieldKey,
  from: plain.optional(),
  to: plain.optional(),
});
export type ChangedCondition = z.infer<typeof changedConditionSchema>;

/** Las condiciones son los filtros de las vistas más «cambió de X a Y». */
export const automationConditionSchema = z.union([changedConditionSchema, filterSchema]);
export type AutomationCondition = z.infer<typeof automationConditionSchema>;

const text = (max: number) => z.string().trim().min(1).max(max);
const emailSchema = z.string().trim().toLowerCase().email().max(200);

/** Las únicas herramientas que `ask_cortex.allow` puede soltar sin aprobación. */
export const ASK_ALLOWABLE_TOOLS = ['gdrive.upload_file', 'whatsapp.group_send'] as const;
export const ASK_ALLOW_LABEL: Record<(typeof ASK_ALLOWABLE_TOOLS)[number], string> = {
  'gdrive.upload_file': 'Guardar archivos en una carpeta de Drive que ya existe',
  'whatsapp.group_send': 'Escribir en un grupo de WhatsApp habilitado',
};

export const MAX_ACTIONS = 8;
/** Filas que una sola acción puede cambiar en otra tabla (y lo que se cambia si no se dice). */
export const MAX_RELATED_ROWS = 200;
export const DEFAULT_RELATED_ROWS = 50;
/** Espera dentro de una regla: de 1 minuto a 7 días. */
export const WAIT_MIN_MINUTES = 1;
export const WAIT_MAX_MINUTES = 10080;
export const ROLLUP_OPS = ['sum', 'count', 'avg', 'min', 'max'] as const;
export type RollupOp = (typeof ROLLUP_OPS)[number];
export const ROLLUP_OP_LABEL: Record<RollupOp, string> = {
  sum: 'la suma',
  count: 'el conteo',
  avg: 'el promedio',
  min: 'el mínimo',
  max: 'el máximo',
};

const fixedOrTemplate = z.union([z.string().max(300), z.number()]);
const setValues = z.record(fieldKey, fixedOrTemplate);

/**
 * Lo que cualquier acción puede traer además de lo suyo (todo opcional: las
 * reglas guardadas antes no lo tienen):
 *   - `if`: sólo se hace si la fila cumple estas condiciones (las mismas de la regla).
 *   - `otherwise`: es la RAMA «si no» de la acción anterior que tiene `if`: se hace
 *     justo cuando esa no se hizo por no cumplirse su condición.
 */
const branch = {
  if: z.array(automationConditionSchema).min(1).max(4).optional(),
  otherwise: z.boolean().optional(),
};
export const MAX_CONDITIONS = 8;
export const MAX_EMAIL_RECIPIENTS = 10;

export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set_field'),
    ...branch,
    field: fieldKey,
    value: z.union([z.string().max(300), z.number()]),
  }),
  z.object({
    type: z.literal('create_row'),
    ...branch,
    /** Otra tabla (o la misma) donde se crea la fila. */
    tracker: slug,
    /** Valores fijos o con variables `{{campo}}` de la fila que disparó. */
    values: z.record(fieldKey, z.union([z.string().max(300), z.number()])),
  }),
  z.object({
    type: z.literal('notify_member'),
    ...branch,
    /** Miembros de Cortex (ids). */
    members: z.array(z.string().uuid()).max(20).default([]),
    /** Roles de la app: avisa a los miembros de Cortex asignados a esos roles. */
    roles: z.array(roleKeySchema).max(8).default([]),
    /** Owners y admins de la empresa. */
    admins: z.boolean().default(false),
    /** Sólo a quienes tienen el turno abierto ahora (con ubicación compartida) en la app. */
    onShift: z.boolean().optional(),
    title: text(160),
    body: z.string().trim().max(600).optional(),
  }),
  z.object({
    type: z.literal('notify_app_user'),
    ...branch,
    /** El creador de la fila, o los usuarios de la app con un rol. */
    to: z.union([z.literal('creator'), z.object({ role: roleKeySchema })]),
    /** Sólo a quienes tienen el turno abierto ahora (con ubicación compartida) en la app. */
    onShift: z.boolean().optional(),
    title: text(120),
    body: z.string().trim().max(400).optional(),
    /** Pantalla que abre el aviso (slug); vacío = la app. */
    screen: slug.optional(),
  }),
  z.object({
    type: z.literal('email'),
    ...branch,
    to: z.array(emailSchema).max(MAX_EMAIL_RECIPIENTS).default([]),
    /** Usuarios de la app con estos roles. */
    roles: z.array(roleKeySchema).max(8).default([]),
    subject: text(160),
    body: text(2000),
  }),
  z.object({
    type: z.literal('webhook'),
    ...branch,
    url: z.string().trim().url().max(500),
  }),
  z.object({
    type: z.literal('ask_cortex'),
    ...branch,
    /** Lo que Cortex debe hacer, en texto; puede usar `{{campo}}`. */
    instruction: text(3000),
    /**
     * Qué puede escribir SIN aprobación en la fila que disparó la regla:
     * `'row'` = cualquier campo de ESA fila; una lista = sólo esos campos.
     * Vacío = como antes (la tabla de la regla; lo demás pasa por aprobación).
     * Escribir en otra fila u otra tabla siempre pide aprobación.
     */
    writes: z.union([z.literal('row'), z.array(fieldKey).min(1).max(30)]).optional(),
    /**
     * Herramientas con efecto FUERA de Cortex que esta instrucción puede usar SIN
     * aprobación (quien la escribió lo declara a conciencia): guardar un archivo
     * en una carpeta de Drive que ya existe, o mandar un mensaje a un grupo de
     * WhatsApp que la empresa habilitó (con sus topes). Lo que no se declara aquí
     * sigue pidiendo aprobación, como siempre.
     */
    allow: z.array(z.enum(ASK_ALLOWABLE_TOOLS)).max(2).optional(),
  }),
  /**
   * MARCAR LA ZONA DE QUIEN HIZO ESTO. Toma la última posición de la persona que
   * disparó el suceso (si es reciente) —o la de un campo de ubicación de la fila— y la
   * compara con los lugares de la app (círculos o polígonos, ver geofence.ts). Escribe
   * en ESTA fila: la zona, «Sí/No/Sin señal» de fuera de zona y, si se pide, la
   * ubicación. Las acciones que siguen ya ven esos valores (`if`, `{{zona}}`): así un
   * «fuera de zona» se avisa al supervisor en la misma regla. No bloquea nada: deja
   * trabajar, marca y avisa.
   */
  z.object({
    type: z.literal('check_zone'),
    ...branch,
    /** Campo de ubicación («lat,lng») de la fila; vacío = la posición en vivo de quien lo hizo. */
    from: fieldKey.optional(),
    /** Lugares (ids) que cuentan como «dentro»; vacío = todos los de la app. */
    zones: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,31}$/)).max(30).optional(),
    /** Campo (texto) donde queda el nombre de la zona. */
    zoneField: fieldKey.optional(),
    /** Campo (texto o opciones) donde queda Sí / No / Sin señal. */
    outsideField: fieldKey.optional(),
    outsideValue: z.string().max(40).default('Sí'),
    insideValue: z.string().max(40).default('No'),
    unknownValue: z.string().max(40).default('Sin señal'),
    /** Campo de ubicación donde se guarda la posición usada (si `from` no es de la fila). */
    locationField: fieldKey.optional(),
    /** Qué tan vieja puede ser la posición en vivo para valer. */
    maxAgeMinutes: z.number().int().min(1).max(120).default(10),
  }),
  z.object({
    type: z.literal('update_related'),
    ...branch,
    /**
     * SUBIR: campo de relación de la tabla de esta fila; se cambia la fila a la
     * que apunta (la atención → su vuelo).
     */
    up: fieldKey.optional(),
    /**
     * BAJAR: las filas de `tracker` cuyo campo de relación `via` apunta a ESTA
     * fila (el vuelo → todas sus atenciones). `where` acota cuáles.
     */
    down: z.object({ tracker: slug, via: fieldKey }).optional(),
    where: z.array(filterSchema).max(4).optional(),
    /** Campos de la fila relacionada → valor fijo o con `{{campo}}` de la fila que disparó. */
    set: setValues,
    /** Tope de filas al bajar (por defecto 50, máx. 200); si hay más, se avisa. */
    max: z.number().int().min(1).max(MAX_RELATED_ROWS).optional(),
  }),
  z.object({
    type: z.literal('update_rows'),
    ...branch,
    /** Otra tabla (o la misma) donde se buscan las filas. */
    tracker: slug,
    /** Qué filas: filtros como los de las vistas; los valores pueden llevar `{{campo}}`. */
    where: z.array(filterSchema).min(1).max(6),
    set: setValues,
    max: z.number().int().min(1).max(MAX_RELATED_ROWS).optional(),
  }),
  /**
   * CASAR POR CLAVE: deja puesta la relación entre esta fila y otra tabla, buscando
   * en el campo `on` lo que dice `value` (claves separadas por «/», «,» o «;», sin
   * importar espacios, guiones ni mayúsculas; o montos con `tolerance`).
   * `up`: esta fila recibe la relación a la ÚNICA fila que coincide (varias o ninguna
   * = se deja para casar a mano). `down`: las filas de otra tabla que coinciden reciben
   * la relación a esta fila. Nunca pisa una relación ya asignada salvo `overwrite`.
   */
  z.object({
    type: z.literal('link_rows'),
    ...branch,
    up: fieldKey.optional(),
    down: z.object({ tracker: slug, via: fieldKey }).optional(),
    /** Campo de la otra tabla donde se busca la clave (o el monto). */
    on: fieldKey,
    /** Lo que se busca: texto con `{{campos}}` de esta fila (varias claves separadas por «/»). */
    value: z.string().trim().min(1).max(300),
    /** Con tolerancia, `on` y `value` se comparan como MONTOS (diferencia máxima, en la unidad del campo). */
    tolerance: z.number().min(0).max(1e9).optional(),
    /** Sólo cuentan las filas de la otra tabla que cumplan estos filtros. */
    where: z.array(filterSchema).max(4).optional(),
    /** Otros campos que se escriben junto con la relación (en la fila que la recibe). */
    set: setValues.optional(),
    overwrite: z.boolean().optional(),
    max: z.number().int().min(1).max(MAX_RELATED_ROWS).optional(),
  }),
  z.object({
    type: z.literal('rollup'),
    ...branch,
    /**
     * Campo de relación de la tabla de esta fila (la hija) hacia la fila padre
     * (la atención → su vuelo). Se recalcula en la fila padre, con TODAS sus hijas.
     */
    up: fieldKey,
    /** Campo (number/money) de la fila padre donde queda el resultado. */
    target: fieldKey,
    op: z.enum(ROLLUP_OPS),
    /** Campo (number/money) de las hijas que se acumula; el conteo no lo necesita. */
    field: fieldKey.optional(),
    /** Sólo cuentan las hijas que cumplan estos filtros. */
    where: z.array(filterSchema).max(4).optional(),
  }),
  /**
   * REPORTE QUE SALE SOLO: arma una tabla (consulta agregada sobre una tabla de
   * la app o una pantalla) y la manda por correo a direcciones y/o roles, con la
   * tabla en el cuerpo y Excel y/o PDF adjuntos. Ver report-spec.ts.
   */
  z.object({
    type: z.literal('report'),
    ...branch,
    ...reportBodySchema,
  }),
  /**
   * PREFACTURA A SIIGO: arma la prefactura de la fila (cliente por NIT, ítems,
   * observaciones) y la deja POR REVISAR en Cortex; sólo al aprobarla una persona
   * se crea en Siigo. Ver invoice-draft-spec.ts.
   */
  z.object({
    type: z.literal('accounting_draft_invoice'),
    ...branch,
    ...invoiceBodySchema,
  }),
  /** CLIENTE A SIIGO: crea el tercero si no existe (por NIT); queda POR REVISAR. */
  z.object({ type: z.literal('accounting_upsert_customer'), ...branch, ...customerBodySchema }),
  /** RECIBO DE CAJA: un pago que entró; se cruza contra las facturas del cliente. POR REVISAR. */
  z.object({ type: z.literal('accounting_draft_receipt'), ...branch, ...receiptBodySchema }),
  /** NOTA CRÉDITO: anula o rebaja una factura. POR REVISAR. */
  z.object({ type: z.literal('accounting_draft_credit_note'), ...branch, ...creditNoteBodySchema }),
  z.object({
    type: z.literal('wait'),
    ...branch,
    /** Cuánto esperar antes de seguir con las acciones que vienen después. */
    minutes: z.number().int().min(WAIT_MIN_MINUTES).max(WAIT_MAX_MINUTES),
    /**
     * Al volver, la fila se lee de nuevo y tiene que cumplir esto para seguir; si no,
     * la regla termina ahí («omitida»). Sin decirlo = las condiciones de la propia regla
     * (menos «cambió de X a Y»); lista vacía = seguir siempre.
     */
    stillIf: z.array(automationConditionSchema).max(MAX_CONDITIONS).optional(),
  }),
]);
export type AutomationAction = z.infer<typeof automationActionSchema>;
export type ActionType = AutomationAction['type'];

export const ACTION_LABEL: Record<ActionType, string> = {
  set_field: 'Cambiar un campo',
  create_row: 'Crear una fila en otra tabla',
  notify_member: 'Avisar a miembros del equipo',
  notify_app_user: 'Avisar a usuarios de la app',
  email: 'Mandar un correo',
  webhook: 'Llamar a otro sistema (webhook)',
  ask_cortex: 'Pedirle algo a Cortex',
  check_zone: 'Marcar la zona y si está fuera de zona',
  update_related: 'Cambiar filas relacionadas (subir o bajar por una relación)',
  update_rows: 'Cambiar filas de otra tabla por filtro',
  rollup: 'Acumular en la fila padre (suma, conteo, promedio…)',
  link_rows: 'Casar con otra tabla por una clave (deja puesta la relación)',
  report: 'Mandar un reporte por correo (tabla + Excel / PDF)',
  accounting_draft_invoice: 'Preparar una prefactura para Siigo (por revisar)',
  accounting_upsert_customer: 'Crear el cliente en Siigo si no existe (por revisar)',
  accounting_draft_receipt: 'Preparar un recibo de caja en Siigo (por revisar)',
  accounting_draft_credit_note: 'Preparar una nota crédito en Siigo (por revisar)',
  wait: 'Esperar y volver a revisar',
};

export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  row_created: 'Se crea una fila',
  row_updated: 'Cambia una fila',
  row_flagged_duplicate: 'Una fila queda marcada como duplicada',
  form_submitted: 'Se envía un formulario',
  approval_decided: 'Se aprueba o se rechaza',
  schedule: 'A una hora',
  button: 'Alguien toca un botón',
  rows_poll: 'Cada cierto tiempo, para cada fila que cumpla',
  row_deleted: 'Se borra una fila',
  accounting_event: 'Pasa algo en el programa contable',
};

export const automationInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(true),
  trigger: automationTriggerSchema,
  conditions: z.array(automationConditionSchema).max(MAX_CONDITIONS).default([]),
  actions: z.array(automationActionSchema).min(1).max(MAX_ACTIONS),
});
export type AutomationInput = z.infer<typeof automationInputSchema>;

export function triggerTracker(t: AutomationTrigger): string | null {
  if (t.type === 'accounting_event')
    return accountingEventTableSlug(t.provider as (typeof ACCOUNTING_PROVIDER_IDS)[number], t.event);
  return 'tracker' in t ? t.tracker : null;
}

export { ACCOUNTING_EVENT_LABEL };

/** Los problemas que no dependen de la base: una acción que necesita fila en un disparador sin fila. */
export function structuralProblems(input: AutomationInput): string[] {
  const out: string[] = [];
  const rowless = !ROW_TRIGGER_KINDS.has(input.trigger.type);
  if (rowless) {
    if (input.conditions.length)
      out.push(
        'Las condiciones comparan campos de una fila; este disparador (hora o botón) no tiene fila.',
      );
    for (const a of input.actions) {
      if (a.type === 'set_field')
        out.push('«Cambiar un campo» necesita una fila; con un horario o un botón no hay fila.');
      if (a.type === 'notify_app_user' && a.to === 'creator')
        out.push('«Al creador de la fila» necesita una fila; elige un rol.');
    }
  }
  if (
    input.trigger.type === 'schedule' &&
    input.trigger.cadence === 'weekly' &&
    !input.trigger.weekday
  )
    out.push('Un horario semanal necesita el día de la semana.');
  if (input.trigger.type === 'rows_poll') {
    const t = input.trigger;
    if (t.perRowMinutes !== undefined && t.perRowMinutes < t.everyMinutes)
      out.push('La frecuencia por fila no puede ser menor que «cada cuántos minutos» se mira.');
  }
  const allConditions: AutomationCondition[] = [
    ...input.conditions,
    ...input.actions.flatMap((a) => [
      ...(a.if ?? []),
      ...(a.type === 'wait' ? (a.stillIf ?? []) : []),
    ]),
  ];
  for (const c of allConditions) {
    if (
      'type' in c &&
      c.type === 'changed' &&
      input.trigger.type !== 'row_updated' &&
      input.trigger.type !== 'approval_decided'
    ) {
      out.push('«Cambió de X a Y» sólo tiene sentido cuando el disparador es «Cambia una fila».');
      break;
    }
  }
  for (const a of input.actions) {
    if (a.type === 'email' && !a.to.length && !a.roles.length)
      out.push('El correo necesita al menos una dirección o un rol.');
    if (a.type === 'notify_member' && !a.members.length && !a.roles.length && !a.admins)
      out.push('El aviso al equipo necesita a quién: miembros, roles o administradores.');
    if (a.type === 'ask_cortex' && a.writes && rowless)
      out.push('«Escribir en la fila» necesita una fila; con un horario o un botón no hay fila.');
    if (a.type === 'check_zone' && rowless)
      out.push('«Marcar la zona» escribe en una fila; con un horario o un botón no hay fila.');
    if (a.type === 'check_zone' && !a.zoneField && !a.outsideField && !a.locationField)
      out.push('«Marcar la zona» necesita al menos un campo donde dejar la zona o el «fuera de zona».');
    if (a.type === 'webhook' && !a.url.toLowerCase().startsWith('https://'))
      out.push('El webhook sólo acepta direcciones https.');
    if (a.type === 'report' && !a.to.length && !a.roles.length)
      out.push('El reporte necesita al menos una dirección o un rol.');
    if (a.type === 'report' && a.to.length + a.roles.length > REPORT_MAX_RECIPIENTS)
      out.push(`Un reporte admite hasta ${REPORT_MAX_RECIPIENTS} destinatarios entre direcciones y roles.`);
    if (a.type === 'accounting_draft_invoice' && rowless)
      out.push('«Preparar una prefactura» parte de una fila (un cierre, una atención…); con un horario o un botón no hay fila.');
    if (a.type === 'accounting_draft_invoice' && a.send === 'siigo_sin_dian' && !a.writeBack?.invoiceNumber)
      out.push('Con «crear en Siigo sin enviar a la DIAN» hace falta `writeBack.invoiceNumber`: el campo donde queda el número de la factura creada.');
    if (a.type === 'accounting_draft_invoice' && a.currency !== 'COP' && a.trm === undefined)
      out.push(`Los precios están en ${a.currency}: falta la TRM (\`trm\`) para pasarlos a pesos.`);
    if (
      (a.type === 'accounting_upsert_customer' ||
        a.type === 'accounting_draft_receipt' ||
        a.type === 'accounting_draft_credit_note') &&
      rowless
    )
      out.push(`«${ACTION_LABEL[a.type]}» parte de una fila (un pago, una anulación…); con un horario o un botón no hay fila.`);
    if (a.type === 'accounting_draft_credit_note' && a.mode === 'items' && !a.items?.length)
      out.push('Una nota crédito «por ítems» necesita sus líneas (`items`); para anular toda la factura usa mode «total».');
    if (a.type === 'accounting_draft_credit_note' && a.mode === 'total' && a.items?.length)
      out.push('Con mode «total» se copian las líneas de la factura: quita `items` o usa mode «items».');
    if (a.type === 'accounting_draft_invoice' && a.customer.via && rowless)
      out.push('«Cliente de la fila relacionada» necesita una fila de partida.');
  }
  if (input.trigger.type === 'row_deleted') {
    if (input.actions.some((a) => a.type === 'set_field'))
      out.push(
        '«Cambiar un campo» no sirve cuando la fila se borró; cambia otra fila con «filas relacionadas».',
      );
    if (input.actions.some((a) => a.type === 'notify_app_user' && a.to === 'creator'))
      out.push('«Al creador de la fila» no sirve cuando la fila se borró; elige un rol.');
  }
  out.push(...flowProblems(input, rowless));
  return [...new Set(out)];
}

/** Los problemas de las ramas («si» / «si no»), la espera y las acciones sobre filas relacionadas. */
function flowProblems(input: AutomationInput, rowless: boolean): string[] {
  const out: string[] = [];
  let lastConditional = -1;
  input.actions.forEach((a, i) => {
    const n = i + 1;
    if (a.otherwise) {
      if (a.if) out.push(`Acción ${n}: una rama «si no» no lleva su propia condición.`);
      if (lastConditional < 0)
        out.push(`Acción ${n}: «si no» necesita una acción anterior con condición («si»).`);
    }
    if (a.if) lastConditional = i;
    if (rowless && a.if)
      out.push(`Acción ${n}: una condición compara campos de una fila; sin fila no hay con qué.`);
    switch (a.type) {
      case 'update_related':
        if (!!a.up === !!a.down)
          out.push(
            `Acción ${n}: «cambiar filas relacionadas» necesita UNA dirección: \`up\` (subir a la fila a la que apunta) o \`down\` (bajar a las filas que apuntan a esta).`,
          );
        if (!Object.keys(a.set).length)
          out.push(`Acción ${n}: falta qué campos cambiar (\`set\`).`);
        if (a.up && a.where?.length)
          out.push(`Acción ${n}: al subir hay una sola fila; \`where\` sólo sirve al bajar.`);
        if (a.up && a.max !== undefined)
          out.push(`Acción ${n}: al subir hay una sola fila; \`max\` sólo sirve al bajar.`);
        if (rowless) out.push(`Acción ${n}: «filas relacionadas» necesita una fila de partida.`);
        break;
      case 'link_rows':
        if (!!a.up === !!a.down)
          out.push(
            `Acción ${n}: «casar» necesita UNA dirección: \`up\` (esta fila recibe la relación) o \`down\` (las filas de otra tabla la reciben).`,
          );
        if (a.up && a.max !== undefined)
          out.push(`Acción ${n}: al subir hay una sola fila; \`max\` sólo sirve al bajar.`);
        if (rowless) out.push(`Acción ${n}: «casar» necesita una fila de partida.`);
        break;
      case 'update_rows':
        if (!Object.keys(a.set).length)
          out.push(`Acción ${n}: falta qué campos cambiar (\`set\`).`);
        break;
      case 'rollup':
        if (a.op !== 'count' && !a.field)
          out.push(
            `Acción ${n}: ${ROLLUP_OP_LABEL[a.op]} necesita \`field\` (el campo de las hijas).`,
          );
        if (rowless) out.push(`Acción ${n}: acumular necesita una fila de partida (la hija).`);
        break;
      case 'wait':
        if (a.stillIf?.length && rowless)
          out.push(
            `Acción ${n}: «seguir si…» compara campos de una fila; sin fila no hay con qué.`,
          );
        break;
      default:
        break;
    }
  });
  if (!input.actions.some((a) => !a.otherwise && a.type !== 'wait') && input.actions.length)
    out.push('La regla sólo espera: agrega qué hacer después.');
  const lastIsWait = input.actions[input.actions.length - 1]?.type === 'wait';
  if (lastIsWait)
    out.push('La espera no puede ser lo último: agrega qué hacer después de esperar.');
  return out;
}
