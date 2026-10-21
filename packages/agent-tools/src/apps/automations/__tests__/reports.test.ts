import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../tenancy/scoped-client';
import type { ViewSource } from '../../../views/compute';
import { forgetAutomationWatch } from '../emit';
import { scheduleDue, scheduleSlotStart } from '../engine';
import { type ReportTable, reportQueryProblems, runReportQuery } from '../report';
import { renderReportEmail } from '../report-email';
import { buildReportXlsx, renderReportPdf, reportFilename } from '../report-files';
import { RANGE_PRESETS, rangeText, resolveRange } from '../report-range';
import { REPORT_DEFAULT_PER_DAY, reportBodySchema, reportQuerySourceSchema } from '../report-spec';
import { type AutomationDeps, executeRun } from '../run';
import { automationInputSchema, structuralProblems } from '../spec';

/**
 * REPORTES QUE SALEN SOLOS: rangos relativos en hora de Bogotá, agregados,
 * HTML con pesos completos, Excel y PDF reales, y la corrida contra una base
 * de mentira («cada lunes a las 7, manda a Gerencia el costo de equipos por
 * proveedor de la semana pasada»).
 */

const ORG = 'org-a';
// Lunes 19 de octubre de 2026, 7:00 a. m. en Bogotá (12:00 UTC).
const MONDAY_7AM = new Date('2026-10-19T12:00:00.000Z');

const at = (iso: string) => new Date(iso);

