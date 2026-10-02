import { describe, expect, it } from 'vitest';
import { createPaymentsWorld } from '../../__tests__/fake-db';
import { applyPaymentToInvoice } from '../../store';
import {
  BANK_SYSTEM_PREFIX,
  bankReconciliation,
  bankSystemName,
  importBankStatement,
  previewBankStatement,
} from '../store';

/**
 * El extracto contra la base de datos: lo que se promete al dueño es que
 * reimportar nunca duplica, que sólo lo inequívoco se ata solo, y que atar a
 * mano es un clic que no puede cruzar monedas ni re-atribuir en silencio.
 */

const ORG = 'org-andina';
const USER = '11111111-1111-4111-8111-111111111111';

function world() {
  return createPaymentsWorld(
    {
      clients: [
        { id: 'cli-coltrans', organization_id: ORG, name: 'Coltrans S.A.S.', tax_id: '900123456' },
        {
          id: 'cli-andina',
          organization_id: ORG,
          name: 'Distribuidora Andina Ltda',
          tax_id: '800555111',
        },
      ],
      document_extractions: [
        {
          id: 'ext-1043',
          organization_id: ORG,
          doc_type: 'invoice',
          financial_role: 'receivable',
          review_state: 'confirmed',
          doc_number: 'FV-1043',
          client_id: 'cli-coltrans',
          client_match_state: 'matched',
          counterparty_name: 'Coltrans S.A.S.',
          counterparty_nit: '900123456',
          total_amount: 4_200_000,
          currency: 'COP',
          issued_on: '2026-08-10',
          due_on: '2026-09-09',
        },
        {
          id: 'ext-usd',
          organization_id: ORG,
          doc_type: 'invoice',
          financial_role: 'receivable',
          review_state: 'confirmed',
          doc_number: 'EXP-7',
          client_id: null,
          counterparty_name: 'Import Co',
          counterparty_nit: null,
          total_amount: 1000,
          currency: 'USD',
          issued_on: '2026-08-01',
          due_on: '2026-09-01',
        },
      ],
      payments: [],
      payment_reports: [],
      accounting_invoices: [
        {
          id: 'acc-22',
          organization_id: ORG,
          source_system: 'siigo',
          source_ref: 'i-22',
          doc_number: 'FV-2-22',
          client_id: 'cli-andina',
          client_nit: '800555111',
          counterparty_name: 'Distribuidora Andina Ltda',
          currency: 'COP',
          total: 2_000_000,
          balance: 2_000_000,
          issued_on: '2026-08-15',
          due_on: '2026-09-14',
          annulled: false,
        },
      ],
      receivable_notices: [],
      audit_events: [],
    },
    ORG,
  );
}

const CSV = [
  'BANCOLOMBIA',
  'FECHA;DESCRIPCIÓN;SUCURSAL;DCTO.;VALOR;SALDO',
  '01/09/2026;PAGO PSE COLTRANS FV-1043;VIRTUAL;;4.200.000,00;10.200.000,00',
  '02/09/2026;PAGO A PROVEEDOR;VIRTUAL;;-1.500.000,00;8.700.000,00',
  '03/09/2026;TRANSF DISTRIBUIDORA ANDINA;VIRTUAL;;1.920.000,00;10.620.000,00',
  '04/09/2026;CONSIGNACION EFECTIVO;CENTRO;;77.000,00;10.697.000,00',
].join('\n');

function input(csv = CSV) {
  return {
    bytes: Buffer.from(csv, 'utf8'),
    fileName: 'extracto.csv',
    mime: 'text/csv',
    accountLabel: 'Bancolombia Corriente 1234',
    currency: 'COP',
  };
}

describe('nombre de la cuenta', () => {
  it('es la fuente, normalizado, y exige nombre', () => {
    expect(bankSystemName('  Bancolombia   Corriente 1234 ')).toBe(
      `${BANK_SYSTEM_PREFIX}bancolombia corriente 1234`,
    );
    expect(() => bankSystemName('  ')).toThrow(/nombre a la cuenta/);
  });
});

