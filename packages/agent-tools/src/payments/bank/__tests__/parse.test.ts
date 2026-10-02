import { describe, expect, it } from 'vitest';
import {
  decodeText,
  detectDelimiter,
  inferDateOrder,
  inferDecimalStyle,
  parseAmount,
  parseCsv,
  parseDate,
} from '../format';
import { type ParsedStatement, parseStatementRows } from '../parse';
import { parseStatementFile } from '../read';

/**
 * Leer extractos como los exportan los bancos colombianos.
 *
 * Lo que se cuida: que «1.234.567,89» y «1,234,567.89» sean el mismo número,
 * que el 03/04 sea el 3 de abril, que sólo entre lo que entró, y que la
 * referencia de cada abono sea la misma cada vez que se lee el mismo archivo
 * —que es lo que hace que reimportar no duplique.
 */

function ready(p: ReturnType<typeof parseStatementRows>): ParsedStatement {
  if (p.status !== 'ready') throw new Error(`esperaba ready, llegó: ${p.message}`);
  return p;
}

describe('importes en es-CO y en en-US', () => {
  it.each([
    ['1.234.567,89', 1234567.89],
    ['1,234,567.89', 1234567.89],
    ['$ 4.200.000', 4200000],
    ['$4.200.000,00', 4200000],
    ['-1.500.000,00', -1500000],
    ['(1.200,50)', -1200.5],
    ['1.200,00-', -1200],
    ['-$ 50.000', -50000],
    ['COP 75.000', 75000],
    ['1234567.8', 1234567.8],
    ['1234567,8', 1234567.8],
    ['1.234', 1234],
    ['1,234', 1234],
    ['0,00', 0],
  ])('«%s» es %d', (raw, expected) => {
    expect(parseAmount(raw)).toBe(expected);
  });

  it('un número que ya viene de Excel se queda igual', () => {
    expect(parseAmount(4200000.5)).toBe(4200000.5);
  });

  it('lo que no es número es nulo, no cero', () => {
    expect(parseAmount('ABONO')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount('1.2.3,4.5')).toBeNull();
  });

  it('la columna decide el separador cuando la celda sola no puede', () => {
    const style = inferDecimalStyle(['1,234.56', '12.50', '3,000.00']);
    expect(style).toBe('dot');
    // «1.234» en una columna con punto decimal es uno coma dos tres cuatro.
    expect(parseAmount('1.234', style)).toBe(1.23);
    expect(inferDecimalStyle(['1.234,56', '1.000.000'])).toBe('comma');
    expect(parseAmount('1.234', 'comma')).toBe(1234);
  });
});

describe('fechas', () => {
  it.each([
    ['03/04/2026', '2026-04-03'],
    ['3/4/26', '2026-04-03'],
    ['2026-04-03', '2026-04-03'],
    ['2026/04/03', '2026-04-03'],
    ['20260403', '2026-04-03'],
    ['2026-04-03T00:00:00.000Z', '2026-04-03'],
    ['03-abr-2026', '2026-04-03'],
    ['3 ABR 2026', '2026-04-03'],
    ['03.04.2026 10:15', '2026-04-03'],
  ])('«%s» es %s', (raw, iso) => {
    expect(parseDate(raw)).toBe(iso);
  });

  it('el número de serie de Excel', () => {
    expect(parseDate(46115)).toBe('2026-04-03');
  });

  it('dd/mm salvo que la columna diga lo contrario', () => {
    expect(inferDateOrder(['03/04/2026', '13/04/2026'])).toBe('dmy');
    expect(inferDateOrder(['04/03/2026', '04/13/2026'])).toBe('mdy');
    expect(parseDate('04/13/2026', 'mdy')).toBe('2026-04-13');
  });

  it('una fecha imposible es nula', () => {
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('hola')).toBeNull();
  });

  it('dd/mm sin año sólo con el año del extracto', () => {
    expect(parseDate('03/04')).toBeNull();
    expect(parseDate('03/04', 'dmy', 2026)).toBe('2026-04-03');
  });
});