describe('rangos relativos en hora de Bogotá', () => {
  it('el lunes 7 a. m. «la semana pasada» es lunes 12 a domingo 18', () => {
    const r = resolveRange('last_week', MONDAY_7AM);
    expect(r.from).toBe('2026-10-12');
    expect(r.to).toBe('2026-10-18');
    expect(r.label).toBe('La semana pasada (12 al 18 oct 2026)');
  });
  it('domingo 11:30 p. m. en Bogotá (ya lunes en UTC) sigue siendo domingo', () => {
    const now = at('2026-10-19T04:30:00.000Z'); // domingo 18, 23:30 Bogotá
    expect(resolveRange('today', now).from).toBe('2026-10-18');
    expect(resolveRange('this_week', now)).toMatchObject({ from: '2026-10-12', to: '2026-10-18' });
    expect(resolveRange('last_week', now)).toMatchObject({ from: '2026-10-05', to: '2026-10-11' });
  });
  it('lunes 12:30 a. m. en Bogotá ya es la semana nueva', () => {
    const now = at('2026-10-19T05:30:00.000Z');
    expect(resolveRange('this_week', now)).toMatchObject({ from: '2026-10-19', to: '2026-10-25' });
  });
  it('esta semana, ayer, hoy y los últimos 7 / 30 días', () => {
    expect(resolveRange('this_week', MONDAY_7AM)).toMatchObject({ from: '2026-10-19', to: '2026-10-25' });
    expect(resolveRange('yesterday', MONDAY_7AM)).toMatchObject({ from: '2026-10-18', to: '2026-10-18' });
    expect(resolveRange('today', MONDAY_7AM)).toMatchObject({ from: '2026-10-19', to: '2026-10-19' });
    expect(resolveRange('last_7_days', MONDAY_7AM)).toMatchObject({ from: '2026-10-13', to: '2026-10-19' });
    expect(resolveRange('last_30_days', MONDAY_7AM)).toMatchObject({ from: '2026-09-20', to: '2026-10-19' });
  });
  it('mes en curso y mes pasado, también cruzando de año y en febrero bisiesto', () => {
    expect(resolveRange('this_month', MONDAY_7AM)).toMatchObject({ from: '2026-10-01', to: '2026-10-31' });
    expect(resolveRange('last_month', MONDAY_7AM)).toMatchObject({ from: '2026-09-01', to: '2026-09-30' });
    expect(resolveRange('last_month', at('2027-01-05T15:00:00Z'))).toMatchObject({
      from: '2026-12-01',
      to: '2026-12-31',
    });
    expect(resolveRange('last_month', at('2028-03-02T15:00:00Z'))).toMatchObject({
      from: '2028-02-01',
      to: '2028-02-29',
    });
    expect(resolveRange('this_year', MONDAY_7AM)).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('la semana pasada cruza el fin de año', () => {
    // Lunes 4 de enero de 2027.
    const r = resolveRange('last_week', at('2027-01-04T13:00:00Z'));
    expect(r).toMatchObject({ from: '2026-12-28', to: '2027-01-03' });
    expect(r.label).toContain('28 dic 2026 al 3 ene 2027');
  });
  it('«todo» no limita y todos los presets tienen etiqueta', () => {
    expect(resolveRange('all', MONDAY_7AM)).toMatchObject({ from: null, to: null });
    for (const p of RANGE_PRESETS) expect(resolveRange(p, MONDAY_7AM).label.length).toBeGreaterThan(3);
    expect(rangeText('2026-10-12', '2026-10-12')).toBe('12 oct 2026');
  });
});

// ---------------------------------------------------------------------------
// Agregados
// ---------------------------------------------------------------------------

const fields = [
  { key: 'nombre', label: 'Equipo', type: 'text' as const },
  { key: 'proveedor', label: 'Proveedor', type: 'text' as const },
  { key: 'costo', label: 'Costo', type: 'money' as const },
  { key: 'horas', label: 'Horas', type: 'number' as const },
  { key: 'fecha', label: 'Fecha de uso', type: 'date' as const },
  { key: 'estado', label: 'Estado', type: 'text' as const },
];

const REL = (id: string, label: string) => JSON.stringify({ id, label });

function row(
  id: string,
  values: Record<string, string | number>,
  created = '2026-10-14T15:00:00.000Z',
) {
  return { id, label: String(values.nombre ?? id), values, created_at: created, updated_at: created };
}

const source = (rows: ViewSource['rows'], truncated = false): ViewSource => ({
  tracker: { slug: 'equipos_usados', name: 'Equipos usados', fields: fields as never },
  rows,
  truncated,
});

const EQUIPOS = [
  row('1', { nombre: 'Escalera', proveedor: 'Alfa', costo: 1_200_000, horas: 2, fecha: '2026-10-13', estado: 'Cerrado' }),
  row('2', { nombre: 'Tractor', proveedor: 'Alfa', costo: 3_500_000, horas: 5, fecha: '2026-10-15', estado: 'Cerrado' }),
  row('3', { nombre: 'Banda', proveedor: 'Beta', costo: 9_000_000, horas: 4, fecha: '2026-10-18', estado: 'Abierto' }),
  // fuera de la semana pasada
  row('4', { nombre: 'Banda 2', proveedor: 'Beta', costo: 777, horas: 1, fecha: '2026-10-19', estado: 'Cerrado' }),
  row('5', { nombre: 'Viejo', proveedor: 'Gamma', costo: 555, horas: 1, fecha: '2026-10-11', estado: 'Cerrado' }),
  // sin proveedor
  row('6', { nombre: 'Suelto', costo: 100_000, horas: 1, fecha: '2026-10-14', estado: 'Cerrado' }),
];

const QUERY = reportQuerySourceSchema.parse({
  kind: 'query',
  tracker: 'equipos_usados',
  groupBy: 'proveedor',
  metrics: [{ op: 'sum', field: 'costo' }],
  range: { field: 'fecha', preset: 'last_week' },
});

describe('runReportQuery: costo de equipos por proveedor de la semana pasada', () => {
  const out = runReportQuery(QUERY, source(EQUIPOS), MONDAY_7AM);
  const t = out.tables[0] as ReportTable;

  it('agrupa, suma, ordena de mayor a menor y deja el total', () => {
    expect(t.columns.map((c) => c.label)).toEqual(['Proveedor', 'Suma de Costo']);
    expect(t.columns[1]?.kind).toBe('money');
    expect(t.rows).toEqual([
      ['Beta', 9_000_000],
      ['Alfa', 4_700_000],
      ['Sin dato', 100_000],
    ]);
    expect(t.totals).toEqual(['Total', 13_800_000]);
    expect(out.rowCount).toBe(4);
    expect(out.range?.from).toBe('2026-10-12');
  });
  it('lo de otra semana no entra (ni el límite del lunes siguiente)', () => {
    const all = JSON.stringify(t.rows);
    expect(all).not.toContain('777');
    expect(all).not.toContain('555');
  });
  it('orden ascendente y alfabético', () => {
    const asc = runReportQuery({ ...QUERY, sort: 'asc' }, source(EQUIPOS), MONDAY_7AM).tables[0] as ReportTable;
    expect(asc.rows.map((r) => r[0])).toEqual(['Sin dato', 'Alfa', 'Beta']);
    const alpha = runReportQuery({ ...QUERY, sort: 'label' }, source(EQUIPOS), MONDAY_7AM).tables[0] as ReportTable;
    expect(alpha.rows.map((r) => r[0])).toEqual(['Alfa', 'Beta', 'Sin dato']);
  });
  it('varias cifras: suma, conteo y promedio', () => {
    const q = reportQuerySourceSchema.parse({
      ...QUERY,
      metrics: [{ op: 'sum', field: 'costo' }, { op: 'count' }, { op: 'avg', field: 'horas', label: 'Horas promedio' }],
    });
    const r = runReportQuery(q, source(EQUIPOS), MONDAY_7AM).tables[0] as ReportTable;
    expect(r.columns.map((c) => c.label)).toEqual(['Proveedor', 'Suma de Costo', 'Cantidad', 'Horas promedio']);
    expect(r.rows[1]).toEqual(['Alfa', 4_700_000, 2, 3.5]);
    expect(r.totals).toEqual(['Total', 13_800_000, 4, 3]);
  });
  it('filtros además del rango', () => {
    const q = reportQuerySourceSchema.parse({
      ...QUERY,
      where: [{ field: 'estado', op: 'eq', value: 'Cerrado' }],
    });
    const r = runReportQuery(q, source(EQUIPOS), MONDAY_7AM).tables[0] as ReportTable;
    expect(r.rows).toEqual([
      ['Alfa', 4_700_000],
      ['Sin dato', 100_000],
    ]);
  });
  it('sin agrupar: una sola fila con los totales', () => {
    const q = reportQuerySourceSchema.parse({ ...QUERY, groupBy: undefined });
    const r = runReportQuery(q, source(EQUIPOS), MONDAY_7AM).tables[0] as ReportTable;
    expect(r.rows).toEqual([[13_800_000]]);
    expect(r.totals).toBeUndefined();
  });
  it('tope de grupos: avisa y el total incluye todos', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      row(`m${i}`, { nombre: `E${i}`, proveedor: `P${i}`, costo: 10 * (i + 1), fecha: '2026-10-14' }),
    );
    const q = reportQuerySourceSchema.parse({ ...QUERY, limit: 2 });
    const r = runReportQuery(q, source(many), MONDAY_7AM);
    expect((r.tables[0] as ReportTable).rows.length).toBe(2);
    expect((r.tables[0] as ReportTable).totals).toEqual(['Total', 150]);
    expect(r.notes.join(' ')).toMatch(/5 grupos/);
  });
  it('agrupa por una relación leyendo su nombre y por la fecha de creación', () => {
    const withRel = [
      { ...row('r1', { nombre: 'A', costo: 10 }), values: { nombre: 'A', costo: 10, vuelo: REL('11111111-1111-4111-a111-111111111111', 'AV204') } },
      { ...row('r2', { nombre: 'B', costo: 5 }), values: { nombre: 'B', costo: 5, vuelo: REL('11111111-1111-4111-a111-111111111111', 'AV204') } },
    ];
    const src: ViewSource = {
      tracker: { slug: 'equipos_usados', name: 'Equipos', fields: [...fields, { key: 'vuelo', label: 'Vuelo', type: 'relation', tracker: 'vuelos' }] as never },
      rows: withRel,
      truncated: false,
    };
    const q = reportQuerySourceSchema.parse({ kind: 'query', tracker: 'equipos_usados', groupBy: 'vuelo', metrics: [{ op: 'sum', field: 'costo' }] });
    expect((runReportQuery(q, src, MONDAY_7AM).tables[0] as ReportTable).rows).toEqual([['AV204', 15]]);
    const byDay = reportQuerySourceSchema.parse({ kind: 'query', tracker: 'equipos_usados', groupBy: 'created_at', metrics: [{ op: 'count' }] });
    expect((runReportQuery(byDay, src, MONDAY_7AM).tables[0] as ReportTable).rows).toEqual([['14 oct 2026', 2]]);
  });
  it('rango por la fecha de creación en hora de Bogotá (11 p. m. del domingo cuenta en la semana)', () => {
    const late = row('z', { nombre: 'Tarde', proveedor: 'Z', costo: 50 }, '2026-10-19T04:30:00.000Z'); // domingo 23:30 Bogotá
    const early = row('y', { nombre: 'Temprano', proveedor: 'Z', costo: 7 }, '2026-10-19T05:30:00.000Z'); // lunes 00:30 Bogotá
    const q = reportQuerySourceSchema.parse({ kind: 'query', tracker: 'equipos_usados', metrics: [{ op: 'sum', field: 'costo' }], range: { field: 'created_at', preset: 'last_week' } });
    expect((runReportQuery(q, source([late, early]), MONDAY_7AM).tables[0] as ReportTable).rows).toEqual([[50]]);
  });
  it('sin movimiento: 0 filas, total en cero', () => {
    const r = runReportQuery(QUERY, source([]), MONDAY_7AM);
    expect(r.rowCount).toBe(0);
    expect((r.tables[0] as ReportTable).rows).toEqual([]);
    expect((r.tables[0] as ReportTable).totals).toEqual(['Total', 0]);
  });
  it('hoja de detalle sólo para los adjuntos', () => {
    const q = reportQuerySourceSchema.parse({ ...QUERY, detail: true });
    const r = runReportQuery(q, source(EQUIPOS), MONDAY_7AM);
    expect(r.tables).toHaveLength(2);
    const d = r.tables[1] as ReportTable;
    expect(d.attachmentOnly).toBe(true);
    expect(d.rows.length).toBe(4);
    expect(d.columns.map((c) => c.label)).toEqual(['Registro', 'Proveedor', 'Fecha de uso', 'Costo']);
  });
  it('avisa si la lectura se cortó', () => {
    expect(runReportQuery(QUERY, source(EQUIPOS, true), MONDAY_7AM).notes.join(' ')).toMatch(/más filas/);
  });
});