describe('vista previa', () => {
  it('cuenta, empareja y no escribe nada', async () => {
    const w = world();
    const p = await previewBankStatement(w.db, input());
    expect(p.status).toBe('ready');
    if (p.status !== 'ready') return;
    expect(p.bank.id).toBe('bancolombia');
    expect(p.credits).toBe(3);
    expect(p.creditsTotal).toBe(6_197_000);
    expect(p.debitsIgnored).toBe(1);
    expect(p.duplicates).toBe(0);
    expect(p.matched).toBe(1);
    expect(p.suggested).toBe(1);
    expect(p.unmatched).toBe(1);
    const andina = p.lines.find((l) => l.amount === 1_920_000);
    expect(andina?.suggestions[0]?.docNumber).toBe('FV-2-22');
    expect(andina?.suggestions[0]?.reasons.join(' ')).toMatch(/retenciones/);
    expect(w.tables.payment_reports).toHaveLength(0);
    expect(w.tables.payments).toHaveLength(0);
  });

  it('la moneda es obligatoria', async () => {
    const w = world();
    await expect(previewBankStatement(w.db, { ...input(), currency: '' })).rejects.toThrow();
  });
});

describe('importar', () => {
  it('ata solo lo inequívoco y deja lo demás sin factura', async () => {
    const w = world();
    const r = await importBankStatement(w.db, { ...input(), createdBy: USER });
    expect(r.status).toBe('imported');
    if (r.status !== 'imported') return;
    expect(r.created).toBe(3);
    expect(r.autoMatched).toBe(1);
    expect(r.sentence).toMatch(/entraron 3 abono/);

    const reports = w.tables.payment_reports ?? [];
    expect(reports).toHaveLength(3);
    expect(reports.every((x) => x.source_kind === 'system')).toBe(true);
    expect(
      reports.every((x) => x.source_system === `${BANK_SYSTEM_PREFIX}bancolombia corriente 1234`),
    ).toBe(true);

    const pays = w.tables.payments ?? [];
    const coltrans = pays.find((x) => Number(x.amount) === 4_200_000);
    expect(coltrans).toMatchObject({
      extraction_id: 'ext-1043',
      invoice_number: 'FV-1043',
      client_id: 'cli-coltrans',
    });
    const andina = pays.find((x) => Number(x.amount) === 1_920_000);
    expect(andina?.extraction_id).toBeNull();
    expect(andina?.invoice_number).toBeNull();
  });

  it('reimportar el mismo archivo no duplica nada', async () => {
    const w = world();
    await importBankStatement(w.db, { ...input(), createdBy: USER });
    const again = await importBankStatement(w.db, { ...input(), createdBy: USER });
    expect(again.status).toBe('imported');
    if (again.status !== 'imported') return;
    expect(again.created).toBe(0);
    expect(again.duplicates).toBe(3);
    expect(again.sentence).toMatch(/no entró ningún abono nuevo/);
    expect(w.tables.payment_reports).toHaveLength(3);
    expect(w.tables.payments).toHaveLength(3);

    const preview = await previewBankStatement(w.db, input());
    if (preview.status !== 'ready') throw new Error('ready');
    expect(preview.duplicates).toBe(3);
    expect(preview.newCredits).toBe(0);
  });

  it('un periodo que se solapa sólo trae lo nuevo', async () => {
    const w = world();
    await importBankStatement(w.db, { ...input(), createdBy: USER });
    const next = [
      'FECHA;DESCRIPCIÓN;SUCURSAL;DCTO.;VALOR;SALDO',
      '04/09/2026;CONSIGNACION EFECTIVO;CENTRO;;77.000,00;10.697.000,00',
      '05/09/2026;ABONO CLIENTE NUEVO;VIRTUAL;;500.000,00;11.197.000,00',
    ].join('\n');
    const r = await importBankStatement(w.db, { ...input(next), createdBy: USER });
    if (r.status !== 'imported') throw new Error('imported');
    expect(r.created).toBe(1);
    expect(r.duplicates).toBe(1);
    expect(w.tables.payment_reports).toHaveLength(4);
  });

  it('otra cuenta es otra fuente: el mismo movimiento no se confunde', async () => {
    const w = world();
    await importBankStatement(w.db, { ...input(), createdBy: USER });
    const other = await importBankStatement(w.db, {
      ...input(),
      accountLabel: 'Davivienda ahorros',
      createdBy: USER,
    });
    if (other.status !== 'imported') throw new Error('imported');
    expect(other.duplicates).toBe(0);
  });

  it('un formato desconocido no escribe nada y devuelve los encabezados', async () => {
    const w = world();
    const r = await importBankStatement(w.db, {
      ...input('Día;Glosa;Plata\n01/09/2026;ABONO;100'),
      createdBy: USER,
    });
    expect(r.status).toBe('needs_mapping');
    expect(w.tables.payment_reports).toHaveLength(0);
  });
});