describe('CSV', () => {
  it('detecta punto y coma, respeta comillas y comas decimales', () => {
    const text = 'Fecha;Descripción;Valor\n01/09/2026;"PAGO; FV-1";"1.200,50"\n';
    expect(detectDelimiter(text)).toBe(';');
    expect(parseCsv(text)).toEqual([
      ['Fecha', 'Descripción', 'Valor'],
      ['01/09/2026', 'PAGO; FV-1', '1.200,50'],
    ]);
  });

  it('lee Windows-1252 sin romper las tildes, y quita el BOM', () => {
    const latin = Buffer.from('Descripción;Crédito\n', 'latin1');
    expect(decodeText(latin)).toBe('Descripción;Crédito\n');
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Fecha,Valor')]);
    expect(decodeText(bom)).toBe('Fecha,Valor');
  });
});

describe('Bancolombia (Excel de la Sucursal Virtual)', () => {
  const rows = [
    ['BANCOLOMBIA S.A.', null, null, null, null, null],
    ['Cuenta Corriente No. 123-456789-01', null, null, null, null, null],
    [null, null, null, null, null, null],
    ['FECHA', 'DESCRIPCIÓN', 'SUCURSAL', 'DCTO.', 'VALOR', 'SALDO'],
    ['1/09/2026', 'PAGO PSE COLTRANS SAS FV-1043', 'VIRTUAL', '', 4200000, 10200000],
    ['2/09/2026', 'PAGO A PROVEEDOR ACME', 'VIRTUAL', '', -1500000, 8700000],
    ['2/09/2026', 'IMPTO GOBIERNO 4X1000', '', '', -6000, 8694000],
    ['3/09/2026', 'TRANSFERENCIA DESDE NEQUI', 'VIRTUAL', '8812', 350000.5, 9044000.5],
    ['', 'TOTAL', '', '', '', ''],
  ];

  it('reconoce el banco, la cuenta y las columnas', () => {
    const p = ready(parseStatementRows(rows));
    expect(p.bank.id).toBe('bancolombia');
    expect(p.bank.detectedBy).toBe('name');
    expect(p.headerRow).toBe(3);
    expect(p.accountHint).toBe('12345678901');
    expect(p.columnNames).toMatchObject({
      date: 'FECHA',
      description: 'DESCRIPCIÓN',
      reference: 'DCTO.',
      amount: 'VALOR',
      balance: 'SALDO',
    });
  });

  it('sólo los abonos entran; las salidas se cuentan y se ignoran', () => {
    const p = ready(parseStatementRows(rows));
    expect(p.credits.map((c) => [c.date, c.amount])).toEqual([
      ['2026-09-01', 4200000],
      ['2026-09-03', 350000.5],
    ]);
    expect(p.debits).toBe(2);
    expect(p.debitsTotal).toBe(1506000);
    expect(p.credits[0]?.line).toBe(5);
    expect(p.credits[1]?.reference).toBe('8812');
    expect(p.period).toEqual({ from: '2026-09-01', to: '2026-09-03' });
  });

  it('el mismo archivo da las mismas referencias', () => {
    const a = ready(parseStatementRows(rows)).credits.map((c) => c.sourceRef);
    const b = ready(parseStatementRows(rows)).credits.map((c) => c.sourceRef);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(2);
    expect(a[0]).toMatch(/^h:[0-9a-f]{40}$/);
  });

  it('un periodo que se solapa repite las referencias de los días comunes', () => {
    const later = [
      rows[3],
      rows[7],
      ['4/09/2026', 'PAGO PSE ANDINA LTDA', 'VIRTUAL', '', 900000, 9944000.5],
    ];
    const first = ready(parseStatementRows(rows)).credits;
    const second = ready(parseStatementRows(later as typeof rows)).credits;
    expect(second[0]?.sourceRef).toBe(first[1]?.sourceRef);
    expect(second[1]?.sourceRef).not.toBe(first[0]?.sourceRef);
  });
});