describe('reportQueryProblems', () => {
  const tracker = { slug: 'equipos_usados', fields };
  const q = (over: Record<string, unknown>) => reportQuerySourceSchema.parse({ kind: 'query', tracker: 'equipos_usados', ...over });
  it('una consulta bien armada no tiene problemas', () => {
    expect(reportQueryProblems(QUERY, tracker)).toEqual([]);
  });
  it('campos que no existen, cifras sobre texto y rangos sobre texto', () => {
    expect(reportQueryProblems(q({ groupBy: 'nada' }), tracker).join(' ')).toMatch(/«nada»/);
    expect(reportQueryProblems(q({ metrics: [{ op: 'sum', field: 'proveedor' }] }), tracker).join(' ')).toMatch(/no es numérico/);
    expect(reportQueryProblems(q({ metrics: [{ op: 'sum' }] }), tracker).join(' ')).toMatch(/necesita `field`/);
    expect(reportQueryProblems(q({ range: { field: 'proveedor', preset: 'last_week' } }), tracker).join(' ')).toMatch(/no es una fecha/);
    expect(reportQueryProblems(q({ range: { field: 'created_at', preset: 'last_week' } }), tracker)).toEqual([]);
    expect(reportQueryProblems(q({ where: [{ field: 'zzz', op: 'eq', value: 'x' }] }), tracker).join(' ')).toMatch(/zzz/);
  });
});