describe('conciliar', () => {
  it('lista atados, por revisar y sin factura, y un clic ata', async () => {
    const w = world();
    await importBankStatement(w.db, { ...input(), createdBy: USER });
    const recon = await bankReconciliation(w.db);
    expect(recon.accounts).toEqual(['bancolombia corriente 1234']);
    expect(recon.matched.map((i) => i.invoiceNumber)).toEqual(['FV-1043']);
    expect(recon.suggested).toHaveLength(1);
    expect(recon.unmatched).toHaveLength(1);
    expect(recon.unmatched[0]?.amount).toBe(77_000);
    // La factura ya pagada no se ofrece; la de USD sí, para escoger a mano.
    expect(recon.openInvoices.map((i) => i.docNumber).sort()).toEqual(['EXP-7', 'FV-2-22']);

    const item = recon.suggested[0];
    const pick = item?.suggestions[0];
    if (!item || !pick) throw new Error('suggestion');
    expect(pick).toMatchObject({ kind: 'accounting', id: 'acc-22' });
    const paid = await applyPaymentToInvoice(w.db, {
      paymentId: item.paymentId,
      userId: USER,
      invoice: { kind: pick.kind, id: pick.id },
    });
    expect(paid).toMatchObject({
      invoice_number: 'FV-2-22',
      extraction_id: null,
      client_id: 'cli-andina',
      client_match_state: 'matched',
      amount: 1_920_000,
    });

    const after = await bankReconciliation(w.db);
    expect(after.matched).toHaveLength(2);
    expect(after.suggested).toHaveLength(0);
    // Lo cubierto desde el banco se descuenta para sugerir: queda lo que
    // faltó (las retenciones), no la factura entera otra vez.
    expect(after.openInvoices.find((i) => i.docNumber === 'FV-2-22')?.balance).toBe(80_000);
  });

  it('no re-atribuye, no cruza monedas y exige a la persona', async () => {
    const w = world();
    await importBankStatement(w.db, { ...input(), createdBy: USER });
    const recon = await bankReconciliation(w.db);
    const matched = recon.matched[0];
    const loose = recon.unmatched[0];
    if (!matched || !loose) throw new Error('items');

    await expect(
      applyPaymentToInvoice(w.db, {
        paymentId: matched.paymentId,
        userId: USER,
        invoice: { kind: 'accounting', id: 'acc-22' },
      }),
    ).rejects.toThrow(/ya está atribuido/);
    await expect(
      applyPaymentToInvoice(w.db, {
        paymentId: loose.paymentId,
        userId: USER,
        invoice: { kind: 'document', id: 'ext-usd' },
      }),
    ).rejects.toThrow(/monedas no se cruzan/);
    await expect(
      applyPaymentToInvoice(w.db, {
        paymentId: loose.paymentId,
        userId: '',
        invoice: { kind: 'accounting', id: 'acc-22' },
      }),
    ).rejects.toThrow(/nombre de quien/);
  });

  it('nada importado, nada que conciliar', async () => {
    const recon = await bankReconciliation(world().db);
    expect(recon.matched).toHaveLength(0);
    expect(recon.suggested).toHaveLength(0);
    expect(recon.unmatched).toHaveLength(0);
    expect(recon.accounts).toEqual([]);
  });
});
