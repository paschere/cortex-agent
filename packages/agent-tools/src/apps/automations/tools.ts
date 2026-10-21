import { ForbiddenError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { ACCOUNTING_EVENT_LABEL } from '../../accounting/events';
import { isCompanyManager } from '../../directory/store';
import { registerTool } from '../../index';
import { mustGetApp } from '../store';
import { simulateAutomation } from './simulate';
import {
  ACTION_LABEL,
  type AutomationInput,
  TRIGGER_LABEL,
  automationActionSchema,
  automationConditionSchema,
  automationInputSchema,
  automationTriggerSchema,
  structuralProblems,
} from './spec';
import {
  type AutomationRow,
  createAutomation,
  lastRuns,
  listAutomations,
  mustGetAutomation,
  setAutomationEnabled,
  updateAutomation,
} from './store';
import { AUTOMATION_TEMPLATES, templateById } from './templates';

/**
 * Las automatizaciones de una app desde el chat (migración 0210): listar,
 * crear (de una plantilla o con Cuando / Si / Entonces), cambiar y pausar.
 * Lo que cambia pide confirmación y sólo es de quien administra la empresa,
 * como el editor. Probar con una fila de ejemplo está en el editor.
 */

async function requireAppAdmin(ctx: { db: SupabaseClient; userId: string }): Promise<void> {
  if (!(await isCompanyManager(ctx.db, ctx.userId)))
    throw new ForbiddenError(
      'Sólo quien administra la empresa o es su dueño puede cambiar las automatizaciones.',
    );
}

/** Una línea legible: «Cuando … → entonces …». */
export function describeAutomation(
  a: Pick<AutomationRow, 'trigger' | 'actions' | 'conditions'>,
): string {
  const t = a.trigger;
  const when =
    t.type === 'schedule'
      ? `${t.cadence === 'daily' ? 'Todos los días' : `Cada semana (día ${t.weekday ?? 1})`} a las ${String(t.hour).padStart(2, '0')}:00`
      : t.type === 'button'
        ? `Cuando toquen «${t.label}» en ${t.screen}`
        : t.type === 'rows_poll'
          ? `Cada ${t.everyMinutes} min, para cada fila de ${t.tracker} que cumpla (hasta ${t.maxRows} por vuelta)`
          : t.type === 'accounting_event'
            ? `${ACCOUNTING_EVENT_LABEL[t.event]} (${t.provider})`
            : `${TRIGGER_LABEL[t.type]} en ${'tracker' in t ? t.tracker : ''}`;
  const ifs = a.conditions.length ? ` si se cumplen ${a.conditions.length} condición(es)` : '';
  return `${when}${ifs} → ${a.actions.map((x) => ACTION_LABEL[x.type].toLowerCase()).join(', ')}`;
}

const GRAMMAR = `Automation = {name, enabled?, trigger, conditions[], actions[]}.
trigger (Cuando): {type:"row_created",tracker} | {type:"row_updated",tracker,field?,to?} | {type:"row_flagged_duplicate",tracker} | {type:"form_submitted",tracker,screen?,block?} | {type:"approval_decided",tracker,decision:"approved"|"rejected"|"any"} | {type:"schedule",cadence:"daily"|"weekly",hour:0-23 (Bogota),weekday?:1-7} | {type:"accounting_event",event:"invoice_created"|"invoice_paid"|"invoice_overdue"|"invoice_annulled"|"receipt_created"|"credit_note_created"|"customer_created"|"purchase_created"|"supplier_payment_created"|"stock_low"|"quotation_created"|"invoice_rejected",threshold?:number (only stock_low: fire when a warehouse stock reaches this many units or fewer; omitted = the product's own minimum),provider?:"siigo"|"alegra"|"quickbooks" (default siigo)} (something happened in the accounting program: the starting row is the invoice / receipt / credit note / customer / purchase (fields numero, documento, proveedor, total, saldo, estado) / supplier payment (numero, proveedor, valor, compras) / quotation / stock line (producto, bodega, existencias, minimo, alerta) of the synced table, with fields numero, cliente, nit, fecha, vence, total, saldo, estado, factura (credit notes)...; it is derived from Cortex's sync of the program tables, which runs every 15 minutes, so it fires minutes after the fact; "invoice_overdue" and payments Siigo does not register as a receipt come out in the daily sweep; the first load never fires it) | {type:"button",screen,id,label,next?:{screen,prefill?:{field:fixedValue}}} (next = also open another screen of the app after the click) | {type:"row_deleted",tracker} (a row was deleted; the event carries the values it had) | {type:"rows_poll",tracker,everyMinutes:>=10,perRowMinutes?,maxRows?:1-25 (default 10),window?:{field,timeField?,beforeHours?,afterHours?}} (every N minutes, one run per row that meets the conditions and is inside the window of its date field; e.g. follow a flight from 6h before to 24h after).
conditions (Si): view filters {field,op,value?} plus {type:"changed",field,from?,to?}. Only for triggers with a row.
actions (Entonces, max 8): {type:"set_field",field,value} | {type:"create_row",tracker,values:{field:value}} | {type:"notify_member",members?:[userId],roles?:[roleKey],admins?,title,body?} | {type:"notify_app_user",to:"creator"|{role},title,body?,screen?} (push, or email if the person has no active push) | {type:"email",to?:[addresses],roles?:[roleKey],subject,body} | {type:"webhook",url:https} (HMAC-signed POST) | {type:"ask_cortex",instruction,writes?:"row"|[fieldKey],allow?:["gdrive.upload_file"|"whatsapp.group_send"]} (allow = outside-Cortex tools the instruction may use WITHOUT approval: save a file into an existing Drive folder, write to an enabled WhatsApp group; Cortex then finds folders with gdrive.find_folder and reads group replies with whatsapp.group_messages) (free-text instruction with {{fields}}; Cortex reads the web, the company brain and tables, and with writes it may change the row's own fields without approval — it does not write when unsure and cites its source in the run history; anything else it writes goes to approval). Example: "Busca en la web el estado del vuelo {{vuelo}} del {{fecha}} y actualiza estado, ETA y llegada; cita la fuente" or "Calcula el precio de esta atención con el documento «Reglas de precios» del cerebro; si falta un dato, no escribas el precio y di qué falta".
Every action also accepts two optional branch fields: "if":[conditions] (do it only when the row meets them; same shape as conditions, max 4) and "otherwise":true (the ELSE branch of the nearest earlier action that has "if": it runs exactly when that one was skipped). Example: [{type:"notify_member",...,if:[{field:"costo",op:"gt",value:1000000}]},{type:"email",...,otherwise:true}].
Connecting events between tables (all optional, all take {{fields}} of the row that fired the rule; relation fields store {id,label} and are copied whole by "{{relation_field}}"):
- {type:"update_related",up:"relation_field",set:{field:value}}: CHANGE THE ROW THIS ONE POINTS TO (the service record -> its flight). Or {type:"update_related",down:{tracker,via:"relation_field_of_that_table_pointing_here"},where?:[filters],set:{...},max?:1-200 (default 50)}: CHANGE ALL THE ROWS THAT POINT TO THIS ONE (the flight -> all its service records). Exactly one of up/down. Rows that already have the value are not touched (no loops).
- {type:"update_rows",tracker,where:[filters 1-6; values may use {{fields}}],set:{...},max?:1-200 (default 50)}: change rows of any table by filter. If more rows match than max, only the first max are changed and the run history says so.
- {type:"rollup",up:"relation_field_of_this_table",target:"number_or_money_field_of_the_parent",op:"sum"|"count"|"avg"|"min"|"max",field?:"child_number_field" (not needed for count),where?:[filters on the children]}: RECOMPUTE a total in the parent row from ALL its children (never "add one", so it is safe to run twice). Use it with triggers row_created + row_updated + row_deleted on the CHILD table (three rules, or one per event) so the total follows creates, edits and deletes. Example: "flight total cost = sum of each used item's total cost": child table "equipos_usados", up:"vuelo", target:"costo_total", op:"sum", field:"costo_total".
- {type:"wait",minutes:1-10080,stillIf?:[conditions]}: SLEEP the run, then re-read the row; if it still meets stillIf (omitted = the rule's own conditions; [] = always continue) the actions AFTER the wait run (with the row as it is then), otherwise the run ends as skipped. Not the last action. Example for "if in 2 hours the flight is still not Attended, warn the supervisor": trigger row_created on flights, conditions [], actions [{type:"wait",minutes:120,stillIf:[{field:"estado",op:"neq",value:"Atendido"}]},{type:"notify_member",...}].
- {type:"report",title,source,to?:[addresses],roles?:[roleKeys],formats?:["xlsx","pdf"] (default ["xlsx"]; the table always goes in the email body),subject?,intro?,maxPerDay?:1-20 (default 3; only for non-schedule triggers),skipIfEmpty?}: BUILD A REPORT AND EMAIL IT with the table in the body and Excel/PDF attached (full pesos, never "1,2 M"). source = {kind:"query",tracker,groupBy?:field,metrics:[{op:"sum"|"count"|"avg"|"min"|"max",field?,label?}] (1-4),where?:[filters],range?:{field:date field or "created_at"|"updated_at",preset:"today"|"yesterday"|"this_week"|"last_week"|"last_7_days"|"this_month"|"last_month"|"last_30_days"|"this_year"|"all"} (Bogota time, weeks Mon-Sun),sort?:"desc"|"asc"|"label",limit?:1-200,detail?:boolean (adds a detail sheet in the attachments)} or {kind:"screen",screen:"slug"} (the screen exactly as Export gives it). Works with any trigger; with a schedule it needs no row. Example "every Monday at 7 send Management the equipment cost by supplier of last week": trigger {type:"schedule",cadence:"weekly",weekday:1,hour:7}; actions [{type:"report",title:"Costo de equipos por proveedor",source:{kind:"query",tracker:"equipos_usados",groupBy:"proveedor",metrics:[{op:"sum",field:"costo"}],range:{field:"created_at",preset:"last_week"}},roles:["gerencia"],formats:["xlsx","pdf"]}]. Each send is written in the run history (range, rows, recipients, attachments). Preview it first with apps.report.preview.
- {type:"accounting_draft_invoice",customer:{taxId:"{{nit}}",name?,via?:"relation_field"},items:[{description,productCode?,quantity,unitPrice,priceList? (price list name or position, or {{field}} for the customer's list: with productCode the price comes from the synced table «Precios por lista» and unitPrice is the fallback),taxRate?:"iva_19"|"iva_5"|"iva_0"|"excluido"}] (1-10),currency?:"COP" (3 letters),trm?,observations?,paymentForm?:"contado"|"credito",paymentDays?,documentTypeId?,sellerId?,paymentTypeId?,writeBack?:{invoiceNumber?:field,status?:{field,pending?,created?}},notifyAdmins?:true,notifyRoles?:[]}: PREPARE A SIIGO PRE-INVOICE for the row and leave it in the inbox "Prefacturas por revisar"; NOTHING is sent to Siigo until a person approves it there (or with accounting.invoice_draft_approve). quantity/unitPrice/trm accept a number, "{{field}}" or a formula starting with "=" ("={{kilos}} * 0,80"; only + - * / and parentheses). customer.via = a relation field of this row: the NIT is read from the row it points to ("the flight's customer"). One row = one pre-invoice per rule (idempotent, even if discarded). If currency is not COP, trm is required and prices are converted to pesos. Example "when a service closes, prepare the pre-invoice with kilos x USD 0.80 for the flight's customer": trigger {type:"row_updated",tracker:"atenciones",field:"estado",to:"Cerrada"}; actions [{type:"accounting_draft_invoice",customer:{taxId:"{{nit_cliente}}",via:"vuelo"},items:[{description:"Atención {{vuelo}} · {{kilos}} kg",productCode:"SERV-001",quantity:"{{kilos}}",unitPrice:0.8}],currency:"USD",trm:"{{trm}}",writeBack:{invoiceNumber:"factura"}}].
- {type:"accounting_upsert_customer",taxId:"{{nit}}",name:"{{cliente}}",email?,phone?,address?,city? (municipality like "Bogota" or 5-digit DANE code),personType?:"auto"|"company"|"person",regime?:"responsable_iva"|"no_responsable",via?:"relation_field",writeBack?,notifyAdmins?,notifyRoles?}: PREPARE TO CREATE THE CUSTOMER (third party) IN SIIGO if its NIT is not there (the check digit is computed; an existing customer is never overwritten) and leave it in the inbox "Por enviar a Siigo"; nothing is sent until a person approves. Siigo requires address, city, phone and an e-mail contact: whatever is missing shows in the draft for the reviewer to fill. Idempotent per row and rule.
- {type:"accounting_draft_receipt",customer:{taxId:"{{nit}}",name?,via?},amount:number|"{{field}}"|"=formula",date?:"{{fecha}}" (default today, Bogota),invoices?:"FV-1-68, FV-1-70" (omitted = ALL the customer's open invoices in Siigo, the one due first first),reference?,bankAccount?,paymentTypeId?,writeBack?,notifyAdmins?,notifyRoles?}: PREPARE A CASH RECEIPT (recibo de caja) for a payment that came in and leave it in "Por enviar a Siigo"; registered in Siigo only when a person approves. The amount is applied oldest-due-first without exceeding each invoice balance; any leftover is flagged. Example "when the customer's payment comes in, prepare the receipt in Siigo against their invoices": trigger {type:"row_created",tracker:"pagos_clientes"}; actions [{type:"accounting_draft_receipt",customer:{taxId:"{{nit}}"},amount:"{{valor}}",date:"{{fecha}}",reference:"{{referencia}}"}].
- {type:"accounting_draft_credit_note",invoice:"{{factura}}",mode?:"total"|"items" (default total: copies the invoice lines),items?:[like accounting_draft_invoice items] (only mode items),reason?:1|2|3|4|6|7 (DIAN: 1 partial return, 2 annulment (default), 3 rebate, 4 price adjustment, 6 early payment, 7 volume),date?,observations?,documentTypeId?,paymentTypeId?,writeBack?,notifyAdmins?,notifyRoles?}: PREPARE A CREDIT NOTE against an invoice (cancel or return) and leave it in "Por enviar a Siigo"; created in Siigo only when a person approves (they choose whether it is stamped with the DIAN). Example "when the attention is annulled, prepare the credit note": trigger {type:"row_updated",tracker:"atenciones",field:"estado",to:"Anulada"}; actions [{type:"accounting_draft_credit_note",invoice:"{{factura}}",reason:2}].
Link back from Siigo (no extra action needed): the starting row of an accounting_event is the Siigo document, so "when the flight's invoice is paid in Siigo, mark the attention as Collected and tell Management" is trigger {type:"accounting_event",event:"invoice_paid"} + actions [{type:"update_rows",tracker:"atenciones",where:[{field:"factura",op:"eq",value:"{{numero}}"}],set:{estado_cobro:"Cobrada",saldo:"{{saldo}}",fecha_pago:"{{hoy}}"}},{type:"notify_member",admins:true,title:"Factura {{numero}} pagada ({{cliente}})"}]. {{hoy}} is today's date (Bogota). The match is by the invoice number stored in a field of the app's row (accounting_draft_invoice writeBack.invoiceNumber writes it there; for invoices created directly in Siigo the number can be typed or copied by a rule). Use event invoice_overdue to flag overdue rows and invoice_annulled to reopen them.
Chains: a change made by one rule can fire other rules; a rule never fires itself, not even through a loop A -> B -> A, and chains stop at depth 3. Example "when a service record closes, mark the flight as attended and add up the cost": trigger row_updated on atenciones field estado to "Cerrada"; actions [{type:"update_related",up:"vuelo",set:{estado:"Atendido"}},{type:"rollup",up:"vuelo",target:"costo_total",op:"sum",field:"costo"}]. Use apps.automations.test to see what a rule would change on a real row before turning it on.
Templates in text use {{field_key}}, {{antes.field_key}}, {{nombre}}, {{app}}, {{enlace}}, {{motivo}}. An automation never re-triggers itself (max depth 3). No WhatsApp: notices go by push and email only.`;

const summarySchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  description: z.string(),
  lastRunAt: z.string().nullable(),
  lastStatus: z.string().nullable(),
  lastError: z.string().nullable(),
});

