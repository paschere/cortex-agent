import { describe, expect, it } from 'vitest';
import type { InvoicingCatalog } from '../accounting/types';
import { buildAlegraInvoice, buildSiigoInvoice, idempotencyKeyFrom } from './einvoice';

const TODAY = '2026-10-03';

const doc = {
  kind: 'order' as const,
  number: 3,
  client_name: 'Nexa Logística S.A.S.',
  client_tax_id: '900123456',
  issue_date: '2026-10-01',
  due_date: null,
  payment_form: 'credito' as const,
  payment_days: 30,
  notes: 'Fletes de octubre',
  currency: 'COP',
  withholding_total: 0,
};

const lines = [
  {
    description: 'Flete Bogotá–Cali',
    product_ref: '501',
    product_code: 'FLT-BC',
    quantity: 10,
    unit_price: 1_200_000,
    discount_pct: 0,
    tax_rate: 'iva_19' as const,
  },
  {
    description: 'Seguro de carga',
    product_ref: '502',
    product_code: 'SEG',
    quantity: 1,
    unit_price: 100_000,
    discount_pct: 10,
    tax_rate: 'excluido' as const,
  },
];

const siigoCatalog: InvoicingCatalog = {
  documentTypes: [
    { id: '24446', name: 'Factura electrónica', electronic: true, discountType: 'percentage' },
    { id: '111', name: 'Factura POS', electronic: false },
  ],
  sellers: [{ id: '629', name: 'Ana Ruiz' }],
  paymentTypes: [
    { id: '5636', name: 'Crédito', credit: true },
    { id: '5637', name: 'Efectivo', credit: false },
  ],
  taxes: [
    { id: '13156', name: 'IVA 19%', kind: 'iva', percentage: 19 },
    { id: '13157', name: 'IVA 5%', kind: 'iva', percentage: 5 },
    { id: '20001', name: 'Retefuente 4%', kind: 'retefuente', percentage: 4 },
  ],
};

describe('Siigo: POST /v1/invoices', () => {
  it('arma la factura con la forma de la documentación', () => {
    const draft = buildSiigoInvoice({
      doc,
      lines,
      catalog: siigoCatalog,
      customerFound: true,
      today: TODAY,
    });
    expect(draft.problems).toEqual([]);
    expect(draft.payload).toEqual({
      document: { id: 24446 },
      date: TODAY,
      customer: { identification: '900123456', branch_office: 0 },
      seller: 629,
      observations: 'Fletes de octubre\nRef. Cortex PED-0003',
      items: [
        {
          code: 'FLT-BC',
          description: 'Flete Bogotá–Cali',
          quantity: 10,
          price: 1_200_000,
          taxes: [{ id: 13156 }],
        },
        { code: 'SEG', description: 'Seguro de carga', quantity: 1, price: 100_000, discount: 10 },
      ],
      // La suma de los pagos es el total de la factura (base + IVA).
      payments: [{ id: 5636, value: 12_000_000 + 2_280_000 + 90_000, due_date: '2026-11-02' }],
      stamp: { send: true },
      mail: { send: true },
    });
    expect(draft.summary.total).toBe(14_370_000);
  });

  it('el descuento va en valor cuando el tipo de documento lo pide', () => {
    const catalog = {
      ...siigoCatalog,
      documentTypes: [{ id: '1', name: 'FV', electronic: true, discountType: 'value' as const }],
    };
    const draft = buildSiigoInvoice({ doc, lines, catalog, customerFound: true, today: TODAY });
    const items = draft.payload.items as Array<Record<string, unknown>>;
    expect(items[1]?.discount).toBe(10_000);
  });

  it('de contado: forma de pago sin crédito y sin fecha de vencimiento', () => {
    const draft = buildSiigoInvoice({
      doc: { ...doc, payment_form: 'contado', payment_days: 0 },
      lines,
      catalog: siigoCatalog,
      customerFound: true,
      today: TODAY,
    });
    expect(draft.payload.payments).toEqual([{ id: 5637, value: 14_370_000 }]);
  });

  it('dice qué impide emitir, en español, sin mandar nada', () => {
    const draft = buildSiigoInvoice({
      doc: { ...doc, client_tax_id: '800999888' },
      lines: [
        { ...lines[0], product_code: null, tax_rate: 'iva_0' as const },
      ] as unknown as typeof lines,
      catalog: {
        ...siigoCatalog,
        documentTypes: [siigoCatalog.documentTypes[1] as InvoicingCatalog['documentTypes'][number]],
        sellers: [],
      },
      customerFound: false,
      today: TODAY,
    });
    const text = draft.problems.join(' ');
    expect(text).toMatch(/no está creado en Siigo/);
    expect(text).toMatch(/no tiene un tipo de factura electrónica activo/);
    expect(text).toMatch(/vendedor/);
    expect(text).toMatch(/no tiene un producto de Siigo/);
    expect(text).toMatch(/IVA 0 % \(exento\)/);
  });

  it('sin NIT, sin líneas o en otra moneda no se emite', () => {
    const draft = buildSiigoInvoice({
      doc: { ...doc, client_tax_id: null, currency: 'USD' },
      lines: [],
      catalog: siigoCatalog,
      customerFound: false,
      today: TODAY,
    });
    expect(draft.problems.join(' ')).toMatch(/Falta el NIT/);
    expect(draft.problems.join(' ')).toMatch(/no tiene líneas/);
    expect(draft.problems.join(' ')).toMatch(/USD/);
  });

  it('las retenciones no van en la factura y se dice por qué', () => {
    const draft = buildSiigoInvoice({
      doc: { ...doc, withholding_total: 480_000 },
      lines,
      catalog: siigoCatalog,
      customerFound: true,
      today: TODAY,
    });
    expect(JSON.stringify(draft.payload)).not.toContain('20001');
    expect(draft.notes.join(' ')).toMatch(/recibo de caja/);
  });
});