describe('Davivienda (CSV con punto y coma y pesos con signo)', () => {
  const csv = [
    'Fecha de Sistema;Documento;Descripción motivo;Transacción;Oficina de Recaudo;ID Origen/Destino;Valor Total;Referencia 1;Referencia 2',
    '05/09/2026;0001;Abono ACH;Nota Crédito;Virtual;900123456;$ 1.190.000,00;FV-2-22;',
    '06/09/2026;0002;Compra POS;Nota Débito;Virtual;;-$ 50.000,00;;',
    '07/09/2026;0003;Abono ACH;Nota Crédito;Virtual;800555111;$ 2.000.000,00;;PEDIDO 77',
  ].join('\n');

  it('lee el formato y saca el NIT y las dos referencias', async () => {
    const p = await parseStatementFile(Buffer.from(csv, 'utf8'), 'movimientos.csv', 'text/csv');
    const r = ready(p as ReturnType<typeof parseStatementRows>);
    expect(r.bank.id).toBe('davivienda');
    expect(r.credits).toHaveLength(2);
    expect(r.credits[0]).toMatchObject({
      date: '2026-09-05',
      amount: 1190000,
      nit: '900123456',
      reference: 'FV-2-22',
      description: 'Abono ACH',
    });
    expect(r.credits[1]?.reference).toBe('PEDIDO 77');
    expect(r.debits).toBe(1);
  });
});

describe('BBVA (formato en-US)', () => {
  it('lee 1,234,567.89 y usa la fecha de operación, no la valor', () => {
    const rows = [
      ['Fecha Operación', 'Fecha Valor', 'Concepto', 'Importe', 'Saldo'],
      ['09/01/2026', '09/02/2026', 'TRANSF RECIBIDA 900123456', '1,234,567.89', '5,000,000.00'],
      ['09/15/2026', '09/15/2026', 'COMISION', '-12,500.00', '4,987,500.00'],
    ];
    const p = ready(parseStatementRows(rows, { fileName: 'BBVA_sept.xlsx' }));
    expect(p.bank.id).toBe('bbva');
    expect(p.columnNames.date).toBe('Fecha Operación');
    // 09/15 delata mes/día en toda la columna.
    expect(p.credits[0]).toMatchObject({ date: '2026-09-01', amount: 1234567.89 });
  });
});

describe('Banco de Bogotá (débitos y créditos aparte)', () => {
  it('toma la columna de créditos y deja las de débito', () => {
    const rows = [
      ['Banco de Bogotá - Movimientos'],
      ['Fecha', 'Transacción', 'Oficina', 'Documento', 'Débitos', 'Créditos', 'Saldo'],
      ['10/09/2026', 'CONSIGNACION NAL', 'CHAPINERO', '55', '', '1.500.000,00', '3.000.000,00'],
      ['11/09/2026', 'PAGO NOMINA', 'VIRTUAL', '56', '800.000,00', '', '2.200.000,00'],
    ];
    const p = ready(parseStatementRows(rows));
    expect(p.bank.id).toBe('bogota');
    expect(p.credits).toHaveLength(1);
    expect(p.credits[0]).toMatchObject({ amount: 1500000, balance: 3000000, reference: '55' });
    expect(p.debits).toBe(1);
  });
});