export const appsAutomationsList = registerTool({
  id: 'apps.automations.list',
  description:
    'List the automations (Cuando / Si / Entonces rules) of an application, with their state and last run, plus the ready-made templates. Read-only.',
  inputSchema: z.object({ app: z.string().trim().min(1).max(80).describe('App id or slug.') }),
  outputSchema: z.object({
    automations: z.array(summarySchema),
    templates: z.array(z.object({ id: z.string(), name: z.string(), needs: z.array(z.string()) })),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const [rows, runs] = await Promise.all([
      listAutomations(ctx.db, app.id),
      lastRuns(ctx.db, app.id),
    ]);
    const automations = rows.map((a) => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      description: describeAutomation(a),
      lastRunAt: a.last_run_at,
      lastStatus: a.last_status,
      lastError: runs.get(a.id)?.error ?? null,
    }));
    const markdown = automations.length
      ? automations
          .map(
            (a) =>
              `- ${a.enabled ? '' : '(en pausa) '}**${a.name}** \`${a.id}\` — ${a.description}${a.lastStatus ? `. Última corrida: ${a.lastStatus}${a.lastError ? ` (${a.lastError})` : ''}` : ''}`,
          )
          .join('\n')
      : `**${app.name}** todavía no tiene automatizaciones. Puedo armar una desde una plantilla (${AUTOMATION_TEMPLATES.map((t) => `«${t.name}»`).join(', ')}) o con Cuando / Si / Entonces.`;
    return {
      automations,
      templates: AUTOMATION_TEMPLATES.map((t) => ({ id: t.id, name: t.name, needs: t.needs })),
      markdown,
    };
  },
});

