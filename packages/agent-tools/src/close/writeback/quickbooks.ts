import type { QuickBooksClient } from '../../accounting/providers/quickbooks-client';
import type { AccountMap, ResolvedAccount } from './mapping';
import {
  type EntryLine,
  type ProviderWriter,
  type PurchaseSource,
  type ReceiptSource,
  type SupplierPaymentSource,
  type WritebackSource,
  type WrittenDocument,
  round2,
} from './shape';

/**
 * ESCRIBIR EN QUICKBOOKS ONLINE (migración 0192). Verificado contra la
 * referencia oficial (developer.intuit.com › all-entities › bill, payment,
 * billpayment, vendor; y el artículo de `requestid`):
 *
 *   compra          POST /bill         VendorRef (el proveedor por DisplayName),
 *                   APAccountRef (proveedores), Line[] con
 *                   AccountBasedExpenseLineDetail{AccountRef}.
 *   recibo          POST /payment      CustomerRef (el de la factura),
 *                   DepositToAccountRef (el banco), Line[{Amount,
 *                   LinkedTxn[{TxnId, TxnType:"Invoice"}]}].
 *   pago_proveedor  POST /billpayment  VendorRef, PayType "Check" con
 *                   CheckPayment.BankAccountRef, Line[{Amount,
 *                   LinkedTxn[{TxnId, TxnType:"Bill"}]}].
 *
 * Idempotencia: `?requestid=` (hasta 50 caracteres; Intuit devuelve la
 * respuesta original si llega dos veces). Por eso aquí no hay `find`.
 *
 * QuickBooks no sabe del IVA ni de las retenciones colombianas como
 * impuestos: la factura va con `GlobalTaxCalculation: NotApplicable`, el IVA
 * descontable como una línea a su cuenta de activo y cada retención como una
 * línea NEGATIVA a su cuenta por pagar, de modo que el saldo del Bill es lo que
 * de verdad se le paga al proveedor. Validar en el sandbox que la empresa
 * acepta líneas negativas (ver el informe del módulo).
 */

type Loose = Record<string, unknown>;

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/** Una cadena para la consulta de QuickBooks: el apóstrofo se escapa con barra. */
export function qbQuote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/** El id de QuickBooks de una cuenta de Cortex, o null. */
export type QbAccountLookup = (acc: ResolvedAccount) => string | null;

function line(
  accountId: string | null,
  amount: number,
  description: string,
  classRef?: string | null,
) {
  return {
    DetailType: 'AccountBasedExpenseLineDetail',
    Amount: round2(amount),
    Description: description.slice(0, 4000),
    AccountBasedExpenseLineDetail: {
      AccountRef: { value: accountId ?? '' },
      ...(classRef ? { ClassRef: { value: classRef } } : {}),
    },
  };
}

export function buildQuickbooksBill(input: {
  src: PurchaseSource;
  map: AccountMap;
  vendorId: string | null;
  accountId: QbAccountLookup;
}): { payload: Loose; problems: string[]; warnings: string[] } {
  const { src, map } = input;
  const problems: string[] = [];
  const warnings: string[] = [];
  if (!input.vendorId)
    problems.push(
      `${src.supplierName} no está como proveedor (Vendor) en QuickBooks con ese mismo nombre: créalo allá o corrige el nombre.`,
    );
  const need = (acc: ResolvedAccount): string | null => {
    const id = input.accountId(acc);
    if (!id)
      problems.push(
        `No encontré en QuickBooks la cuenta ${acc.code} (${acc.name}): pon su número (AcctNum) o su id en /cierre → Cuentas.`,
      );
    return id;
  };
  const expense = map.expense({ supplierId: src.supplierId, category: src.category });
  const expenseId = need(expense);
  const base = round2(src.subtotal + src.otherTaxes);
  const lineSum = round2(src.lines.reduce((s, l) => s + l.amount, 0));
  const useLines = src.lines.length > 0 && src.lines.length <= 50 && Math.abs(lineSum - base) <= 1;
  const lines: Loose[] = (
    useLines
      ? src.lines.map((l) => ({ d: l.description, a: l.amount }))
      : [{ d: `Factura ${src.docNumber} de ${src.supplierName}`, a: base }]
  ).map((l) => line(expenseId, l.a, l.d, expense.costCenter));
  if (src.iva > 0)
    lines.push(line(need(map.role('iva_descontable')), src.iva, `IVA ${src.docNumber}`));
  const w = src.withholdings;
  const negatives: Array<[number, ResolvedAccount, string]> = [
    [w.retefuente, map.role(map.withholdingRole(src.category)), 'Retención en la fuente'],
    [w.reteiva, map.role('reteiva'), 'ReteIVA'],
    [w.reteica, map.role('reteica'), 'ReteICA'],
  ];
  for (const [amount, acc, label] of negatives)
    if (amount > 0) lines.push(line(need(acc), -amount, `${label} ${src.docNumber}`));
  if (negatives.some(([a]) => a > 0))
    warnings.push(
      'Las retenciones van como líneas negativas del Bill: QuickBooks deja la factura por lo que se paga.',
    );
  const ap = need(map.role('proveedores'));
  return {
    payload: {
      VendorRef: { value: input.vendorId ?? '' },
      TxnDate: src.issueDate,
      ...(src.dueDate ? { DueDate: src.dueDate } : {}),
      DocNumber: src.docNumber.slice(0, 21),
      APAccountRef: { value: ap ?? '' },
      GlobalTaxCalculation: 'NotApplicable',
      ...(src.currency ? { CurrencyRef: { value: src.currency } } : {}),
      PrivateNote: `Causada desde Cortex${src.cufe ? ` · CUFE ${src.cufe.slice(0, 40)}…` : ''}`,
      Line: lines,
    },
    problems: [...new Set(problems)],
    warnings,
  };
}