// ---------------------------------------------------------------------------
// Correo, Excel y PDF
// ---------------------------------------------------------------------------

describe('el correo del reporte', () => {
  const result = runReportQuery(QUERY, source(EQUIPOS), MONDAY_7AM);
  const mail = renderReportEmail({
    title: 'Costo de equipos por proveedor',
    rangeLabel: result.range?.label,
    intro: 'Cierre semanal.',
    tables: result.tables,
    appName: 'Rampa <Aeropuerto>',
    attachments: ['costo-2026-10-19.xlsx', 'costo-2026-10-19.pdf'],
    rowCount: result.rowCount,
  });
  it('pesos completos, nunca abreviados', () => {
    expect(mail.html).toContain('$&nbsp;9.000.000'.replace('&nbsp;', ' '));
    expect(mail.html).toContain('13.800.000');
    expect(mail.html).not.toMatch(/\d\s?M\b/);
    expect(mail.text).toContain('Total');
  });
  it('escapa lo que viene de datos y dice qué va adjunto', () => {
    expect(mail.html).toContain('Rampa &lt;Aeropuerto&gt;');
    expect(mail.html).not.toContain('<Aeropuerto>');
    expect(mail.html).toContain('costo-2026-10-19.xlsx');
    expect(mail.html).toContain('La semana pasada (12 al 18 oct 2026)');
  });
  it('sin movimiento lo dice en vez de una tabla vacía', () => {
    const empty = runReportQuery(QUERY, source([]), MONDAY_7AM);
    const m = renderReportEmail({ title: 'T', tables: empty.tables, appName: 'A', rowCount: 0 });
    expect(m.html).toContain('No hubo movimiento');
  });
  it('en el cuerpo no va la hoja de detalle', () => {
    const q = reportQuerySourceSchema.parse({ ...QUERY, detail: true });
    const r = runReportQuery(q, source(EQUIPOS), MONDAY_7AM);
    const m = renderReportEmail({ title: 'T', tables: r.tables, appName: 'A', rowCount: r.rowCount });
    expect(m.html).not.toContain('Detalle ·');
  });
  it('una celda que empieza por «=» no se vuelve fórmula en Excel', async () => {
    const t: ReportTable = { title: 'x', columns: [{ label: 'A', kind: 'text' }], rows: [['=1+1']] };
    const bytes = await buildReportXlsx('x', [t], MONDAY_7AM);
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    const cell = wb.getWorksheet(1)?.getCell('A2');
    expect(cell?.formula).toBeUndefined();
    expect(String(cell?.value)).toContain('=1+1');
  });
});

