import {
  type CarteraInvoiceIn,
  type CarteraModel,
  type CarteraPaymentIn,
  buildCartera,
} from '@cortex/agent-tools/src/payments/cartera';

/**
 * LA SEMILLA DE LA PANTALLA DE CARTERA, con la forma de lo que trae Siigo de
 * verdad (GROUNDFLEX, 2026-10-21): un cliente con más de cien facturas cuyo
 * «vence» es el día de expedición, anticipos con la línea `due` apuntando al
 * propio recibo (unos ya cruzados en la contabilidad, otros no), un abono
 * parcial a una factura, notas crédito, y unas pocas facturas con plazo de
 * verdad. Se pasa por `buildCartera`, el mismo motor de la pantalla, sin base
 * de datos: sirve para mirar la pantalla en claro/oscuro y en teléfono.
 */

export const TODAY = '2026-10-21';

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const CHARTER = { key: 'cl-charter', name: 'CHARTER LINE AIR SOARA SAS' };
const BEYOND = { key: 'cl-beyond', name: 'BEYOND BORDER INTERNATIONAL COURIER S A S' };
const TRANEX = { key: 'cl-tranexco', name: 'TRANEXCO S.A.S' };
const AERO = { key: 'cl-aero', name: 'AEROREGIONAL SKY SAS' };
const ASESORIA = { key: 'cl-mpl', name: 'ASESORIA Y GESTION MPL GLOBAL SPA' };
const COLOCAR = { key: 'cl-colocar', name: 'COLOCAR CARGO LOGISTICS S.A.S.' };

