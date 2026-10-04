import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STAGED_VIA, STAGED_VIA_LABEL } from '@/lib/approvals-shape';
import { TOOL_LABELS, confirmationSummary } from '@/lib/tool-labels';
import * as tools from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';

/**
 * LA FRASE QUE LEE UNA PERSONA Y LA FRASE QUE LE CUENTA EL MODELO TIENEN QUE
 * SER LA MISMA FRASE.
 *
 * ===========================================================================
 * POR QUÉ HAY DOS COPIAS QUE COMPARAR
 * ===========================================================================
 * `confirmationSummary` vive en `lib/tool-labels.ts` porque la usan
 * `ConfirmationPrompt` y la tarjeta de aprobaciones, que son `'use client'`:
 * importar `@cortex/agent-tools` desde ahí arrastra `node:dns` al bundle y
 * rompe el build de producción con el typecheck y las pruebas en verde.
 * `pendingSummary` vive en el paquete porque la usa `approvals.list`, que corre
 * dentro de él y no puede importar nada de `apps/web` — la dependencia va al
 * revés. Ninguna de las dos se puede borrar.
 *
 * Así que la duplicación se queda y lo que se prueba es que no se separe. No es
 * cosmético: la tarjeta del chat enseña la frase que vino en el resultado de la
 * herramienta, y `/approvals` la calcula del payload que ya tiene. Si divergen,
 * dos superficies describen la misma acción de dos maneras distintas y una de
 * las dos está mintiéndole a quien va a pulsar «Aprobar y ejecutar».
 */

const WEB_LABELS = Object.fromEntries(
  Object.entries(TOOL_LABELS).map(([id, { label }]) => [id, label]),
);

describe('el catálogo de nombres es el mismo a los dos lados', () => {
  it('tiene las mismas herramientas con los mismos nombres', () => {
    expect(WEB_LABELS).toEqual(tools.TOOL_LABEL_TEXT);
  });

  it('cae al mismo texto para una herramienta que no está en el catálogo', () => {
    // El default de `confirmationSummary` pasa por el catálogo, así que un id
    // desconocido es donde las dos implementaciones podrían separarse sin que
    // ninguna tabla lo delate.
    for (const id of ['custom.radicar_dian', 'mcp_x_do_thing', 'thing']) {
      expect(tools.pendingSummary(id, {})).toBe(confirmationSummary(id, {}));
    }
  });
});

/**
 * Un caso por rama de la frase. La última prueba del bloque comprueba que no se
 * quede ninguna fuera cuando alguien añada una.
 */