describe('genérico', () => {
  it('valor sin signo con una columna de tipo C/D', () => {
    const rows = [
      ['Fecha', 'Detalle', 'Tipo', 'Monto', 'Id transacción'],
      ['01/09/2026', 'Recaudo cliente', 'C', '100.000', 'TX-1'],
      ['01/09/2026', 'Pago servicios', 'D', '40.000', 'TX-2'],
    ];
    const p = ready(parseStatementRows(rows));
    expect(p.bank.id).toBe('generic');
    expect(p.credits).toHaveLength(1);
    expect(p.credits[0]?.sourceRef).toBe('t:2026-09-01:tx1');
  });

  it('valor sin signo y sin tipo: decide por las palabras, y lo que no sabe no lo importa', () => {
    const rows = [
      ['Fecha', 'Descripción', 'Valor'],
      ['01/09/2026', 'ABONO TRANSFERENCIA RECIBIDA', '100.000'],
      ['02/09/2026', 'RETIRO CAJERO', '40.000'],
      ['03/09/2026', 'MOVIMIENTO 123', '10.000'],
    ];
    const p = ready(parseStatementRows(rows));
    expect(p.credits.map((c) => c.amount)).toEqual([100000]);
    expect(p.debits).toBe(1);
    expect(p.skipped).toEqual([{ line: 4, reason: 'no se sabe si entró o salió' }]);
    expect(p.warnings.join(' ')).toMatch(/sin signo/);
  });

  it('dos abonos idénticos el mismo día sin saldo son dos, con referencias distintas', () => {
    const rows = [
      ['Fecha', 'Descripción', 'Valor'],
      ['01/09/2026', 'PAGO PSE', '1.000.000'],
      ['01/09/2026', 'PAGO PSE', '1.000.000'],
      ['01/09/2026', 'PAGO PSE', '-5.000'],
    ];
    const p = ready(parseStatementRows(rows));
    expect(p.credits).toHaveLength(2);
    expect(p.credits[0]?.sourceRef).not.toBe(p.credits[1]?.sourceRef);
  });

  it('un id que se repite el mismo día no funde dos abonos', () => {
    const rows = [
      ['Fecha', 'Concepto', 'Valor', 'Consecutivo'],
      ['01/09/2026', 'ABONO', '10', '7'],
      ['01/09/2026', 'ABONO', '20', '7'],
    ];
    const refs = ready(parseStatementRows(rows)).credits.map((c) => c.sourceRef);
    expect(refs).toEqual(['t:2026-09-01:7', 't:2026-09-01:7#2']);
  });
});

describe('formato desconocido', () => {
  const rows = [
    ['Día', 'Glosa del movimiento', 'Plata'],
    ['01/09/2026', 'ABONO X', '100.000'],
  ];

  it('no adivina: dice los encabezados que encontró', () => {
    const p = parseStatementRows(rows);
    expect(p.status).toBe('needs_mapping');
    if (p.status !== 'needs_mapping') return;
    expect(p.message).toContain('Día, Glosa del movimiento, Plata');
    expect(p.headers).toEqual(['Día', 'Glosa del movimiento', 'Plata']);
    expect(p.headerRow).toBe(0);
    expect(p.sample[0]).toEqual(['01/09/2026', 'ABONO X', '100.000']);
  });

  it('con las columnas escogidas a mano, lee', () => {
    const p = ready(
      parseStatementRows(rows, {
        mapping: { headerRow: 0, columns: { date: 0, description: 1, amount: 2 } },
      }),
    );
    expect(p.credits[0]).toMatchObject({ date: '2026-09-01', amount: 100000 });
    expect(p.bank.detectedBy).toBe('none');
  });

  it('el .xls antiguo y el PDF se rechazan con instrucciones', async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]);
    await expect(parseStatementFile(ole, 'extracto.xls', null)).rejects.toThrow(
      /\.xlsx o como CSV/,
    );
    await expect(
      parseStatementFile(Buffer.from('%PDF'), 'extracto.pdf', 'application/pdf'),
    ).rejects.toThrow(/PDF/);
  });
});

describe('Excel de verdad', () => {
  it('lee un .xlsx escrito con exceljs, con fechas y números de celda', async () => {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Movimientos');
    ws.addRow(['Davivienda']);
    ws.addRow(['Fecha', 'Descripción', 'Créditos', 'Débitos', 'Saldo']);
    ws.addRow([new Date(Date.UTC(2026, 8, 5)), 'ABONO ACH CLIENTE', 250000, null, 1250000]);
    ws.addRow([new Date(Date.UTC(2026, 8, 6)), 'PAGO PROVEEDOR', null, 100000, 1150000]);
    const bytes = Buffer.from(await wb.xlsx.writeBuffer());
    const p = await parseStatementFile(bytes, 'mov.xlsx', null);
    const r = ready(p as ReturnType<typeof parseStatementRows>);
    expect(r.bank.id).toBe('davivienda');
    expect(r.credits).toHaveLength(1);
    expect(r.credits[0]).toMatchObject({ date: '2026-09-05', amount: 250000, balance: 1250000 });
  });
});