export function fixtureModel(
  opts: { plazo?: number | null; empty?: boolean; cuadre?: boolean } = {},
): CarteraModel {
  if (opts.empty) return buildCartera({ today: TODAY, invoices: [], payments: [] });
  const rand = rng(42);
  const invoices: CarteraInvoiceIn[] = [];
  let n = 1;
  const add = (
    c: { key: string; name: string },
    issuedOn: string,
    total: number,
    over: Partial<CarteraInvoiceIn> = {},
  ) => {
    const id = n++;
    invoices.push({
      id: `inv-${id}`,
      kind: 'accounting',
      docNumber: `FV-2-${id}`,
      clientKey: c.key,
      clientId: c.key,
      clientName: c.name,
      currency: 'COP',
      total,
      balance: total,
      issuedOn,
      dueOn: issuedOn, // Siigo: vence el mismo día que se expide
      einvoice: 'Aceptada',
      url: 'https://documentview.siigo.com/document',
      ...over,
    });
  };

  // Charter: una factura por vuelo, de agosto a hoy. Las más viejas ya se pagaron
  // con anticipos cruzados (saldo 0); las demás siguen abiertas.
  for (let d = -62; d <= -1; d++) {
    const per = d % 3 === 0 ? 3 : 2;
    for (let k = 0; k < per; k++) {
      const total = Math.round((2_000_000 + rand() * 24_000_000) / 1000) * 1000;
      const issued = addDays(TODAY, d);
      const paid = d < -35;
      add(CHARTER, issued, total, { balance: paid ? 0 : total });
    }
  }
  // Un abono parcial.
  const partial = invoices.find((i) => i.clientKey === CHARTER.key && i.balance > 0);
  if (partial) {
    partial.docNumber = 'FV-2-79';
    partial.balance = partial.total - 465_963;
  }
  // Facturas de otros clientes: algunas con plazo de verdad.
  for (let i = 0; i < 12; i++) {
    add(TRANEX, addDays(TODAY, -(i % 14) - 3), 129_148 + Math.round(rand() * 900_000));
  }
  for (let i = 0; i < 8; i++) {
    const issued = addDays('2026-08-11', i * 2);
    add(ASESORIA, issued, Math.round((1_500_000 + rand() * 3_000_000) / 100) * 100, {
      dueOn: addDays(issued, 30),
      einvoice: i === 3 ? 'Pendiente' : 'Aceptada',
    });
  }
  add(AERO, '2026-10-06', 18_927_299, { dueOn: '2026-10-21' });
  add(AERO, '2026-10-06', 15_000_000, { dueOn: '2026-10-21' });
  for (let i = 0; i < 6; i++)
    add(BEYOND, addDays(TODAY, -8 + i), 425_000, { einvoice: i === 2 ? 'Rechazada' : 'Aceptada' });
  add(COLOCAR, '2026-10-08', 528_775, { dueOn: '2026-11-07' });
  add(COLOCAR, '2026-10-12', 528_775, { dueOn: '2026-11-11' });
  // Meses anteriores ya cobrados (para el gráfico de 12 meses).
  for (const [month, total] of [
    ['2026-05-10', 96_000_000],
    ['2026-06-12', 142_000_000],
    ['2026-07-09', 220_000_000],
  ] as const)
    add(CHARTER, month, total, { balance: 0, dueOn: month });

  const payments: CarteraPaymentIn[] = [];
  const anticipo = (
    c: { key: string; name: string },
    num: string,
    paidOn: string,
    amount: number,
  ) =>
    payments.push({
      id: `pay-${num}`,
      kind: 'payment',
      amount,
      currency: 'COP',
      paidOn,
      clientKey: c.key,
      clientName: c.name,
      invoiceNumber: num, // Siigo manda el propio recibo como «factura»
      reference: num,
    });
  anticipo(CHARTER, 'RC-1-1', '2026-07-07', 20_000_000);
  anticipo(CHARTER, 'RC-1-2', '2026-07-17', 50_000_000);
  anticipo(CHARTER, 'RC-1-3', '2026-07-23', 25_000_000);
  anticipo(CHARTER, 'RC-1-4', '2026-07-30', 20_000_000);
  anticipo(CHARTER, 'RC-1-5', '2026-08-06', 40_000_000);
  anticipo(CHARTER, 'RC-1-6', '2026-08-14', 70_000_000);
  anticipo(CHARTER, 'RC-1-7', '2026-08-19', 70_000_000);
  anticipo(CHARTER, 'RC-1-8', '2026-08-28', 110_000_000);
  anticipo(BEYOND, 'RC-1-10', '2026-09-14', 200_000_000);
  anticipo(CHARTER, 'RC-1-11', '2026-09-14', 120_000_000);
  anticipo(BEYOND, 'RC-1-12', '2026-09-30', 30_000_000);
  payments.push({
    id: 'pay-abono',
    kind: 'payment',
    amount: 465_963,
    currency: 'COP',
    paidOn: '2026-10-02',
    clientKey: CHARTER.key,
    clientName: CHARTER.name,
    invoiceNumber: 'FV-2-79',
    reference: 'RC-1-13',
  });
  payments.push({
    id: 'pay-suelto',
    kind: 'payment',
    amount: 1_200_000,
    currency: 'COP',
    paidOn: '2026-10-15',
    clientKey: TRANEX.key,
    clientName: TRANEX.name,
    invoiceNumber: null,
    reference: 'TRANSF-8841',
  });

  return buildCartera({
    today: TODAY,
    invoices,
    payments,
    creditNotes: [
      {
        number: 'NC-1-2',
        invoiceNumber: 'FV-2-165',
        amount: 13_948_581,
        date: '2026-09-23',
        clientKey: CHARTER.key,
        clientName: CHARTER.name,
      },
      {
        number: 'NC-1-3',
        invoiceNumber: 'FV-2-248',
        amount: 23_272_905,
        date: '2026-10-06',
        clientKey: AERO.key,
        clientName: AERO.name,
      },
      {
        number: 'NC-1-10',
        invoiceNumber: 'FV-2-281',
        amount: 440_003,
        date: '2026-10-08',
        clientKey: TRANEX.key,
        clientName: TRANEX.name,
      },
    ],
    advanceReceipts: payments
      .filter((p) => p.reference?.startsWith('RC-1-') && p.invoiceNumber === p.reference)
      .map((p) => p.reference as string),
    defaultTermDays: opts.plazo ?? null,
    ledger: {
      advanceCrossedByClient: { [CHARTER.key]: 525_000_000 },
      receivableCredits: [
        { date: '2026-09-30', amount: 120_000_000 },
        { date: '2026-10-05', amount: 60_000_000 },
        { date: '2026-09-14', amount: 80_000_000 },
      ],
      ...(opts.cuadre
        ? {
            balance1305ByClient: { [CHARTER.key]: 1_300_000_000, [TRANEX.key]: 2_000_000 },
            balancePeriod: '2026-10',
          }
        : {}),
    },
  });
}
