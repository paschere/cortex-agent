import { describe, expect, it } from 'vitest';
import { buildAlegraBill, buildAlegraPayment, pickAlegraBank } from './alegra';
import {
  AccountMap,
  type AccountMapRow,
  CATEGORY_DEFAULTS,
  ROLE_DEFAULTS,
  bankRoleKey,
} from './mapping';
import {
  buildQuickbooksBill,
  buildQuickbooksBillPayment,
  buildQuickbooksPayment,
  qbQuote,
} from './quickbooks';
import {
  type PurchaseSource,
  type ReceiptSource,
  type SupplierPaymentSource,
  balanced,
  commonProblems,
  defaultAccountWarnings,
  purchaseEntries,
  receiptEntries,
  supplierPaymentEntries,
  writebackIdempotencyKey,
} from './shape';
import {
  type SiigoWriteCatalog,
  buildSiigoPaymentReceipt,
  buildSiigoPurchase,
  buildSiigoVoucher,
  findSiigoTax,
  parseSiigoName,
  pickSiigoBankPayment,
  splitSupplierNumber,
} from './siigo';

/**
 * Lo que Cortex le mandaría a cada programa, sin red. Las formas de los JSON
 * son las de los ejemplos de la documentación oficial (Siigo: API Blueprint;
 * Alegra: post_bills / post_payments; QuickBooks: bill, payment,
 * billpayment): si un campo cambia de nombre aquí, cambió contra la doc.
 */

const PURCHASE: PurchaseSource = {
  kind: 'compra',
  id: 'pay-1',
  supplierId: 'sup-1',
  supplierName: 'Papelería El Cóndor S.A.S.',
  supplierNit: '900123456',
  supplierDv: '7',
  docNumber: 'FEPA-451',
  cufe: 'abc123def456abc123def456',
  issueDate: '2026-09-12',
  dueDate: '2026-10-12',
  currency: 'COP',
  subtotal: 1_000_000,
  iva: 190_000,
  otherTaxes: 0,
  total: 1_190_000,
  withholdings: { retefuente: 25_000, reteiva: 28_500, reteica: 9_660 },
  lines: [
    { description: 'Resmas carta', amount: 600_000, quantity: 60, unitPrice: 10_000 },
    { description: 'Tóner', amount: 400_000, quantity: 2, unitPrice: 200_000 },
  ],
  category: 'otros_gastos',
};

const RECEIPT: ReceiptSource = {
  kind: 'recibo',
  id: 'pm-1',
  date: '2026-09-20',
  amount: 119_000,
  currency: 'COP',
  customerName: 'Nexa Logística',
  customerNit: '209048401',
  invoiceNumber: 'FV-1-68',
  invoiceExternalId: 'inv-ext-68',
  invoiceBalance: 119_000,
  invoiceDate: '2026-09-30',
  bankAccount: 'Bancolombia corriente',
  reference: 'TRF 8812',
};

const SUPPLIER_PAYMENT: SupplierPaymentSource = {
  kind: 'pago_proveedor',
  id: 'pay-1',
  date: '2026-09-28',
  amount: 1_126_840,
  currency: 'COP',
  supplierId: 'sup-1',
  supplierName: 'Papelería El Cóndor S.A.S.',
  supplierNit: '900123456',
  docNumber: 'FEPA-451',
  purchaseExternalId: 'purch-ext-1',
  purchaseNumber: 'FC-2-22',
  bankAccount: 'Bancolombia corriente',
  reference: 'PAGO PROV CONDOR',
};

const SIIGO_CATALOG: SiigoWriteCatalog = {
  documentId: 24446,
  paymentTypes: [
    { id: 5636, name: 'Crédito proveedores', dueDate: true },
    { id: 5638, name: 'Bancolombia', dueDate: false },
  ],
  taxes: [
    { id: 13156, name: 'IVA 19%', type: 'IVA', percentage: 19 },
    { id: 13157, name: 'Retefuente compras 2.5%', type: 'ReteFuente', percentage: 2.5 },
    { id: 13158, name: 'ReteIVA 15%', type: 'ReteIVA', percentage: 15 },
    { id: 13159, name: 'ReteICA 9.66 x mil', type: 'ReteICA', percentage: 0.966 },
  ],
};