const CASES: Array<{ toolId: string; input: Record<string, unknown> }> = [
  { toolId: 'hubspot.update_deal', input: { dealstage: 'Negociación', amount: 12_400_000 } },
  { toolId: 'hubspot_update_deal', input: {} },
  { toolId: 'hubspot.create_deal', input: { dealname: 'Coltrans', dealstage: 'Propuesta' } },
  {
    toolId: 'hubspot.create_contact',
    input: { firstName: 'Daniela', lastName: 'Ríos', email: 'd@acme.co' },
  },
  {
    toolId: 'hubspot.log_activity',
    input: {
      type: 'call',
      subject: 'Seguimiento',
      associatedObjectType: 'deal',
      associatedObjectId: '9',
    },
  },
  { toolId: 'browser.submit_flow', input: { flow: 'RUT' } },
  { toolId: 'gmail.send_draft', input: { draftId: 'r-99' } },
  { toolId: 'gmail.send_message', input: { to: ['a@b.co'], subject: 'S', body: 'B' } },
  { toolId: 'gcal.create_event', input: { summary: 'Comité', start: '2026-08-20T15:00' } },
  { toolId: 'gsheets.append_row', input: { spreadsheetId: 'NOMINA-2026-08' } },
  {
    toolId: 'schedule.create',
    input: { name: 'Cartera', scheduleKind: 'cron', cron: '0 7 * * 1', timezone: 'America/Bogota' },
  },
  {
    toolId: 'schedule.create',
    input: {
      name: 'Cierre',
      scheduleKind: 'once',
      runAt: '2026-09-01T09:00',
      allowUnattendedWrites: true,
    },
  },
  { toolId: 'views.schedule_pulse', input: { view: 'pulso_empresa' } },
  {
    toolId: 'views.schedule_pulse',
    input: { view: 'cartera', hour: 6, minute: 30, weekdays: [1, 3, 5], notifyEmail: true },
  },
  { toolId: 'views.schedule_weekly_review', input: { view: 'pulso_empresa' } },
  {
    toolId: 'views.schedule_weekly_review',
    input: { view: 'cartera', weekday: 5, hour: 17, minute: 0, notifyEmail: true },
  },
  { toolId: 'vehicles.register', input: { plate: 'ABC123' } },
  // Cuentas por pagar (0181).
  { toolId: 'payables.record', input: { number: 'FEPA-451', supplierName: 'Papelería El Cóndor' } },
  { toolId: 'payables.approve', input: { invoices: ['FEPA-451'] } },
  { toolId: 'tax.certificates', input: { kind: 'renta', year: 2025 } },
  {
    toolId: 'tax.certificates',
    input: { kind: 'iva', year: 2026, period: 4, suppliers: ['900555666'] },
  },
  { toolId: 'payables.approve', input: { invoices: ['a', 'b', 'c'] } },
  { toolId: 'payables.reject', input: { invoices: ['a', 'b'], reason: 'Doble cobro' } },
  { toolId: 'payables.schedule', input: { invoices: ['a'] } },
  // Nómina y SG-SST (0194).
  {
    toolId: 'payroll.register_novelty',
    input: {
      person: 'Ana Ruiz',
      kind: 'incapacidad_general',
      date: '2026-09-10',
      dateTo: '2026-09-14',
    },
  },
  {
    toolId: 'payroll.register_novelty',
    input: { person: 'Ana Ruiz', kind: 'hora_extra_nocturna', date: '2026-09-10' },
  },
  { toolId: 'payroll.approve_period', input: { label: 'septiembre 2026' } },
  { toolId: 'payroll.approve_period', input: {} },
  {
    toolId: 'payroll.leave_decide',
    input: { requestId: 'r1', decision: 'aprobada', person: 'Ana Ruiz' },
  },
  {
    toolId: 'payroll.leave_decide',
    input: { requestId: 'r1', decision: 'rechazada', note: 'Cierre de mes' },
  },
  {
    toolId: 'sst.log_activity',
    input: { kind: 'simulacro', title: 'Evacuación', date: '2026-10-20' },
  },
  { toolId: 'sst.report_incident', input: { kind: 'accidente', occurredOn: '2026-10-09' } },
  { toolId: 'sst.report_incident', input: { kind: 'incidente', occurredOn: '2026-10-09' } },
  { toolId: 'payables.schedule', input: { invoices: ['a', 'b'], date: '2026-10-14' } },
  {
    toolId: 'goals.set',
    input: { metricKey: 'receivables_days', cadence: 'month', targetValue: 45, label: 'Cartera' },
  },
  // Sin etiqueta, que es como llega cuando nadie la bautiza: la frase cae a la
  // clave de la métrica en los dos lados o no cae en ninguno.
  {
    toolId: 'goals.set',
    input: { metricKey: 'commitments_on_time', cadence: 'week', targetValue: 95 },
  },
  {
    toolId: 'inventory.move',
    input: { product: 'T-10', kind: 'entrada', qty: 50, unitCost: 300 },
  },
  { toolId: 'inventory.move', input: { product: 'T-10', kind: 'ajuste', countedQty: 42 } },
  { toolId: 'purchasing.create_po', input: { fromSuggestions: true, approve: true } },
  {
    toolId: 'purchasing.create_po',
    input: { supplier: 'Ferretería Central', lines: [{ product: 'T-10', qty: 200 }] },
  },
  {
    toolId: 'purchasing.send_po',
    input: {
      purchaseOrderId: 'x',
      label: 'OC-0007',
      supplierName: 'Ferretería Central',
      expectedTotal: 1_250_000,
    },
  },
  { toolId: 'purchasing.receive', input: { purchaseOrderId: 'OC-0007' } },
  { toolId: 'budget.set_line', input: { category: 'arriendo', amount: 2_500_000, year: 2026 } },
  { toolId: 'budget.set_line', input: { category: 'mercadeo', amount: 0, month: 3 } },
  { toolId: 'board.generate', input: { period: '2026-09' } },
  { toolId: 'board.send', input: { to: ['socio@demo.co'] } },
  // Contratos y cumplimiento (0195).
  {
    toolId: 'contracts.draft',
    input: { template: 'confidencialidad', counterparty: { kind: 'cliente', name: 'Coltrans' } },
  },
  { toolId: 'contracts.extract_obligations', input: { contractId: 'x' } },
  {
    toolId: 'compliance.mark',
    input: { item: 'asamblea_ordinaria', status: 'cumplido', evidenceNote: 'Acta 12' },
  },
  {
    toolId: 'compliance.pqrs_create',
    input: {
      kind: 'reclamo',
      requesterName: 'Ana Ruiz',
      subject: 'Cobro doble',
      channel: 'correo',
    },
  },
  { toolId: 'compliance.pqrs_respond', input: { pqrs: 'PQRS-2026-000012', close: true } },
  {
    toolId: 'compliance.case_update',
    input: { radicado: '05001310300120240012300', nextHearingOn: '2026-11-04' },
  },
  // Cierre contable (0192).
  {
    toolId: 'close.mark_task',
    input: {
      period: '2026-09',
      task: 'conciliacion',
      status: 'hecha',
      evidence: 'Préstamo del socio',
    },
  },
  { toolId: 'close.mark_task', input: { task: 'depreciacion', status: 'no_aplica' } },
  { toolId: 'close.close_period', input: { period: '2026-09' } },
  {
    toolId: 'close.close_period',
    input: { period: '2026-09', action: 'reabrir', reason: 'Faltó un gasto' },
  },
  { toolId: 'accounting.write_purchase', input: { invoices: ['FEPA-451'], provider: 'siigo' } },
  { toolId: 'accounting.write_purchase', input: { invoices: ['a', 'b'] } },
  { toolId: 'accounting.write_receipt', input: { payments: ['a'], provider: 'alegra' } },
  {
    toolId: 'accounting.write_supplier_payment',
    input: { invoices: ['a', 'b', 'c'], provider: 'quickbooks' },
  },
  { toolId: 'slack.post_message', input: { channel: '#general', text: 'hola' } },
  // Ventas (0182).
  {
    toolId: 'sales.quote_create',
    input: { client: 'Nexa', lines: [{ description: 'Flete Bogotá–Cali', quantity: 10 }] },
  },
  { toolId: 'sales.quote_send', input: { quote: 'COT-12', to: ['compras@nexa.co'] } },
  { toolId: 'sales.quote_send', input: { quote: 'COT-12' } },
  { toolId: 'sales.invoice_emit', input: { document: 'PED-3', provider: 'siigo' } },
  { toolId: 'sales.invoice_emit', input: { document: 'COT-12' } },
  // Embudo comercial (0193).
  {
    toolId: 'crm.create_opportunity',
    input: { client: 'Nexa', title: 'Fletes Cali', value: 40_000_000, stage: 'Negociación' },
  },
  { toolId: 'crm.create_opportunity', input: { client: 'Coltrans', title: 'Soporte' } },
  {
    toolId: 'crm.update_opportunity',
    input: { opportunity: 'Fletes Cali', stage: 'Perdida', lostReasonKind: 'precio' },
  },
  { toolId: 'crm.update_opportunity', input: { opportunity: 'Fletes Cali', value: 12_000_000 } },
  {
    toolId: 'crm.log_activity',
    input: { opportunity: 'Fletes Cali', kind: 'task', title: 'Llamar', dueOn: '2026-10-08' },
  },
  { toolId: 'crm.log_activity', input: { client: 'Nexa', kind: 'call', title: 'Pidió descuento' } },
  { toolId: 'crm.send_nps', input: { client: 'Nexa', to: ['compras@nexa.co'] } },
  { toolId: 'crm.send_nps', input: { client: 'Nexa', linkOnly: true } },
  { toolId: 'team.invite', input: { email: 'ana@x.co', role: 'admin' } },
  {
    toolId: 'team.invite',
    input: { email: 'luis@x.co', role: 'member', position: 'Analista de cartera', team: 'Cartera' },
  },
  {
    toolId: 'whatsapp.reply',
    input: { conversationId: '00000000-0000-4000-8000-000000000001', text: 'Ya te reviso.' },
  },
  // Proyectos y flota (0196).
  {
    toolId: 'projects.create',
    input: { title: 'Mantenimiento montacargas', client: 'Nexa', budgetAmount: 6_000_000 },
  },
  { toolId: 'projects.create', input: { fromDocument: 'COT-12', tasksFromLines: true } },
  { toolId: 'projects.log_time', input: { project: 'OS-0007', hours: 6, person: 'Andrés' } },
  {
    toolId: 'projects.log_time',
    input: { project: 'OS-0007', hours: 2, date: '2026-10-01', billable: false },
  },
  { toolId: 'projects.invoice', input: { project: 'OS-0007', milestone: 'Anticipo' } },
  { toolId: 'projects.invoice', input: { project: 'PRY-0002' } },
  {
    toolId: 'fleet.log_fuel',
    input: { plate: 'NQR123', gallons: 18, amount: 290_000, odometerKm: 84_320 },
  },
  {
    toolId: 'fleet.log_maintenance',
    input: { plate: 'FRT482', description: 'Cambio de aceite', cost: 380_000 },
  },
  {
    toolId: 'fleet.log_trip',
    input: { plate: 'NQR123', origin: 'Bogotá', stops: ['Fusagasugá'], destination: 'Girardot' },
  },
];

describe('la frase que describe una llamada parada', () => {
  it.each(CASES)('dice lo mismo en el navegador y en el paquete: $toolId', ({ toolId, input }) => {
    expect(tools.pendingSummary(toolId, input)).toBe(confirmationSummary(toolId, input));
  });

  it('cubre todas las ramas que tiene la copia del navegador', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./tool-labels.ts', import.meta.url)),
      'utf8',
    );
    const branches = [...source.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1] as string);
    const covered = new Set(CASES.map((c) => c.toolId.replace(/\./g, '_')));
    expect(
      branches.filter((id) => !covered.has(id)),
      'Estas ramas de `confirmationSummary` no están en CASES, así que nada comprueba ' +
        'que la copia del paquete diga lo mismo. Añade un caso con un payload de ejemplo.',
    ).toEqual([]);
  });
});

describe('de dónde salió lo que espera permiso', () => {
  it('los orígenes y sus nombres son los mismos a los dos lados', () => {
    expect([...STAGED_VIA]).toEqual([...tools.STAGED_VIA]);
    expect(STAGED_VIA_LABEL).toEqual(tools.STAGED_VIA_LABEL);
  });
});
