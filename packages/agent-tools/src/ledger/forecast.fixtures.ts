/**
 * UNA EMPRESA DE PRUEBA PARA LA PROYECCIÓN: Transportes del Valle S.A.S.
 *
 * Datos inventados pero con la forma de una pyme colombiana real: nómina
 * quincenal (15 y 30), PILA hacia el 10, arriendo el 5, EPM hacia el 20,
 * combustible cada lunes, IVA bimestral (que NO debe verse como mensual), un
 * contrato que paga cada mes y clientes que pagan distinto:
 *
 *   - Nexa Logística: paga ~12 días tarde, siempre (6 facturas).
 *   - Coltrans: paga a tiempo (5 facturas).
 *   - Distribuidora El Sol: paga 45–60 días tarde, una anulada y una perdida.
 *   - Agro Pacífico: una sola factura, 20 días tarde (poca historia).
 *   - Constructora Bolívar: nueva, sin historia.
 *
 * Hoy es el viernes 2 de octubre de 2026. Sólo para pruebas.
 */

import { dayOfMonth } from './forecast-shared';
import type { CashAccount, LedgerMovement } from './types';

export const AS_OF = '2026-10-02';

type Base = Pick<LedgerMovement, 'id' | 'direction' | 'kind' | 'status' | 'amount' | 'date'>;

export function mv(fields: Base & Partial<LedgerMovement>): LedgerMovement {
  return {
    currency: 'COP',
    description: fields.description ?? fields.id,
    source: { kind: 'manual', system: null, ref: fields.id },
    ...fields,
  };
}

/** Un gasto ya pagado (extracto del banco). */
export function paid(
  id: string,
  date: string,
  amount: number,
  extra: Partial<LedgerMovement> = {},
): LedgerMovement {
  return mv({
    id,
    direction: 'out',
    kind: 'expense',
    status: 'settled',
    amount,
    date,
    settledAt: date,
    ...extra,
  });
}

/** Una factura por cobrar. */
export function invoice(
  id: string,
  client: string,
  amount: number,
  date: string,
  dueDate: string,
  extra: Partial<LedgerMovement> = {},
): LedgerMovement {
  return mv({
    id,
    direction: 'in',
    kind: 'receivable',
    status: 'expected',
    amount,
    date,
    dueDate,
    counterpartyName: client,
    category: 'ventas',
    description: `Factura ${id}`,
    ...extra,
  });
}

/** Una factura por pagar. */
export function bill(
  id: string,
  supplier: string,
  amount: number,
  dueDate: string,
  extra: Partial<LedgerMovement> = {},
): LedgerMovement {
  return mv({
    id,
    direction: 'out',
    kind: 'payable',
    status: 'expected',
    amount,
    date: dueDate,
    dueDate,
    counterpartyName: supplier,
    description: `Factura proveedor ${id}`,
    ...extra,
  });
}

const MONTH_NAMES = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
];

function day(month1: number, d: number): string {
  return dayOfMonth(2026, month1, d);
}