describe('el plan de cuentas: de lo puntual a lo general', () => {
  const rows: AccountMapRow[] = [
    {
      scope: 'categoria',
      key: 'arriendo',
      account_code: '51201001',
      account_name: 'Arriendo oficina',
      cost_center: '235',
      provider_refs: { alegra: '5063' },
    },
    {
      scope: 'proveedor',
      key: 'sup-9',
      account_code: '51102501',
      account_name: 'Asesoría jurídica',
      cost_center: null,
      provider_refs: {},
    },
    {
      scope: 'rol',
      key: 'proveedores',
      account_code: '22050501',
      account_name: 'Proveedores nacionales',
      cost_center: null,
      provider_refs: { quickbooks: '33' },
    },
    {
      scope: 'rol',
      key: bankRoleKey('Bancolombia  Corriente'),
      account_code: '11100501',
      account_name: 'Bancolombia',
      cost_center: null,
      provider_refs: { siigo: '5638' },
    },
  ];
  const map = new AccountMap(rows);

  it('el proveedor manda sobre su categoría, y la categoría sobre el defecto', () => {
    expect(map.expense({ supplierId: 'sup-9', category: 'arriendo' })).toMatchObject({
      code: '51102501',
      source: 'proveedor',
    });
    expect(map.expense({ supplierId: 'sup-1', category: 'arriendo' })).toMatchObject({
      code: '51201001',
      costCenter: '235',
      refs: { alegra: '5063' },
      source: 'categoria',
    });
    expect(map.expense({ category: 'mercadeo' })).toMatchObject({
      code: CATEGORY_DEFAULTS.mercadeo?.code,
      source: 'defecto',
    });
    // Sin categoría: compras de mercancía; con una desconocida: otros gastos.
    expect(map.expense({})).toMatchObject({ code: '6205' });
    expect(map.expense({ category: 'inventada' })).toMatchObject({ code: '519595' });
  });

  it('los papeles fijos y el banco de cada cuenta del extracto', () => {
    expect(map.role('proveedores')).toMatchObject({ code: '22050501', refs: { quickbooks: '33' } });
    expect(map.role('reteiva')).toMatchObject({
      code: ROLE_DEFAULTS.reteiva.code,
      source: 'defecto',
    });
    expect(map.bank('bancolombia corriente')).toMatchObject({
      code: '11100501',
      refs: { siigo: '5638' },
    });
    expect(map.bank('Davivienda ahorros')).toMatchObject({ code: '111005', source: 'defecto' });
    expect(map.withholdingRole('honorarios')).toBe('retefuente_honorarios');
    expect(map.withholdingRole('proveedores')).toBe('retefuente_compras');
    expect(map.withholdingRole('software')).toBe('retefuente_servicios');
  });
});

describe('la partida que ve la persona antes de aprobar', () => {
  const map = new AccountMap([]);

  it('una compra con IVA y tres retenciones cuadra y le debe al proveedor el neto', () => {
    const entries = purchaseEntries(PURCHASE, map);
    expect(balanced(entries)).toBe(true);
    const byAccount = Object.fromEntries(entries.map((e) => [e.account, e]));
    expect(byAccount['519595']?.debit).toBe(1_000_000);
    expect(byAccount['240810']?.debit).toBe(190_000);
    expect(byAccount['236525']?.credit).toBe(25_000);
    expect(byAccount['236705']?.credit).toBe(28_500);
    expect(byAccount['236801']?.credit).toBe(9_660);
    expect(byAccount['220505']?.credit).toBe(1_126_840);
    expect(commonProblems(PURCHASE, entries)).toEqual([]);
    expect(defaultAccountWarnings(entries)[0]).toMatch(/defecto de Cortex/);
  });

  it('recibo: banco contra clientes; pago: proveedores contra banco', () => {
    const r = receiptEntries(RECEIPT, map);
    expect(r.map((e) => [e.account, e.debit, e.credit])).toEqual([
      ['111005', 119_000, 0],
      ['130505', 0, 119_000],
    ]);
    const p = supplierPaymentEntries(SUPPLIER_PAYMENT, map);
    expect(p.map((e) => [e.account, e.debit, e.credit])).toEqual([
      ['220505', 1_126_840, 0],
      ['111005', 0, 1_126_840],
    ]);
  });

  it('no deja pasar una compra sin NIT, que no suma, o un pago mayor que el saldo', () => {
    const noNit = { ...PURCHASE, supplierNit: null };
    expect(commonProblems(noNit, purchaseEntries(noNit, map)).join(' ')).toMatch(/no tiene NIT/);
    const off = { ...PURCHASE, total: 1_500_000 };
    expect(commonProblems(off, purchaseEntries(off, map)).join(' ')).toMatch(/no da el total/);
    const over = { ...RECEIPT, invoiceBalance: 50_000 };
    expect(commonProblems(over, receiptEntries(over, map)).join(' ')).toMatch(
      /mayor que lo que falta/,
    );
  });
});

