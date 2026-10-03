import { describe, expect, it } from 'vitest';
import {
  type TrialBalanceRow,
  balanceFromTrialBalance,
  leafAccounts,
  parseAmount,
  pnlFromTrialBalance,
  trialBalanceFromRows,
  xlsxRows,
} from './reports';
import { alegraBalanceFrom, alegraPnlFrom, mcpToolResult, parseMcpBody } from './reports-alegra';
import { quickbooksBalanceFrom, quickbooksPnlFrom } from './reports-quickbooks';
import { isSiigoReportUrl, siigoReports } from './reports-siigo';

const row = (
  code: string,
  debit: number,
  credit: number,
  final: number,
  name = code,
): TrialBalanceRow => ({
  code,
  name,
  initial: 0,
  debit,
  credit,
  final,
});

describe('parseAmount', () => {
  it('reads Colombian, English and accounting formats', () => {
    expect(parseAmount('1.234.567,89')).toBeCloseTo(1234567.89);
    expect(parseAmount('1,234,567.89')).toBeCloseTo(1234567.89);
    expect(parseAmount('(1.500)')).toBe(-1500);
    expect(parseAmount('-2500.5')).toBe(-2500.5);
    expect(parseAmount('$ 3.000')).toBe(3000);
    expect(parseAmount(42)).toBe(42);
    expect(parseAmount({ result: '10,5' })).toBe(10.5);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('trial balance (PUC)', () => {
  // Clase, grupo y auxiliares a la vez: sumar todo contaría tres veces.
  const rows: TrialBalanceRow[] = [
    row('1', 0, 0, 1_000),
    row('11', 0, 0, 400),
    row('110505', 0, 0, 400),
    row('13', 0, 0, 350),
    row('130505', 0, 0, 350),
    row('15', 0, 0, 250),
    row('152405', 0, 0, 250),
    row('22', 0, 0, -300),
    row('220505', 0, 0, -300),
    row('31', 0, 0, -500),
    row('310505', 0, 0, -500),
    row('4135', 0, 900, -900),
    row('6135', 400, 0, 400),
    row('5105', 250, 0, 250),
    row('5305', 30, 0, 30),
    row('5405', 20, 0, 20),
  ];

  it('keeps only leaf accounts', () => {
    const leaves = leafAccounts(rows).map((r) => r.code);
    expect(leaves).toContain('110505');
    expect(leaves).not.toContain('11');
    expect(leaves).not.toContain('1');
  });

  it('builds a balance sheet that balances, with the open result in equity', () => {
    const b = balanceFromTrialBalance(rows, {
      provider: 'siigo',
      asOf: '2026-09-30',
      currency: 'COP',
    });
    expect(b.currentAssets).toBe(750);
    expect(b.nonCurrentAssets).toBe(250);
    expect(b.totalAssets).toBe(1000);
    expect(b.currentLiabilities).toBe(300);
    // 500 de capital + 200 del resultado del año (900 − 400 − 250 − 30 − 20).
    expect(b.equity).toBe(700);
    expect(b.totalAssets).toBeCloseTo(b.totalLiabilities + b.equity);
    expect(b.lines.find((l) => l.code === '13')?.name).toMatch(/Deudores/);
  });

  it('builds a P&L from movements, not balances', () => {
    const p = pnlFromTrialBalance(rows, {
      provider: 'siigo',
      from: '2026-01-01',
      to: '2026-09-30',
      currency: 'COP',
    });
    expect(p.revenue).toBe(900);
    expect(p.costOfSales).toBe(400);
    expect(p.operatingExpenses).toBe(250);
    expect(p.otherExpenses).toBe(30);
    expect(p.incomeTax).toBe(20);
    expect(p.netIncome).toBe(200);
  });

  it('finds the header and reads rows below the company banner', () => {
    const sheet = [
      ['EMPRESA DEMO SAS'],
      ['Balance de prueba general', null, '2026'],
      [],
      [
        'Nivel',
        'Código cuenta contable',
        'Nombre cuenta contable',
        'Saldo inicial',
        'Movimiento débito',
        'Movimiento crédito',
        'Saldo final',
      ],
      ['Clase', '1', 'ACTIVO', '0', '0', '0', '1.000,00'],
      ['Auxiliar', '11050501', 'Caja general', '0', '0', '0', '400,00'],
      ['', 'Total', '', '', '', '', '1.000'],
    ];
    const parsed = trialBalanceFromRows(sheet);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toMatchObject({ code: '11050501', name: 'Caja general', final: 400 });
  });

  it('round-trips through a real xlsx', async () => {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Balance');
    ws.addRow(['Empresa']);
    ws.addRow(['Código', 'Nombre', 'Saldo inicial', 'Débito', 'Crédito', 'Saldo final']);
    ws.addRow(['110505', 'Caja', 0, 100, 0, 100]);
    ws.addRow(['413505', 'Ventas', 0, 0, 100, -100]);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    const rows2 = trialBalanceFromRows(await xlsxRows(bytes));
    expect(rows2.map((r) => r.code)).toEqual(['110505', '413505']);
  });
});

describe('Siigo reports', () => {
  it('only downloads from Siigo storage', () => {
    expect(isSiigoReportUrl('https://reportsexcelprod.blob.core.windows.net/x/Balance.xlsx')).toBe(
      true,
    );
    expect(isSiigoReportUrl('http://reportsexcelprod.blob.core.windows.net/x.xlsx')).toBe(false);
    expect(isSiigoReportUrl('https://evil.example.com/x.xlsx')).toBe(false);
  });

  it('posts the trial balance request and parses the file', async () => {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('B');
    ws.addRow(['Código', 'Nombre', 'Débito', 'Crédito', 'Saldo final']);
    ws.addRow(['4135', 'Ventas', 0, 500, -500]);
    ws.addRow(['6135', 'Costo', 200, 0, 200]);
    const file = await wb.xlsx.writeBuffer();
    const posted: unknown[] = [];
    const client = {
      post: async (_path: string, body: unknown) => {
        posted.push(body);
        return { file_url: 'https://reportsexcelprod.blob.core.windows.net/a/b.xlsx' };
      },
    } as unknown as Parameters<typeof siigoReports>[0];
    const fakeFetch = (async () => new Response(file as ArrayBuffer)) as unknown as typeof fetch;
    const p = await siigoReports(client, { fetch: fakeFetch }).profitAndLoss(
      '2026-01-01',
      '2026-09-30',
    );
    expect(posted[0]).toMatchObject({
      year: 2026,
      month_start: 1,
      month_end: 9,
      includes_tax_difference: false,
    });
    expect(p.revenue).toBe(500);
    expect(p.costOfSales).toBe(200);
  });
});

describe('Alegra reports (MCP)', () => {
  it('reads JSON-RPC over plain JSON and SSE', () => {
    const json = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: '{"a":1}' }] },
    };
    expect(mcpToolResult(parseMcpBody(JSON.stringify(json)))).toEqual({ a: 1 });
    const sse = `event: message\ndata: ${JSON.stringify(json)}\n\n`;
    expect(mcpToolResult(parseMcpBody(sse))).toEqual({ a: 1 });
    expect(() =>
      mcpToolResult({ result: { isError: true, content: [{ text: 'sin permiso' }] } }),
    ).toThrow(/sin permiso/);
  });

  it('maps the general balance, splitting current by name or PUC code', () => {
    const raw = {
      assets: {
        '2026-09-30': [
          {
            name: 'Activo corriente',
            balance: '700',
            children: [
              { code: '1105', name: 'Caja', balance: '200', children: [] },
              { code: '1305', name: 'Clientes', balance: '500', children: [] },
            ],
          },
          { code: '1524', name: 'Equipo de oficina', balance: '300', children: [] },
        ],
      },
      liabilities: {
        '2026-09-30': [{ code: '2205', name: 'Proveedores', balance: '400', children: [] }],
      },
      equity: { '2026-09-30': [{ code: '3105', name: 'Capital', balance: '600', children: [] }] },
      totals: { '2026-09-30': { assets: 1000, liabilities: 400, equity: 600 } },
    };
    const b = alegraBalanceFrom(raw, '2026-09-30', 'COP');
    expect(b.totalAssets).toBe(1000);
    expect(b.currentAssets).toBe(700);
    expect(b.nonCurrentAssets).toBe(300);
    expect(b.currentLiabilities).toBe(400);
    expect(b.equity).toBe(600);
  });

  it('maps the P&L tree by type', () => {
    const p = alegraPnlFrom(
      [
        { name: 'Ingresos operacionales', type: 'income', balance: '1000', children: [] },
        { name: 'Costo de ventas', type: 'cost', balance: '400', children: [] },
        { name: 'Gastos', type: 'expense', balance: '300', children: [] },
      ],
      '2026-01-01',
      '2026-09-30',
      'COP',
    );
    expect(p.netIncome).toBe(300);
    expect(p.costOfSales).toBe(400);
  });
});