describe('Alegra: POST /invoices', () => {
  const alegraCatalog: InvoicingCatalog = {
    documentTypes: [{ id: '7', name: 'Electrónica · FE', electronic: true }],
    sellers: [],
    paymentTypes: [],
    taxes: [{ id: '3', name: 'IVA', kind: 'iva', percentage: 19 }],
  };

  it('arma la factura con la forma de la documentación', () => {
    const draft = buildAlegraInvoice({
      doc,
      lines,
      catalog: alegraCatalog,
      customerId: '88',
      today: TODAY,
    });
    expect(draft.problems).toEqual([]);
    expect(draft.payload).toEqual({
      date: TODAY,
      dueDate: '2026-11-02',
      client: { id: 88 },
      items: [
        {
          id: 501,
          description: 'Flete Bogotá–Cali',
          quantity: 10,
          price: 1_200_000,
          tax: [{ id: 3 }],
        },
        {
          id: 502,
          description: 'Seguro de carga',
          quantity: 1,
          price: 100_000,
          discount: 10,
          tax: [],
        },
      ],
      paymentForm: 'CREDIT',
      numberTemplate: { id: 7 },
      observations: 'Fletes de octubre\nRef. Cortex PED-0003',
      anotation: 'Fletes de octubre',
      stamp: { generateStamp: true },
      status: 'open',
    });
  });

  it('de contado lleva medio de pago; sin cliente en Alegra no sale', () => {
    const draft = buildAlegraInvoice({
      doc: { ...doc, payment_form: 'contado' },
      lines,
      catalog: alegraCatalog,
      customerId: null,
      today: TODAY,
    });
    expect(draft.payload.paymentForm).toBe('CASH');
    expect(draft.payload.paymentMethod).toBe('transfer');
    expect(draft.problems.join(' ')).toMatch(/no está creado en Alegra/);
  });
});

describe('llave de idempotencia', () => {
  it('alfanumérica y de 30 caracteres, como la pide Siigo', () => {
    const key = idempotencyKeyFrom('ab'.repeat(32));
    expect(key).toMatch(/^[A-Za-z0-9]{30}$/);
  });
});