describe('idempotencia', () => {
  it('la misma llave para el mismo origen; otra para otra clase u otra empresa; cabe en Siigo (30) y QuickBooks (50)', () => {
    const a = writebackIdempotencyKey('org-1', 'compra', 'pay-1');
    expect(a).toBe(writebackIdempotencyKey('org-1', 'compra', 'pay-1'));
    expect(a).not.toBe(writebackIdempotencyKey('org-1', 'pago_proveedor', 'pay-1'));
    expect(a).not.toBe(writebackIdempotencyKey('org-2', 'compra', 'pay-1'));
    expect(a).toMatch(/^[A-Za-z0-9]{30}$/);
  });
});

describe('Siigo (API Blueprint: /v1/purchases, /v1/vouchers, /v1/payment-receipts)', () => {
  const map = new AccountMap([
    {
      scope: 'categoria',
      key: 'otros_gastos',
      account_code: '51959501',
      account_name: 'Diversos',
      cost_center: '235',
      provider_refs: {},
    },
  ]);

  it('arma la factura de compra como el ejemplo de la doc', () => {
    const out = buildSiigoPurchase({ src: PURCHASE, entries: [], map, catalog: SIIGO_CATALOG });
    expect(out.problems).toEqual([]);
    expect(out.payload).toEqual({
      document: { id: 24446 },
      date: '2026-09-12',
      supplier: { identification: '900123456', branch_office: 0 },
      cost_center: 235,
      provider_invoice: { prefix: 'FEPA', number: '451' },
      observations: expect.stringContaining('Causada desde Cortex'),
      items: [
        {
          type: 'Account',
          code: '51959501',
          description: 'Resmas carta',
          quantity: 1,
          price: 600_000,
          taxes: [{ id: 13156 }, { id: 13157 }],
        },
        {
          type: 'Account',
          code: '51959501',
          description: 'Tóner',
          quantity: 1,
          price: 400_000,
          taxes: [{ id: 13156 }, { id: 13157 }],
        },
      ],
      retentions: [{ id: 13158 }, { id: 13159 }],
      payments: [{ id: 5636, value: 1_126_840, due_date: '2026-10-12' }],
    });
  });

  it('una sola línea cuando los renglones no suman la base, y dice qué impuesto falta', () => {
    const src = {
      ...PURCHASE,
      lines: [{ description: 'x', amount: 10, quantity: 1, unitPrice: 10 }],
    };
    const out = buildSiigoPurchase({
      src,
      entries: [],
      map: new AccountMap([]),
      catalog: { ...SIIGO_CATALOG, taxes: SIIGO_CATALOG.taxes.filter((t) => t.type !== 'ReteICA') },
    });
    expect((out.payload.items as unknown[]).length).toBe(1);
    expect(out.problems.join(' ')).toMatch(/ReteICA del 0.966/);
    // 519595 tiene 6 dígitos: Siigo puede pedir la auxiliar.
    expect(out.warnings.join(' ')).toMatch(/AUXILIAR/);
  });

  it('sin forma de pago a crédito ni tipo de documento, no sale', () => {
    const out = buildSiigoPurchase({
      src: PURCHASE,
      entries: [],
      map,
      catalog: {
        documentId: null,
        paymentTypes: [{ id: 1, name: 'Efectivo', dueDate: false }],
        taxes: SIIGO_CATALOG.taxes,
      },
    });
    expect(out.problems.join(' ')).toMatch(/FC/);
    expect(out.problems.join(' ')).toMatch(/crédito/);
  });

  it('el recibo de caja abona al vencimiento de la factura FV-1-68 (payment en singular)', () => {
    const out = buildSiigoVoucher({
      src: RECEIPT,
      documentId: 7714,
      payment: { id: 5638, name: 'Bancolombia', dueDate: false },
      dueDate: '2026-09-30',
    });
    expect(out.problems).toEqual([]);
    expect(out.payload).toEqual({
      document: { id: 7714 },
      date: '2026-09-20',
      type: 'DebtPayment',
      customer: { identification: '209048401', branch_office: 0 },
      items: [
        { due: { prefix: 'FV-1', consecutive: 68, quote: 1, date: '2026-09-30' }, value: 119_000 },
      ],
      payment: { id: 5638, value: 119_000 },
      observations: 'Registrado desde Cortex · ref. banco TRF 8812',
    });
  });

  it('el egreso (RP) apunta a la compra FC-2-22', () => {
    const out = buildSiigoPaymentReceipt({
      src: SUPPLIER_PAYMENT,
      documentId: 27234,
      payment: { id: 5638, name: 'Bancolombia', dueDate: false },
      purchaseName: 'FC-2-22',
      dueDate: '2026-10-12',
    });
    expect(out.problems).toEqual([]);
    expect(out.payload).toMatchObject({
      document: { id: 27234 },
      type: 'DebtPayment',
      supplier: { identification: '900123456', branch_office: 0 },
      items: [
        {
          due: { prefix: 'FC-2', consecutive: 22, quote: 1, date: '2026-10-12' },
          value: 1_126_840,
        },
      ],
      payment: { id: 5638, value: 1_126_840 },
    });
    expect(
      buildSiigoPaymentReceipt({
        ...{
          src: SUPPLIER_PAYMENT,
          documentId: 1,
          payment: null,
          purchaseName: null,
          dueDate: 'x',
        },
      }).problems.join(' '),
    ).toMatch(/número de la compra/);
  });

  it('las piezas: nombres de Siigo, número del proveedor, impuestos por tarifa, forma de pago del banco', () => {
    expect(parseSiigoName('FV-1-68')).toEqual({ prefix: 'FV-1', consecutive: 68 });
    expect(parseSiigoName('68')).toBeNull();
    expect(splitSupplierNumber('fepa 0451')).toEqual(['FEPA', '451']);
    expect(splitSupplierNumber('12345')).toEqual(['', '12345']);
    expect(findSiigoTax(SIIGO_CATALOG.taxes, 'iva', 19)?.id).toBe(13156);
    expect(findSiigoTax(SIIGO_CATALOG.taxes, 'reteica', 0.966)?.id).toBe(13159);
    expect(findSiigoTax(SIIGO_CATALOG.taxes, 'iva', 5)).toBeNull();
    const types = [
      { id: 1, name: 'Crédito', dueDate: true },
      { id: 2, name: 'Bancolombia', dueDate: false },
      { id: 3, name: 'Davivienda', dueDate: false },
    ];
    expect(pickSiigoBankPayment(types, undefined, 'Bancolombia corriente').type?.id).toBe(2);
    expect(pickSiigoBankPayment(types, '3', null).type?.id).toBe(3);
    expect(pickSiigoBankPayment(types, undefined, null).problem).toMatch(/hay 2/);
  });
});