/** Nueve meses de gastos que se repiten (enero–septiembre de 2026). */
export function expenseHistory(): LedgerMovement[] {
  const out: LedgerMovement[] = [];
  for (let m = 1; m <= 9; m++) {
    const name = MONTH_NAMES[m - 1];
    const salary = m >= 7 ? 9_400_000 : 9_000_000;
    out.push(
      paid(`nom-${m}-1`, day(m, 15), salary, {
        category: 'nomina',
        description: `Pago nómina quincena 1 ${name}`,
      }),
      paid(`nom-${m}-2`, day(m, 30), salary, {
        category: 'nomina',
        description: `Pago nómina quincena 2 ${name} 2026`,
      }),
      paid(`pila-${m}`, day(m, 9 + (m % 3)), 4_100_000 + (m % 3) * 100_000, {
        category: 'nomina',
        description: `Pago PILA aportes ${name}`,
      }),
      paid(`arr-${m}`, day(m, 4 + (m % 3)), 6_500_000, {
        category: 'arriendo',
        counterpartyName: 'Inmobiliaria Los Andes S.A.S.',
        counterpartyTaxId: '900.555.111-2',
        description: `Arriendo bodega ${name}`,
      }),
      paid(`epm-${m}`, day(m, 19 + (m % 2)), 780_000 + ((m * 37_000) % 170_000), {
        category: 'servicios_publicos',
        counterpartyName: 'EPM',
        description: `EPM energía y acueducto ${name}`,
      }),
    );
    // IVA bimestral: marzo, mayo, julio, septiembre. No es mensual.
    if (m % 2 === 1 && m >= 3) {
      out.push(
        paid(`iva-${m}`, day(m, 12), 10_000_000 + m * 100_000, {
          category: 'impuestos',
          counterpartyName: 'DIAN',
          description: `IVA bimestral ${name}`,
        }),
      );
    }
    // Software que se canceló en mayo: ya no se repite.
    if (m <= 5) {
      out.push(
        paid(`sw-${m}`, day(m, 3), 450_000, {
          category: 'software',
          counterpartyName: 'Siigo',
          description: `Suscripción Siigo ${name}`,
        }),
      );
    }
    // Compras sueltas a proveedores: irregulares, no se repiten.
    out.push(
      paid(`prov-${m}`, day(m, ((m * 7) % 27) + 1), 1_000_000 + m * 750_000, {
        category: 'proveedores',
        counterpartyName: `Repuestos ${m % 2 === 0 ? 'La 30' : 'El Cruce'}`,
        description: 'Compra repuestos',
      }),
    );
    // Un contrato mensual que entra hacia el 25 (llega por el extracto).
    out.push(
      mv({
        id: `exito-${m}`,
        direction: 'in',
        kind: 'income',
        status: 'settled',
        amount: 38_000_000,
        date: day(m, 24 + (m % 3)),
        settledAt: day(m, 24 + (m % 3)),
        counterpartyName: 'Almacenes Éxito S.A.',
        counterpartyTaxId: '890900608-9',
        category: 'ventas',
        description: `Recaudo contrato transporte ${name}`,
      }),
    );
  }
  // Combustible cada lunes desde julio.
  for (let d = '2026-07-06'; d <= '2026-09-28'; ) {
    out.push(
      paid(`gas-${d}`, d, 1_200_000 + (Number(d.slice(8, 10)) % 3) * 50_000, {
        category: 'transporte',
        counterpartyName: 'Terpel',
        description: 'Combustible flota',
      }),
    );
    const next = new Date(`${d}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 7);
    d = next.toISOString().slice(0, 10);
  }
  return out;
}

function settledInvoice(
  id: string,
  client: string,
  taxId: string | null,
  amount: number,
  issued: string,
  due: string,
  paidOn: string,
): LedgerMovement {
  return invoice(id, client, amount, issued, due, {
    status: 'settled',
    settledAt: paidOn,
    counterpartyTaxId: taxId,
  });
}

/** Cómo han pagado los clientes. */
export function receivableHistory(): LedgerMovement[] {
  const nexa = 'Nexa Logística S.A.S.';
  const nexaNit = '901234567-1';
  const nexaDelays = [10, 12, 14, 11, 13, 12];
  const out: LedgerMovement[] = nexaDelays.map((delay, i) => {
    const m = i + 3; // marzo … agosto
    const issued = day(m, 1);
    const due = day(m, 30);
    const paidOn = new Date(`${due}T00:00:00Z`);
    paidOn.setUTCDate(paidOn.getUTCDate() + delay);
    return settledInvoice(
      `nexa-${m}`,
      nexa,
      // La mitad de las fuentes traen el NIT; la otra mitad sólo el nombre.
      i % 2 === 0 ? nexaNit : null,
      15_000_000,
      issued,
      due,
      paidOn.toISOString().slice(0, 10),
    );
  });
  // Coltrans paga a tiempo (una vez, dos días antes).
  const coltrans: Array<[string, string, string]> = [
    ['2026-04-01', '2026-05-01', '2026-05-01'],
    ['2026-05-01', '2026-05-31', '2026-05-29'],
    ['2026-06-01', '2026-07-01', '2026-07-02'],
    ['2026-07-01', '2026-07-31', '2026-07-31'],
    ['2026-08-01', '2026-08-31', '2026-08-31'],
  ];
  coltrans.forEach(([issued, due, paidOn], i) => {
    out.push(
      settledInvoice(
        `colt-${i}`,
        'Coltrans S.A.S.',
        '800111222-3',
        12_000_000,
        issued,
        due,
        paidOn,
      ),
    );
  });
  // El Sol: tarde, con una anulada y una que nunca pagó.
  out.push(
    settledInvoice(
      'sol-1',
      'Distribuidora El Sol Ltda',
      null,
      6_000_000,
      '2026-01-10',
      '2026-02-09',
      '2026-03-26',
    ),
    settledInvoice(
      'sol-2',
      'Distribuidora El Sol Ltda',
      null,
      6_000_000,
      '2026-02-10',
      '2026-03-12',
      '2026-05-11',
    ),
    invoice('sol-3', 'Distribuidora El Sol Ltda', 6_000_000, '2026-03-10', '2026-04-09', {
      status: 'cancelled',
    }),
  );
  // Agro Pacífico: una sola factura, 20 días tarde.
  out.push(
    settledInvoice(
      'agro-1',
      'Agro Pacífico S.A.S.',
      null,
      5_000_000,
      '2026-07-15',
      '2026-08-14',
      '2026-09-03',
    ),
  );
  return out;
}

/** Lo abierto hoy: por cobrar y por pagar. */
export function openItems(): LedgerMovement[] {
  return [
    invoice('FV-1210', 'Nexa Logística S.A.S.', 18_000_000, '2026-09-20', '2026-10-20', {
      counterpartyTaxId: '901234567-1',
    }),
    invoice('FV-1225', 'Nexa Logística', 15_000_000, '2026-10-01', '2026-11-03'),
    invoice('FV-1215', 'Coltrans S.A.S.', 12_000_000, '2026-09-15', '2026-10-15'),
    // El Sol: una perdida hace meses y una vencida hace 22 días (pagó la mitad).
    invoice('FV-1101', 'Distribuidora El Sol Ltda', 8_000_000, '2026-04-15', '2026-05-15'),
    invoice('FV-1190', 'Distribuidora El Sol Ltda', 6_000_000, '2026-08-11', '2026-09-10', {
      outstanding: 3_000_000,
    }),
    invoice('FV-1230', 'Agro Pacífico S.A.S.', 5_000_000, '2026-09-30', '2026-10-30'),
    invoice('FV-1240', 'Constructora Bolívar S.A.', 9_000_000, '2026-10-01', '2026-11-20'),
    bill('LL-88', 'Llantas del Valle', 7_000_000, '2026-10-09', { category: 'proveedores' }),
    bill('DIAN-IVA-5', 'DIAN', 11_000_000, '2026-10-14', {
      category: 'impuestos',
      description: 'IVA bimestral julio-agosto',
    }),
    bill('TALLER-12', 'Taller El Pistón', 2_500_000, '2026-09-20', { category: 'mantenimiento' }),
    // El arriendo de octubre ya llegó como factura: no se cuenta dos veces.
    bill('ARR-OCT', 'Inmobiliaria Los Andes S.A.S.', 6_500_000, '2026-10-05', {
      category: 'arriendo',
      counterpartyTaxId: '900555111-2',
    }),
    bill('CAMION-1', 'Autonorte S.A.S.', 60_000_000, '2026-11-25', {
      category: 'otros_gastos',
      description: 'Cuota inicial camión',
    }),
  ];
}

export function accounts(): CashAccount[] {
  return [
    {
      id: 'acc-bcol',
      name: 'Bancolombia corriente',
      currency: 'COP',
      balance: 52_000_000,
      balanceAt: '2026-10-01',
      source: { kind: 'bank', system: 'Bancolombia', ref: 'bcol' },
    },
    {
      id: 'acc-davi',
      name: 'Davivienda ahorros',
      currency: 'COP',
      balance: 8_500_000,
      balanceAt: '2026-09-30',
      source: { kind: 'bank', system: 'Davivienda', ref: 'davi' },
    },
    {
      id: 'acc-usd',
      name: 'Cuenta de compensación USD',
      currency: 'USD',
      balance: 12_000,
      balanceAt: '2026-09-30',
      source: { kind: 'bank', system: 'Bancolombia', ref: 'usd' },
    },
  ];
}

export function company(): { accounts: CashAccount[]; movements: LedgerMovement[] } {
  return {
    accounts: accounts(),
    movements: [...expenseHistory(), ...receivableHistory(), ...openItems()],
  };
}