describe('QuickBooks reports', () => {
  const section = (group: string, title: string, total: string, rows: unknown[] = []) => ({
    type: 'Section',
    group,
    Header: { ColData: [{ value: title }, { value: '' }] },
    Rows: { Row: rows },
    Summary: { ColData: [{ value: `Total ${title}` }, { value: total }] },
  });
  const data = (name: string, v: string) => ({
    type: 'Data',
    ColData: [{ value: name }, { value: v }],
  });

  it('reads BalanceSheet groups', () => {
    const report = {
      Header: { Currency: 'USD' },
      Rows: {
        Row: [
          section('TotalAssets', 'ASSETS', '1500.00', [
            section('CurrentAssets', 'Current Assets', '900.00', [data('Checking', '900.00')]),
            section('FixedAssets', 'Fixed Assets', '600.00', [data('Truck', '600.00')]),
          ]),
          section('TotalLiabilitiesAndEquity', 'LIABILITIES AND EQUITY', '1500.00', [
            section('Liabilities', 'Liabilities', '500.00', [
              section('CurrentLiabilities', 'Current Liabilities', '300.00', [
                data('AP', '300.00'),
              ]),
              section('LongTermLiabilities', 'Long-Term Liabilities', '200.00', [
                data('Loan', '200.00'),
              ]),
            ]),
            section('Equity', 'Equity', '1000.00', [data('Retained Earnings', '1000.00')]),
          ]),
        ],
      },
    };
    const b = quickbooksBalanceFrom(report, '2026-09-30', 'COP');
    expect(b).toMatchObject({
      currency: 'USD',
      totalAssets: 1500,
      currentAssets: 900,
      nonCurrentAssets: 600,
      totalLiabilities: 500,
      currentLiabilities: 300,
      nonCurrentLiabilities: 200,
      equity: 1000,
    });
    expect(b.lines.some((l) => l.name === 'Truck' && l.section === 'activo_no_corriente')).toBe(
      true,
    );
  });

  it('reads ProfitAndLoss groups', () => {
    const report = {
      Rows: {
        Row: [
          section('Income', 'Income', '1000.00'),
          section('COGS', 'Cost of Goods Sold', '300.00'),
          {
            type: 'Section',
            group: 'GrossProfit',
            Summary: { ColData: [{ value: 'Gross Profit' }, { value: '700.00' }] },
          },
          section('Expenses', 'Expenses', '400.00'),
          {
            type: 'Section',
            group: 'NetIncome',
            Summary: { ColData: [{ value: 'Net Income' }, { value: '300.00' }] },
          },
        ],
      },
    };
    const p = quickbooksPnlFrom(report, '2026-01-01', '2026-09-30', 'USD');
    expect(p).toMatchObject({
      revenue: 1000,
      costOfSales: 300,
      operatingExpenses: 400,
      netIncome: 300,
    });
  });
});