describe('Alegra (post_bills, post_payments)', () => {
  const catalog = {
    taxes: [{ id: '1', type: 'IVA', percentage: 19 }],
    retentions: [
      { id: '2', type: 'RETEFUENTE Compras', percentage: 2.5 },
      { id: '3', type: 'RETEIVA ReteIVA', percentage: 15 },
      { id: '4', type: 'RETEICA ICA Bogotá', percentage: 0.966 },
    ],
    categories: [
      { id: '5091', code: '51959501', name: 'Otros gastos' },
      { id: '5092', code: '51959502', name: 'Otros gastos 2' },
    ],
    bankAccounts: [],
  };

  it('la factura de proveedor: numberTemplate.number y categorías (cuentas) con impuesto', () => {
    const map = new AccountMap([
      {
        scope: 'categoria',
        key: 'otros_gastos',
        account_code: '51959501',
        account_name: null,
        cost_center: '3',
        provider_refs: {},
      },
    ]);
    const out = buildAlegraBill({ src: PURCHASE, map, catalog, providerId: '1' });
    expect(out.problems).toEqual([]);
    expect(out.payload).toEqual({
      date: '2026-09-12',
      dueDate: '2026-10-12',
      provider: { id: '1' },
      numberTemplate: { number: 'FEPA-451' },
      observations: expect.stringContaining('Causada desde Cortex'),
      purchases: {
        categories: [
          {
            id: '5091',
            price: 600_000,
            quantity: 1,
            observations: 'Resmas carta',
            tax: [{ id: '1' }],
          },
          { id: '5091', price: 400_000, quantity: 1, observations: 'Tóner', tax: [{ id: '1' }] },
        ],
      },
      retentions: [
        { id: '2', amount: 25_000 },
        { id: '3', amount: 28_500 },
        { id: '4', amount: 9_660 },
      ],
      costCenter: { id: 3 },
    });
  });

  it('sin proveedor en Alegra ni cuenta encontrable, dice qué hacer', () => {
    const out = buildAlegraBill({
      src: PURCHASE,
      map: new AccountMap([]),
      catalog,
      providerId: null,
    });
    // 519595 (defecto) tiene dos auxiliares en Alegra: no se adivina.
    expect(out.problems.join(' ')).toMatch(/no está como proveedor en Alegra/);
    expect(out.problems.join(' ')).toMatch(/No encontré en Alegra la cuenta 519595/);
  });

  it('el pago recibido va contra invoices y el pago al proveedor contra bills, los dos con client', () => {
    expect(
      buildAlegraPayment({ src: RECEIPT, contactId: '20', bankAccountId: '1' }).payload,
    ).toEqual({
      date: '2026-09-20',
      bankAccount: { id: '1' },
      paymentMethod: 'transfer',
      client: { id: '20' },
      invoices: [{ id: 'inv-ext-68', amount: 119_000 }],
      observations: 'Registrado desde Cortex · ref. banco TRF 8812',
    });
    expect(
      buildAlegraPayment({ src: SUPPLIER_PAYMENT, contactId: '7', bankAccountId: '1' }).payload,
    ).toMatchObject({
      client: { id: '7' },
      bills: [{ id: 'purch-ext-1', amount: 1_126_840 }],
    });
    expect(
      pickAlegraBank(
        [
          { id: '1', name: 'Bancolombia' },
          { id: '2', name: 'Caja' },
        ],
        undefined,
        'Bancolombia corriente',
      ).id,
    ).toBe('1');
  });
});