export function buildQuickbooksPayment(input: {
  src: ReceiptSource;
  customerId: string | null;
  bankId: string | null;
}): { payload: Loose; problems: string[] } {
  const { src } = input;
  const problems: string[] = [];
  if (!input.customerId)
    problems.push(`No encontré en QuickBooks la factura ${src.invoiceNumber}.`);
  if (!input.bankId)
    problems.push('No encontré en QuickBooks la cuenta de banco: ponla en /cierre → Cuentas.');
  return {
    payload: {
      CustomerRef: { value: input.customerId ?? '' },
      TotalAmt: round2(src.amount),
      TxnDate: src.date,
      ...(src.reference ? { PaymentRefNum: src.reference.slice(0, 21) } : {}),
      DepositToAccountRef: { value: input.bankId ?? '' },
      Line: [
        {
          Amount: round2(src.amount),
          LinkedTxn: [{ TxnId: src.invoiceExternalId, TxnType: 'Invoice' }],
        },
      ],
      PrivateNote: 'Registrado desde Cortex',
    },
    problems,
  };
}

export function buildQuickbooksBillPayment(input: {
  src: SupplierPaymentSource;
  vendorId: string | null;
  bankId: string | null;
}): { payload: Loose; problems: string[] } {
  const { src } = input;
  const problems: string[] = [];
  if (!input.vendorId) problems.push(`No encontré en QuickBooks el Bill de ${src.supplierName}.`);
  if (!input.bankId)
    problems.push('No encontré en QuickBooks la cuenta de banco: ponla en /cierre → Cuentas.');
  return {
    payload: {
      VendorRef: { value: input.vendorId ?? '' },
      PayType: 'Check',
      CheckPayment: { BankAccountRef: { value: input.bankId ?? '' } },
      TotalAmt: round2(src.amount),
      TxnDate: src.date,
      Line: [
        {
          Amount: round2(src.amount),
          LinkedTxn: [{ TxnId: src.purchaseExternalId, TxnType: 'Bill' }],
        },
      ],
      PrivateNote: `Registrado desde Cortex${src.reference ? ` · ref. banco ${src.reference}` : ''}`,
    },
    problems,
  };
}

// ---------------------------------------------------------------------------
// La sesión
// ---------------------------------------------------------------------------

const ENTITY: Record<WritebackSource['kind'], { path: string; key: string; noun: string }> = {
  compra: { path: '/bill', key: 'Bill', noun: 'la factura de proveedor (Bill)' },
  recibo: { path: '/payment', key: 'Payment', noun: 'el pago recibido (Payment)' },
  pago_proveedor: {
    path: '/billpayment',
    key: 'BillPayment',
    noun: 'el pago al proveedor (BillPayment)',
  },
};

export function quickbooksWriter(ready: () => QuickBooksClient): ProviderWriter {
  const accountsByNumber = async (): Promise<Map<string, string>> => {
    const rows = await ready().query<{ Id: string; AcctNum?: string }>(
      'Account',
      'SELECT Id, AcctNum FROM Account WHERE Active = true MAXRESULTS 1000',
    );
    return new Map(rows.filter((r) => r.AcctNum).map((r) => [String(r.AcctNum), String(r.Id)]));
  };
  const lookup =
    (byNumber: Map<string, string>): QbAccountLookup =>
    (acc) =>
      acc.refs.quickbooks ?? byNumber.get(acc.code) ?? null;

  return {
    provider: 'quickbooks',
    supports: { compra: true, recibo: true, pago_proveedor: true },
    async prepare(src, _entries: EntryLine[], map) {
      const byNumber = await accountsByNumber();
      const accountId = lookup(byNumber);
      if (src.kind === 'compra') {
        const [vendor] = await ready().query<{ Id: string }>(
          'Vendor',
          `SELECT Id FROM Vendor WHERE DisplayName = ${qbQuote(src.supplierName.slice(0, 500))}`,
        );
        return buildQuickbooksBill({
          src,
          map,
          vendorId: vendor ? String(vendor.Id) : null,
          accountId,
        });
      }
      const bankId = accountId(map.bank(src.bankAccount));
      if (src.kind === 'recibo') {
        const [inv] = await ready().query<{ CustomerRef?: { value?: string } }>(
          'Invoice',
          `SELECT * FROM Invoice WHERE Id = ${qbQuote(src.invoiceExternalId)}`,
        );
        const out = buildQuickbooksPayment({
          src,
          customerId: inv?.CustomerRef?.value ?? null,
          bankId,
        });
        return { ...out, warnings: [] };
      }
      const [bill] = await ready().query<{ VendorRef?: { value?: string } }>(
        'Bill',
        `SELECT * FROM Bill WHERE Id = ${qbQuote(src.purchaseExternalId)}`,
      );
      const out = buildQuickbooksBillPayment({
        src,
        vendorId: bill?.VendorRef?.value ?? null,
        bankId,
      });
      return { ...out, warnings: [] };
    },
    async send(src, payload, opts): Promise<WrittenDocument> {
      const e = ENTITY[src.kind];
      const out = await ready().post<Loose>(e.path, payload, {
        requestId: opts.idempotencyKey,
        noun: e.noun,
      });
      const doc = (out?.[e.key] ?? null) as Loose | null;
      return {
        id: str(doc?.Id),
        number: str(doc?.DocNumber) || str(doc?.PaymentRefNum) || null,
        status: doc?.Balance !== undefined ? `saldo ${str(doc.Balance)}` : null,
      };
    },
  };
}