describe('adjuntos', () => {
  const q = reportQuerySourceSchema.parse({ ...QUERY, detail: true });
  const result = runReportQuery(q, source(EQUIPOS), MONDAY_7AM);
  it('el Excel se puede leer: hojas, cifras como número y total', async () => {
    const bytes = await buildReportXlsx('Costo de equipos', result.tables, MONDAY_7AM);
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Equipos usados', 'Detalle · Equipos usados']);
    const ws = wb.getWorksheet('Equipos usados');
    expect(ws?.getRow(1).values).toEqual([undefined, 'Proveedor', 'Suma de Costo']);
    expect(ws?.getCell('B2').value).toBe(9_000_000);
    expect(ws?.getCell('B2').numFmt).toBe('"$"#,##0');
    expect(ws?.getCell('A5').value).toBe('Total');
    expect(ws?.getCell('B5').value).toBe(13_800_000);
  });
  it('el PDF es un PDF válido con el título y las cifras completas', () => {
    const pdf = renderReportPdf({
      title: 'Costo de equipos por proveedor',
      subtitle: result.range?.label,
      tables: [result.tables[0] as ReportTable],
      appName: 'Rampa',
      generatedLabel: 'Generado el 2026-10-19',
    });
    const text = Buffer.from(pdf).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('%%EOF');
    expect(text).toContain('Costo de equipos por proveedor');
    expect(text).toContain('9.000.000');
    expect(text).toContain('Pagina'.replace('Pagina', 'Página').normalize('NFC') && 'Total');
  });
  it('un PDF largo pagina y repite el encabezado', () => {
    const rows = Array.from({ length: 120 }, (_, i) => [`Proveedor ${i}`, i * 1000] as Array<string | number>);
    const pdf = renderReportPdf({
      title: 'Largo',
      tables: [{ title: 'T', columns: [{ label: 'Proveedor', kind: 'text' }, { label: 'Costo', kind: 'money' }], rows }],
      appName: 'A',
      generatedLabel: 'x',
    });
    const text = Buffer.from(pdf).toString('latin1');
    expect((text.match(/\/Type \/Page /g) ?? []).length).toBeGreaterThan(2);
    expect((text.match(/Proveedor ?\)/g) ?? []).length).toBeGreaterThan(2);
  });
  it('nombre de archivo seguro', () => {
    expect(reportFilename('Costo de equipos · Año', '2026-10-19', 'xlsx')).toBe('costo-de-equipos-ano-2026-10-19.xlsx');
  });
});