export const appsAutomationsCreate = registerTool({
  id: 'apps.automations.create',
  description: `Create an automation for an application: from a ready-made template (duplicate_to_supervisor, rejected_to_operator, daily_summary, approved_to_dispatched) with its few parameters, or a custom Cuando / Si / Entonces rule. Tables, fields, screens and roles are validated against the real app before saving. Notices go only by push and email (no WhatsApp). Requires confirmation; company owners/admins only.
${GRAMMAR}`,
  inputSchema: z
    .object({
      app: z.string().trim().min(1).max(80).describe('App id or slug.'),
      template: z
        .object({
          id: z.enum(AUTOMATION_TEMPLATES.map((t) => t.id) as [string, ...string[]]),
          tracker: z.string().trim().max(60).optional(),
          role: z.string().trim().max(40).optional(),
          field: z.string().trim().max(32).optional(),
          value: z.string().trim().max(120).optional(),
          emails: z.array(z.string().trim().max(200)).max(10).optional(),
          hour: z.number().int().min(0).max(23).optional(),
        })
        .optional(),
      name: z.string().trim().min(1).max(120).optional(),
      trigger: automationTriggerSchema.optional(),
      conditions: z.array(automationConditionSchema).max(8).default([]),
      actions: z.array(automationActionSchema).max(8).optional(),
    })
    .refine((v) => Boolean(v.template) !== Boolean(v.trigger && v.actions?.length), {
      message: 'Da una plantilla, o un disparador con sus acciones (no las dos cosas).',
    }),
  outputSchema: z.object({ id: z.string(), name: z.string(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    let draft: unknown;
    if (input.template) {
      const t = templateById(input.template.id);
      if (!t) throw new ValidationError('Esa plantilla no existe.');
      try {
        draft = t.build(input.template);
      } catch (err) {
        throw new ValidationError(
          err instanceof Error ? err.message : 'Faltan datos de la plantilla.',
        );
      }
      if (input.name) (draft as { name: string }).name = input.name;
    } else {
      draft = {
        name: input.name ?? 'Automatización',
        enabled: true,
        trigger: input.trigger,
        conditions: input.conditions ?? [],
        actions: input.actions,
      };
    }
    const created = await createAutomation(ctx.db, app.id, draft, ctx.userId);
    return {
      id: created.id,
      name: created.name,
      markdown: `Listo: **${created.name}** en **${app.name}**. ${describeAutomation(created)}. La app tiene que estar publicada para que corra; puedes probarla con una fila de ejemplo y ver su historial en /apps/${app.slug}/edit.`,
    };
  },
});

export const appsAutomationsUpdate = registerTool({
  id: 'apps.automations.update',
  description: `Change an automation of an application (name, trigger, conditions or actions; send only what changes — conditions and actions replace the whole list). Validated against the real app. Requires confirmation; company owners/admins only.
${GRAMMAR}`,
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80),
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(120).optional(),
    trigger: automationTriggerSchema.optional(),
    conditions: z.array(automationConditionSchema).max(8).optional(),
    actions: z.array(automationActionSchema).min(1).max(8).optional(),
  }),
  outputSchema: z.object({ id: z.string(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const current = await mustGetAutomation(ctx.db, app.id, input.id);
    const updated = await updateAutomation(ctx.db, app.id, current.id, {
      name: input.name ?? current.name,
      enabled: current.enabled,
      trigger: input.trigger ?? current.trigger,
      conditions: input.conditions ?? current.conditions,
      actions: input.actions ?? current.actions,
    });
    return {
      id: updated.id,
      markdown: `Listo: **${updated.name}**. ${describeAutomation(updated)}.`,
    };
  },
});

export const appsAutomationsPause = registerTool({
  id: 'apps.automations.pause',
  description:
    'Pause or resume an automation of an application. A paused automation keeps its history and stops reacting; runs already queued are skipped. Requires confirmation; company owners/admins only.',
  inputSchema: z.object({
    app: z.string().trim().min(1).max(80),
    id: z.string().uuid(),
    paused: z.boolean().default(true).describe('true = pause, false = resume.'),
  }),
  outputSchema: z.object({ id: z.string(), enabled: z.boolean(), markdown: z.string() }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    const row = await setAutomationEnabled(ctx.db, app.id, input.id, !(input.paused ?? true));
    return {
      id: row.id,
      enabled: row.enabled,
      markdown: `**${row.name}** quedó ${row.enabled ? 'activa' : 'en pausa'}.`,
    };
  },
});

export const appsAutomationsTest = registerTool({
  id: 'apps.automations.test',
  description:
    'Try an automation of an application on a REAL row WITHOUT doing anything: says whether the trigger would fire, which conditions pass, and what each action would do (including, for update_related / update_rows / rollup, the rows it would change and from what value to what value, with the row cap warning; for wait, how long it would sleep). Give an existing automation id, or a draft (trigger + conditions + actions, same grammar as apps.automations.create). Optional rowId picks the row; otherwise the most recently changed one. Read-only; company owners/admins only. Use it before enabling a rule that changes other tables.',
  inputSchema: z
    .object({
      app: z.string().trim().min(1).max(80).describe('App id or slug.'),
      id: z.string().uuid().optional().describe('An existing automation of the app.'),
      trigger: automationTriggerSchema.optional(),
      conditions: z.array(automationConditionSchema).max(8).default([]),
      actions: z.array(automationActionSchema).min(1).max(8).optional(),
      rowId: z.string().uuid().optional().describe('Row to test with; default the latest changed.'),
    })
    .refine((v) => Boolean(v.id) !== Boolean(v.trigger && v.actions?.length), {
      message:
        'Da el id de una automatización, o un disparador con sus acciones (no las dos cosas).',
    }),
  outputSchema: z.object({
    triggers: z.boolean(),
    conditionsOk: z.boolean(),
    sample: z.string().nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    await requireAppAdmin(ctx);
    const app = await mustGetApp(ctx.db, input.app);
    let spec: Pick<AutomationInput, 'trigger' | 'conditions' | 'actions'>;
    if (input.id) {
      const a = await mustGetAutomation(ctx.db, app.id, input.id);
      spec = { trigger: a.trigger, conditions: a.conditions, actions: a.actions };
    } else {
      const parsed = automationInputSchema.safeParse({
        name: 'Prueba',
        trigger: input.trigger,
        conditions: input.conditions ?? [],
        actions: input.actions,
      });
      if (!parsed.success)
        throw new ValidationError(
          `La regla no es válida (${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || 'regla'}: ${i.message}`)
            .join('; ')}).`,
        );
      const problems = structuralProblems(parsed.data);
      if (problems.length) throw new ValidationError(problems.join(' '));
      spec = parsed.data;
    }
    const sim = await simulateAutomation(ctx.db, app, spec, { rowId: input.rowId });
    const lines = [
      `Prueba${sim.sample ? ` con la fila «${sim.sample.label}»` : ''} (no se hizo nada):`,
      `- Cuándo: ${sim.triggerLabel}${sim.triggers ? '' : ' (con esta fila el disparador NO se activaría)'}.`,
      `- Si: ${sim.conditions.ok ? 'se cumple' : `NO se cumple (${sim.conditions.failed})`}.`,
      ...sim.actions.flatMap((a, i) => [
        `- ${i + 1}. ${a.summary}`,
        ...(a.details ?? []).map((d) => `    - ${d}`),
      ]),
    ];
    return {
      triggers: sim.triggers,
      conditionsOk: sim.conditions.ok,
      sample: sim.sample?.label ?? null,
      markdown: lines.join('\n'),
    };
  },
});