describe('QuickBooks (bill, payment, billpayment)', () => {
  const lookup = (acc: { code: string; refs: { quickbooks?: string } }) =>
    acc.refs.quickbooks ??
    (
      {
        '519595': '7',
        '240810': '8',
        '236525': '9',
        '236705': '10',
        '236801': '11',
        '220505': '33',
        '111005': '35',
      } as Record<string, string>
    )[acc.code] ??
    null;

  it('el Bill lleva el gasto, el IVA y las retenciones en negativo: su total es lo que se paga', () => {
    const out = buildQuickbooksBill({
      src: { ...PURCHASE, lines: [] },
      map: new AccountMap([]),
      vendorId: '56',
      accountId: lookup,
    });
    expect(out.problems).toEqual([]);
    const lines = out.payload.Line as Array<{
      Amount: number;
      AccountBasedExpenseLineDetail: { AccountRef: { value: string } };
    }>;
    expect(lines.map((l) => [l.AccountBasedExpenseLineDetail.AccountRef.value, l.Amount])).toEqual([
      ['7', 1_000_000],
      ['8', 190_000],
      ['9', -25_000],
      ['10', -28_500],
      ['11', -9_660],
    ]);
    expect(lines.reduce((s, l) => s + l.Amount, 0)).toBe(1_126_840);
    expect(out.payload).toMatchObject({
      VendorRef: { value: '56' },
      APAccountRef: { value: '33' },
      DocNumber: 'FEPA-451',
      TxnDate: '2026-09-12',
      DueDate: '2026-10-12',
      GlobalTaxCalculation: 'NotApplicable',
    });
  });

  it('Payment y BillPayment enlazan la factura con LinkedTxn', () => {
    expect(
      buildQuickbooksPayment({ src: RECEIPT, customerId: '20', bankId: '4' }).payload,
    ).toMatchObject({
      CustomerRef: { value: '20' },
      TotalAmt: 119_000,
      DepositToAccountRef: { value: '4' },
      PaymentRefNum: 'TRF 8812',
      Line: [{ Amount: 119_000, LinkedTxn: [{ TxnId: 'inv-ext-68', TxnType: 'Invoice' }] }],
    });
    expect(
      buildQuickbooksBillPayment({ src: SUPPLIER_PAYMENT, vendorId: '56', bankId: '35' }).payload,
    ).toMatchObject({
      VendorRef: { value: '56' },
      PayType: 'Check',
      CheckPayment: { BankAccountRef: { value: '35' } },
      Line: [{ Amount: 1_126_840, LinkedTxn: [{ TxnId: 'purch-ext-1', TxnType: 'Bill' }] }],
    });
    expect(
      buildQuickbooksBillPayment({ src: SUPPLIER_PAYMENT, vendorId: null, bankId: null }).problems,
    ).toHaveLength(2);
    expect(qbQuote("Adam's Shop")).toBe("'Adam\\'s Shop'");
  });
});