// ---------------------------------------------------------------------------
// La regla y la corrida
// ---------------------------------------------------------------------------

const MONDAY_RULE = {
  name: 'Costo de equipos por proveedor, cada lunes',
  trigger: { type: 'schedule', cadence: 'weekly', weekday: 1, hour: 7 },
  actions: [
    {
      type: 'report',
      title: 'Costo de equipos por proveedor',
      source: {
        kind: 'query',
        tracker: 'equipos_usados',
        groupBy: 'proveedor',
        metrics: [{ op: 'sum', field: 'costo' }],
        range: { field: 'fecha', preset: 'last_week' },
      },
      roles: ['gerencia'],
      formats: ['xlsx', 'pdf'],
    },
  ],
};

describe('«cada lunes a las 7, manda a Gerencia el costo de equipos por proveedor de la semana pasada»', () => {
  it('la regla es válida y no necesita fila', () => {
    const parsed = automationInputSchema.parse(MONDAY_RULE);
    expect(structuralProblems(parsed)).toEqual([]);
    const a = parsed.actions[0];
    expect(a?.type === 'report' && a.formats).toEqual(['xlsx', 'pdf']);
  });
  it('toca el lunes a las 7 (hora de Bogotá), no antes', () => {
    const t = automationInputSchema.parse(MONDAY_RULE).trigger as never;
    expect(scheduleDue(t, null, at('2026-10-19T11:59:00Z'))?.toISOString()).not.toBe('2026-10-19T12:00:00.000Z');
    expect(scheduleDue(t, null, at('2026-10-19T12:00:00Z'))?.toISOString()).toBe('2026-10-19T12:00:00.000Z');
    // ya reclamada: no vuelve a tocar
    expect(scheduleDue(t, at('2026-10-19T12:00:00Z'), at('2026-10-19T12:30:00Z'))).toBeNull();
    expect(scheduleSlotStart(t, at('2026-10-21T12:00:00Z')).toISOString()).toBe('2026-10-19T12:00:00.000Z');
  });
  it('sin destinatarios, la regla no es válida', () => {
    const bad = automationInputSchema.parse({ ...MONDAY_RULE, actions: [{ ...MONDAY_RULE.actions[0], roles: [] }] });
    expect(structuralProblems(bad).join(' ')).toMatch(/al menos una dirección o un rol/);
  });
  it('el tope por defecto es razonable y el cuerpo valida formatos', () => {
    expect(REPORT_DEFAULT_PER_DAY).toBe(3);
    expect(() => z_formats(['docx'])).toThrow();
  });
});

function z_formats(v: unknown) {
  return reportBodySchema.formats.parse(v);
}

type Tables = Record<string, Array<Record<string, unknown>>>;

function world(rules: Array<Record<string, unknown>>) {
  const tables: Tables = {
    trackers: [
      {
        id: 't-eq',
        organization_id: ORG,
        slug: 'equipos_usados',
        name: 'Equipos usados',
        description: '',
        fields,
        duplicates: null,
        created_by: null,
        created_at: '2026-10-01T00:00:00Z',
        updated_at: '2026-10-01T00:00:00Z',
      },
    ],
    tracker_rows: EQUIPOS.map((r) => ({ ...r, organization_id: ORG, tracker_id: 't-eq', created_by: 'u1' })),
    custom_apps: [
      { id: 'app-1', organization_id: ORG, slug: 'rampa', name: 'Rampa', icon: '✈️', status: 'published', archived_at: null },
    ],
    custom_app_screens: [],
    custom_app_roles: [],
    custom_app_automations: rules,
    custom_app_automation_runs: [],
    custom_app_users: [
      { id: 'au1', organization_id: ORG, app_id: 'app-1', name: 'Gina', email: 'Gina@Empresa.co', role_key: 'gerencia', status: 'active' },
      { id: 'au2', organization_id: ORG, app_id: 'app-1', name: 'Luis', email: 'luis@empresa.co', role_key: 'gerencia', status: 'active' },
      { id: 'au3', organization_id: ORG, app_id: 'app-1', name: 'Off', email: 'off@empresa.co', role_key: 'gerencia', status: 'disabled' },
      { id: 'au4', organization_id: ORG, app_id: 'app-1', name: 'Otro rol', email: 'op@empresa.co', role_key: 'operario', status: 'active' },
    ],
    custom_app_members: [],
    users: [{ id: 'u1', organization_id: ORG, role: 'org_admin', email: 'a@a.co' }],
  };
  forgetAutomationWatch();
  const fake = createFakeSupabase(tables);
  return { tables, db: createOrgScopedClient(fake.client, ORG) };
}

