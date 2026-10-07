import { z } from 'zod';
import { filterSchema } from '../../views/spec';
import { roleKeySchema } from '../permissions';

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
] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Los que miran una tabla (el resto no tiene fila). */
export const ROW_TRIGGER_KINDS: ReadonlySet<TriggerKind> = new Set([
  'row_created',
  'row_updated',
  'row_flagged_duplicate',
  'form_submitted',
  'approval_decided',
]);

const slug = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,47}$/, 'Un identificador en minúsculas, sin espacios.');
const fieldKey = z.string().trim().min(1).max(32);
const plain = z.union([z.string().max(300), z.number()]);

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
    type: z.literal('button'),
    /** Pantalla (slug) donde sale el botón. */
    screen: slug,
    /** Identificador estable del botón dentro de la app. */
    id: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,31}$/),
    label: z.string().trim().min(1).max(40),
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

export const MAX_ACTIONS = 8;
export const MAX_CONDITIONS = 8;
export const MAX_EMAIL_RECIPIENTS = 10;

export const automationActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('set_field'),
    field: fieldKey,
    value: z.union([z.string().max(300), z.number()]),
  }),
  z.object({
    type: z.literal('create_row'),
    /** Otra tabla (o la misma) donde se crea la fila. */
    tracker: slug,
    /** Valores fijos o con variables `{{campo}}` de la fila que disparó. */
    values: z.record(fieldKey, z.union([z.string().max(300), z.number()])),
  }),
  z.object({
    type: z.literal('notify_member'),
    /** Miembros de Cortex (ids). */
    members: z.array(z.string().uuid()).max(20).default([]),
    /** Roles de la app: avisa a los miembros de Cortex asignados a esos roles. */
    roles: z.array(roleKeySchema).max(8).default([]),
    /** Owners y admins de la empresa. */
    admins: z.boolean().default(false),
    title: text(160),
    body: z.string().trim().max(600).optional(),
  }),
  z.object({
    type: z.literal('notify_app_user'),
    /** El creador de la fila, o los usuarios de la app con un rol. */
    to: z.union([z.literal('creator'), z.object({ role: roleKeySchema })]),
    title: text(120),
    body: z.string().trim().max(400).optional(),
    /** Pantalla que abre el aviso (slug); vacío = la app. */
    screen: slug.optional(),
  }),
  z.object({
    type: z.literal('email'),
    to: z.array(emailSchema).max(MAX_EMAIL_RECIPIENTS).default([]),
    /** Usuarios de la app con estos roles. */
    roles: z.array(roleKeySchema).max(8).default([]),
    subject: text(160),
    body: text(2000),
  }),
  z.object({
    type: z.literal('webhook'),
    url: z.string().trim().url().max(500),
  }),
  z.object({
    type: z.literal('ask_cortex'),
    /** Lo que Cortex debe hacer, en texto; puede usar `{{campo}}`. */
    instruction: text(1500),
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
};

export const TRIGGER_LABEL: Record<TriggerKind, string> = {
  row_created: 'Se crea una fila',
  row_updated: 'Cambia una fila',
  row_flagged_duplicate: 'Una fila queda marcada como duplicada',
  form_submitted: 'Se envía un formulario',
  approval_decided: 'Se aprueba o se rechaza',
  schedule: 'A una hora',
  button: 'Alguien toca un botón',
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
  return 'tracker' in t ? t.tracker : null;
}

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
  for (const c of input.conditions) {
    if (
      'type' in c &&
      c.type === 'changed' &&
      input.trigger.type !== 'row_updated' &&
      input.trigger.type !== 'approval_decided'
    )
      out.push('«Cambió de X a Y» sólo tiene sentido cuando el disparador es «Cambia una fila».');
  }
  for (const a of input.actions) {
    if (a.type === 'email' && !a.to.length && !a.roles.length)
      out.push('El correo necesita al menos una dirección o un rol.');
    if (a.type === 'notify_member' && !a.members.length && !a.roles.length && !a.admins)
      out.push('El aviso al equipo necesita a quién: miembros, roles o administradores.');
    if (a.type === 'webhook' && !a.url.toLowerCase().startsWith('https://'))
      out.push('El webhook sólo acepta direcciones https.');
  }
  return [...new Set(out)];
}