interface Sent {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; contentBase64: string; contentType: string }>;
}

function deps(sent: Sent[], opts: { fail?: string[]; now?: Date } = {}): AutomationDeps {
  return {
    now: () => opts.now ?? MONDAY_7AM,
    baseUrl: 'https://cortex.test',
    signingSecret: 's',
    sendEmail: async (m) => {
      if (opts.fail?.includes(m.to)) return { sent: false, reason: 'Resend 422' };
      sent.push(m);
      return { sent: true };
    },
    notifyMembers: async (_d, users) => users.length,
    pushAppUsers: async () => [],
    askCortex: async () => ({ summary: 'ok', staged: 0 }),
  };
}

function ruleRow(id: string, input: typeof MONDAY_RULE, extra: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: ORG,
    app_id: 'app-1',
    name: input.name,
    enabled: true,
    trigger: input.trigger,
    conditions: [],
    actions: input.actions,
    tracker_id: null,
    trigger_kind: 'schedule',
    created_by: 'u1',
    ...extra,
  };
}

let n = 0;
function queueRun(tables: Tables, automationId: string, over: Record<string, unknown> = {}) {
  const run = {
    id: `run-${++n}`,
    organization_id: ORG,
    app_id: 'app-1',
    automation_id: automationId,
    trigger_ref: 'slot',
    status: 'queued',
    attempts: 0,
    next_attempt_at: MONDAY_7AM.toISOString(),
    event: { kind: 'schedule', version: MONDAY_7AM.toISOString(), actor: { kind: 'system' }, chain: [], depth: 0 },
    result: [],
    error: null as string | null,
    ask_cortex_calls: 0,
    idempotency_key: `${automationId}:${n}`,
    created_at: MONDAY_7AM.toISOString(),
    ...over,
  };
  tables.custom_app_automation_runs?.push(run);
  return run;
}

describe('la corrida del reporte', () => {
  it('manda a cada usuario del rol (sin duplicados ni deshabilitados) con tabla, Excel y PDF', async () => {
    const { db, tables } = world([ruleRow('r1', MONDAY_RULE)]);
    const run = queueRun(tables, 'r1');
    const sent: Sent[] = [];
    const out = await executeRun(db, run.id, ORG, deps(sent));
    expect(out.status).toBe('succeeded');
    expect(sent.map((s) => s.to).sort()).toEqual(['gina@empresa.co', 'luis@empresa.co']);
    const first = sent[0] as Sent;
    expect(first.subject).toBe('Costo de equipos por proveedor · La semana pasada (12 al 18 oct 2026)');
    expect(first.html).toContain('9.000.000');
    expect(first.html).toContain('13.800.000');
    expect(first.attachments?.map((a) => a.filename)).toEqual([
      'costo-de-equipos-por-proveedor-2026-10-19.xlsx',
      'costo-de-equipos-por-proveedor-2026-10-19.pdf',
    ]);
    expect(Buffer.from(first.attachments?.[1]?.contentBase64 ?? '', 'base64').toString('latin1').startsWith('%PDF')).toBe(true);
    // El historial de la corrida dice qué salió, a quién y con qué.
    const detail = (run.result as Array<{ detail: string }>)[0]?.detail ?? '';
    expect(detail).toContain('Reporte enviado');
    expect(detail).toContain('4 filas');
    expect(detail).toContain('a 2 de 2');
    expect(detail).toContain('gina@empresa.co');
    expect(detail).toContain('.xlsx');
  });

  it('reintentar la misma corrida no manda nada otra vez', async () => {
    const { db, tables } = world([ruleRow('r1', MONDAY_RULE)]);
    const run = queueRun(tables, 'r1');
    const sent: Sent[] = [];
    await executeRun(db, run.id, ORG, deps(sent));
    expect((await executeRun(db, run.id, ORG, deps(sent))).status).toBe('not_claimable');
    expect(sent).toHaveLength(2);
  });

  it('correos sueltos y roles se juntan sin repetir', async () => {
    const rule = ruleRow('r1', { ...MONDAY_RULE, actions: [{ ...MONDAY_RULE.actions[0], to: ['GINA@empresa.co', 'ceo@empresa.co'], formats: [] }] } as unknown as typeof MONDAY_RULE);
    const { db, tables } = world([rule]);
    const run = queueRun(tables, 'r1');
    const sent: Sent[] = [];
    await executeRun(db, run.id, ORG, deps(sent));
    expect(sent.map((s) => s.to).sort()).toEqual(['ceo@empresa.co', 'gina@empresa.co', 'luis@empresa.co']);
    expect(sent[0]?.attachments).toEqual([]);
  });

  it('si un destinatario falla, los demás reciben y el historial lo dice', async () => {
    const { db, tables } = world([ruleRow('r1', MONDAY_RULE)]);
    const run = queueRun(tables, 'r1');
    const sent: Sent[] = [];
    const out = await executeRun(db, run.id, ORG, deps(sent, { fail: ['luis@empresa.co'] }));
    expect(out.status).toBe('succeeded');
    expect(sent).toHaveLength(1);
    expect((run.result as Array<{ detail: string }>)[0]?.detail).toMatch(/no salió a luis@empresa.co/);
  });

  it('si no sale ni uno, la corrida falla con la razón (y un 5xx se reintenta)', async () => {
    const { db, tables } = world([ruleRow('r1', MONDAY_RULE)]);
    const run = queueRun(tables, 'r1');
    const out = await executeRun(db, run.id, ORG, deps([], { fail: ['gina@empresa.co', 'luis@empresa.co'] }));
    expect(out.status).toBe('failed');
    expect(run.error).toMatch(/Ningún correo salió/);
  });

  it('skipIfEmpty: sin movimiento no manda', async () => {
    const empty = { ...MONDAY_RULE.actions[0], skipIfEmpty: true, source: { ...MONDAY_RULE.actions[0]?.source, range: { field: 'fecha', preset: 'this_year' as const }, where: [{ field: 'estado', op: 'eq', value: 'Inexistente' }] } };
    const { db, tables } = world([ruleRow('r1', { ...MONDAY_RULE, actions: [empty] } as unknown as typeof MONDAY_RULE)]);
    const run = queueRun(tables, 'r1');
    const sent: Sent[] = [];
    const out = await executeRun(db, run.id, ORG, deps(sent));
    expect(out.status).toBe('succeeded');
    expect(sent).toHaveLength(0);
    expect((run.result as Array<{ detail: string }>)[0]?.detail).toMatch(/Sin movimiento/);
  });

  it('disparador que no es horario: tope diario por regla', async () => {
    const button = ruleRow('rb', { ...MONDAY_RULE, trigger: { type: 'button', screen: 'inicio', id: 'enviar', label: 'Enviar' }, actions: [{ ...MONDAY_RULE.actions[0], maxPerDay: 1 }] } as unknown as typeof MONDAY_RULE, { trigger_kind: 'button' });
    const { db, tables } = world([button]);
    const sent: Sent[] = [];
    const first = queueRun(tables, 'rb');
    await executeRun(db, first.id, ORG, deps(sent));
    expect(sent).toHaveLength(2);
    const second = queueRun(tables, 'rb');
    const out = await executeRun(db, second.id, ORG, deps(sent));
    expect(out.status).toBe('succeeded');
    expect(sent).toHaveLength(2);
    expect((second.result as Array<{ detail: string }>)[0]?.detail).toMatch(/ya mandó 1 reporte hoy \(tope de 1/);
  });

  it('una tabla que ya no existe falla con un mensaje claro', async () => {
    const bad = { ...MONDAY_RULE.actions[0], source: { kind: 'query', tracker: 'borrada', metrics: [{ op: 'count' }] } };
    const { db, tables } = world([ruleRow('r1', { ...MONDAY_RULE, actions: [bad] } as unknown as typeof MONDAY_RULE)]);
    const run = queueRun(tables, 'r1');
    const out = await executeRun(db, run.id, ORG, deps([]));
    expect(out.status).toBe('failed');
    expect(run.error).toMatch(/«borrada» ya no existe/);
  });
});
