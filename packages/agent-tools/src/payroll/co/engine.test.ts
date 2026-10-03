import { describe, expect, it } from 'vitest';
import { businessDaysBetween, days360, vacationEnd } from './dates';
import {
  type EmployeeForPayroll,
  type Liquidation,
  liquidate,
  retencionProcedimiento1,
} from './engine';
import { pilaRows } from './exports';
import { checkLeaveRequest, vacationBalance } from './leave';
import { paramsFor } from './params';
import { liquidateTermination } from './termination';

/**
 * EJEMPLOS RESUELTOS A MANO. Cada cifra esperada está escrita como la cuenta
 * que la produce, para que un contador pueda revisarla sin leer el motor.
 * Parámetros: SMMLV 2026 $1.750.905, auxilio $249.095, UVT $52.374; desde el
 * 15-jul-2026, 42 h semanales (210 h al mes) y recargo dominical 90 %.
 */

const SEPT = { start: '2026-09-01', end: '2026-09-30', frequency: 'mensual' as const };
const SMMLV = 1_750_905;
const AUX = 249_095;

function emp(over: Partial<EmployeeForPayroll> = {}): EmployeeForPayroll {
  return {
    id: 'e1',
    name: 'Ana Ruiz',
    contractType: 'indefinido',
    salary: SMMLV,
    integral: false,
    arlClass: 1,
    startDate: '2024-01-15',
    ...over,
  };
}

const line = (l: Liquidation, code: string) => l.lines.find((x) => x.code === code)?.amount ?? null;

describe('parámetros por fecha', () => {
  it('cambian a mitad de 2026: recargo dominical el 1-jul, jornada el 15-jul', () => {
    expect(paramsFor('2026-06-30')).toMatchObject({
      recargoDominicalFestivo: 0.8,
      monthlyHours: 220,
    });
    expect(paramsFor('2026-07-10')).toMatchObject({
      recargoDominicalFestivo: 0.9,
      monthlyHours: 220,
    });
    expect(paramsFor('2026-07-15')).toMatchObject({
      recargoDominicalFestivo: 0.9,
      monthlyHours: 210,
      weeklyHours: 42,
    });
    expect(paramsFor('2026-09-30')).toMatchObject({
      smmlv: SMMLV,
      auxilioTransporte: AUX,
      uvt: 52_374,
    });
    expect(() => paramsFor('2027-01-01')).toThrow(/parámetros de nómina/);
  });

  it('el mes comercial tiene 30 días', () => {
    expect(days360('2026-02-01', '2026-02-28')).toBe(30);
    expect(days360('2026-01-16', '2026-01-31')).toBe(15);
    expect(days360('2026-09-10', '2026-09-30')).toBe(21);
  });
});

describe('salario mínimo con auxilio de transporte (septiembre de 2026)', () => {
  const l = liquidate({ employee: emp(), company: { exonerated1141: false }, period: SEPT });

  it('devenga el mínimo más el auxilio: $2.000.000', () => {
    expect(line(l, 'salario')).toBe(SMMLV);
    expect(line(l, 'auxilio_transporte')).toBe(AUX);
    expect(l.totals.devengado).toBe(2_000_000);
  });

  it('el auxilio no es base de aportes: IBC = el mínimo', () => {
    expect(l.ibc.salud).toBe(SMMLV);
    expect(line(l, 'salud_empleado')).toBe(Math.round(SMMLV * 0.04)); // 70.036
    expect(line(l, 'pension_empleado')).toBe(70_036);
    expect(line(l, 'fondo_solidaridad')).toBeNull();
    expect(line(l, 'retencion_fuente')).toBeNull();
    expect(l.totals.neto).toBe(2_000_000 - 2 * 70_036);
  });

  it('aportes del empleador sin exoneración', () => {
    expect(line(l, 'salud_empleador')).toBe(148_827); // 8,5 %
    expect(line(l, 'pension_empleador')).toBe(210_109); // 12 %
    expect(line(l, 'arl')).toBe(9_140); // 0,522 %
    expect(line(l, 'caja')).toBe(70_036); // 4 %
    expect(line(l, 'icbf')).toBe(52_527); // 3 %
    expect(line(l, 'sena')).toBe(35_018); // 2 %
    expect(l.totals.aportes).toBe(148_827 + 210_109 + 9_140 + 70_036 + 52_527 + 35_018);
  });

  it('provisiona prestaciones sobre salario + auxilio', () => {
    expect(line(l, 'cesantias')).toBe(Math.round(2_000_000 / 12)); // 166.667
    expect(line(l, 'intereses_cesantias')).toBe(20_000);
    expect(line(l, 'prima')).toBe(166_667);
    expect(line(l, 'vacaciones_prov')).toBe(Math.round((SMMLV * 15) / 360)); // 72.954, sin auxilio
    expect(l.totals.costoTotal).toBe(l.totals.devengado + l.totals.aportes + l.totals.provisiones);
  });

  it('cada línea trae su cuenta escrita', () => {
    expect(l.lines.find((x) => x.code === 'salario')?.explanation).toMatch(/30 días × \$58\.36/);
    expect(l.paramsVersion).toBe('co-2026.c');
    expect(l.estimates.join(' ')).toMatch(/decreto transitorio/);
  });

  it('con la exoneración del art. 114-1 no paga salud empleador, ICBF ni SENA', () => {
    const x = liquidate({ employee: emp(), company: { exonerated1141: true }, period: SEPT });
    expect(line(x, 'salud_empleador')).toBeNull();
    expect(line(x, 'icbf')).toBeNull();
    expect(line(x, 'sena')).toBeNull();
    expect(line(x, 'pension_empleador')).toBe(210_109);
    expect(x.totals.aportes).toBe(210_109 + 9_140 + 70_036);
  });
});

describe('tres salarios mínimos ($5.252.715)', () => {
  const salary = 3 * SMMLV;
  const l = liquidate({
    employee: emp({ salary }),
    company: { exonerated1141: true },
    period: SEPT,
  });

  it('no tiene auxilio de transporte (pasa de 2 mínimos)', () => {
    expect(line(l, 'auxilio_transporte')).toBeNull();
    expect(l.totals.devengado).toBe(salary);
  });

  it('cotiza 4 + 4 y no llega al fondo de solidaridad', () => {
    expect(line(l, 'salud_empleado')).toBe(210_109);
    expect(line(l, 'pension_empleado')).toBe(210_109);
    expect(line(l, 'fondo_solidaridad')).toBeNull();
  });

  it('la retención estimada es cero: la base queda en ~69 UVT (< 95)', () => {
    const neto = salary - 2 * 210_109;
    const base = neto - neto * 0.25;
    expect(base / 52_374).toBeLessThan(95);
    expect(line(l, 'retencion_fuente')).toBeNull();
  });

  it('exonerado: sólo pensión, ARL y caja', () => {
    expect(line(l, 'pension_empleador')).toBe(Math.round(salary * 0.12)); // 630.326
    expect(line(l, 'arl')).toBe(Math.round(salary * 0.00522)); // 27.419
    expect(line(l, 'caja')).toBe(210_109);
    expect(line(l, 'exoneracion_1141')).toBe(0);
  });
});

describe('salario integral ($25.000.000)', () => {
  const salary = 25_000_000;
  const l = liquidate({
    employee: emp({ salary, integral: true }),
    company: { exonerated1141: true },
    period: SEPT,
  });

  it('cotiza sobre el 70 %', () => {
    expect(l.ibc.salud).toBe(17_500_000);
    expect(line(l, 'salud_empleado')).toBe(700_000);
    expect(line(l, 'pension_empleado')).toBe(700_000);
    // 17,5 M = 9,99 mínimos → 1 % al fondo de solidaridad.
    expect(line(l, 'fondo_solidaridad')).toBe(175_000);
  });

  it('nunca está exonerado y paga parafiscales sobre el 70 %', () => {
    expect(line(l, 'salud_empleador')).toBe(1_487_500);
    expect(line(l, 'icbf')).toBe(525_000);
    expect(line(l, 'sena')).toBe(350_000);
    expect(line(l, 'caja')).toBe(700_000);
  });

  it('sólo provisiona vacaciones (sin cesantías ni prima)', () => {
    expect(line(l, 'cesantias')).toBeNull();
    expect(line(l, 'prima')).toBeNull();
    expect(line(l, 'vacaciones_prov')).toBe(Math.round((salary * 15) / 360));
  });

  it('retención por la tabla del art. 383 con el tope de 790 UVT', () => {
    const uvt = 52_374;
    const neto = salary - 700_000 - 700_000 - 175_000; // 23.425.000
    const exenta = Math.min(neto * 0.25, (790 / 12) * uvt); // tope: 3.447.955
    const baseUvt = (neto - exenta) / uvt; // ≈ 381,4 UVT
    const expected = Math.round(((baseUvt - 360) * 0.33 + 69) * uvt);
    expect(line(l, 'retencion_fuente')).toBe(expected);
    expect(l.lines.find((x) => x.code === 'retencion_fuente')?.estimate).toBe(true);
  });

  it('avisa si el integral queda por debajo de 13 mínimos', () => {
    const low = liquidate({
      employee: emp({ salary: 15_000_000, integral: true }),
      company: { exonerated1141: false },
      period: SEPT,
    });
    expect(low.warnings.join(' ')).toMatch(/13 salarios mínimos/);
  });
});

describe('horas extra nocturnas dominicales y recargos', () => {
  const salary = 2_000_000;

  it('septiembre: 42 h y 90 % dominical → factor 2,65', () => {
    const l = liquidate({
      employee: emp({ salary }),
      company: { exonerated1141: true },
      period: SEPT,
      novelties: [
        { kind: 'hora_extra_dominical_nocturna', date: '2026-09-13', hours: 4 },
        { kind: 'recargo_nocturno', date: '2026-09-10', hours: 10 },
      ],
    });
    const hour = salary / 210;
    expect(line(l, 'hora_extra_dominical_nocturna')).toBe(Math.round(4 * hour * (1 + 0.75 + 0.9))); // 100.952
    expect(line(l, 'recargo_nocturno')).toBe(Math.round(10 * hour * 0.35)); // 33.333
    // Las horas extra son salario: entran al IBC.
    expect(l.ibc.salud).toBe(salary + 100_952 + 33_333);
    expect(l.warnings).toEqual([]);
  });

  it('junio: 44 h y 80 % dominical → factor 2,05 la extra dominical diurna', () => {
    const l = liquidate({
      employee: emp({ salary }),
      company: { exonerated1141: true },
      period: { start: '2026-06-01', end: '2026-06-30', frequency: 'mensual' },
      novelties: [{ kind: 'hora_extra_dominical_diurna', date: '2026-06-07', hours: 2 }],
    });
    expect(line(l, 'hora_extra_dominical_diurna')).toBe(Math.round(2 * (salary / 220) * 2.05)); // 37.273
  });

  it('avisa un recargo dominical en un día que no es domingo ni festivo', () => {
    const l = liquidate({
      employee: emp({ salary }),
      company: { exonerated1141: true },
      period: SEPT,
      novelties: [{ kind: 'recargo_dominical', date: '2026-09-09', hours: 8 }],
    });
    expect(l.warnings.join(' ')).toMatch(/no es domingo ni festivo/);
  });
});

describe('incapacidad por enfermedad general (5 días, salario mínimo)', () => {
  const l = liquidate({
    employee: emp(),
    company: { exonerated1141: false },
    period: SEPT,
    novelties: [{ kind: 'incapacidad_general', date: '2026-09-10', dateTo: '2026-09-14' }],
  });
  const daily = SMMLV / 30;

  it('paga los 5 días al mínimo diario (2/3 quedaría por debajo)', () => {
    expect(line(l, 'incapacidad_general')).toBe(Math.round(daily * 5)); // 291.818
    expect(line(l, 'salario')).toBe(Math.round(daily * 25));
    expect(l.days).toMatchObject({ contract: 30, salary: 25, incapacity: 5, worked: 25 });
  });

  it('el auxilio se paga sólo por los días trabajados', () => {
    expect(line(l, 'auxilio_transporte')).toBe(Math.round((AUX / 30) * 25)); // 207.579
  });

  it('la ARL y los parafiscales no cotizan sobre la incapacidad', () => {
    expect(l.ibc.arl).toBe(Math.round(daily * 25));
    expect(l.ibc.parafiscales).toBe(Math.round(daily * 25));
    expect(l.ibc.salud).toBeGreaterThanOrEqual(SMMLV);
  });

  it('con salario alto paga 2/3', () => {
    const x = liquidate({
      employee: emp({ salary: 6_000_000 }),
      company: { exonerated1141: false },
      period: SEPT,
      novelties: [{ kind: 'incapacidad_general', date: '2026-09-10', dateTo: '2026-09-14' }],
    });
    expect(line(x, 'incapacidad_general')).toBe(Math.round((6_000_000 / 30) * (2 / 3) * 5)); // 666.667
  });
});

describe('ingresos a mitad de mes, quincenas y exclusiones', () => {
  it('ingresa el 16: medio mes', () => {
    const l = liquidate({
      employee: emp({ startDate: '2026-09-16' }),
      company: { exonerated1141: false },
      period: SEPT,
    });
    expect(l.days.contract).toBe(15);
    expect(line(l, 'salario')).toBe(Math.round((SMMLV / 30) * 15));
    expect(l.warnings.join(' ')).toMatch(/ING/);
  });

  it('una quincena liquida 15 días', () => {
    const l = liquidate({
      employee: emp(),
      company: { exonerated1141: false },
      period: { start: '2026-09-16', end: '2026-09-30', frequency: 'quincenal' },
    });
    expect(l.days.contract).toBe(15);
    expect(l.ibc.salud).toBe(Math.round(SMMLV / 2));
  });

  it('prestación de servicios no va en nómina', () => {
    const l = liquidate({
      employee: emp({ contractType: 'prestacion_servicios' }),
      company: { exonerated1141: false },
      period: SEPT,
    });
    expect(l.excluded).toMatch(/no va en la nómina/);
    expect(l.lines).toEqual([]);
  });

  it('licencia no remunerada: no paga esos días y la empresa sigue con pensión', () => {
    const l = liquidate({
      employee: emp(),
      company: { exonerated1141: false },
      period: SEPT,
      novelties: [{ kind: 'licencia_no_remunerada', date: '2026-09-21', dateTo: '2026-09-25' }],
    });
    expect(line(l, 'salario')).toBe(Math.round((SMMLV / 30) * 25));
    expect(line(l, 'pension_licencia')).toBe(Math.round(Math.round((SMMLV / 30) * 5) * 0.12));
  });
});

describe('retención en la fuente (procedimiento 1)', () => {
  it('nada por debajo de 95 UVT', () => {
    expect(
      retencionProcedimiento1({
        ingresosLaborales: 6_000_000,
        aportesObligatorios: 480_000,
        dependents: false,
        prepaidHealth: 0,
        uvt: 52_374,
      }).amount,
    ).toBe(0);
  });
  it('dependientes bajan la base', () => {
    const a = retencionProcedimiento1({
      ingresosLaborales: 12_000_000,
      aportesObligatorios: 1_080_000,
      dependents: false,
      prepaidHealth: 0,
      uvt: 52_374,
    });
    const b = retencionProcedimiento1({
      ingresosLaborales: 12_000_000,
      aportesObligatorios: 1_080_000,
      dependents: true,
      prepaidHealth: 0,
      uvt: 52_374,
    });
    expect(a.amount).toBeGreaterThan(b.amount);
    expect(b.amount).toBeGreaterThan(0);
  });
});

describe('vacaciones: causación y saldo', () => {
  it('un año completo causa 15 días hábiles', () => {
    const b = vacationBalance({
      startDate: '2025-01-01',
      openingDays: 0,
      takenBusinessDays: 0,
      unpaidDays: 0,
      asOf: '2025-12-31',
    });
    expect(b.accrued).toBe(15);
    expect(b.serviceYears).toBe(1);
  });

  it('nueve meses causan 11,25; menos lo tomado; la licencia no remunerada no causa', () => {
    const b = vacationBalance({
      startDate: '2026-01-01',
      openingDays: 0,
      takenBusinessDays: 6,
      unpaidDays: 0,
      asOf: '2026-09-30',
    });
    expect(b.accrued).toBe(11.25);
    expect(b.balance).toBe(5.25);
    const c = vacationBalance({
      startDate: '2026-01-01',
      openingDays: 0,
      takenBusinessDays: 0,
      unpaidDays: 24,
      asOf: '2026-09-30',
    });
    expect(c.accrued).toBe(10.25);
  });

  it('el saldo de apertura se suma y se causa desde su fecha', () => {
    const b = vacationBalance({
      startDate: '2020-02-01',
      openingDays: 8,
      openingAsOf: '2026-07-01',
      takenBusinessDays: 0,
      unpaidDays: 0,
      asOf: '2026-09-30',
    });
    expect(b.accrued).toBe(8 + 3.75);
  });

  it('cuenta días hábiles sin domingos ni festivos', () => {
    // 2026-10-12 es festivo (Día de la Raza, lunes).
    expect(businessDaysBetween('2026-10-12', '2026-10-17', { saturdayIsWorkday: true })).toBe(5);
    expect(businessDaysBetween('2026-10-12', '2026-10-17', { saturdayIsWorkday: false })).toBe(4);
    expect(vacationEnd('2026-10-13', 15, { saturdayIsWorkday: false })).toBe('2026-11-03');
  });

  it('revisa la solicitud contra el saldo', () => {
    const r = checkLeaveRequest({
      kind: 'vacaciones',
      start: '2026-10-13',
      end: '2026-11-03',
      businessDays: 15,
      balance: 10,
      overlaps: 0,
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/anticipadas/);
    expect(
      checkLeaveRequest({
        kind: 'vacaciones',
        start: '2026-10-13',
        end: '2026-10-14',
        businessDays: 2,
        balance: 10,
        overlaps: 1,
      }).errors,
    ).toHaveLength(1);
  });
});

describe('liquidación del contrato (estimada)', () => {
  it('indefinido, mínimo, 3 años y medio, sin justa causa', () => {
    const r = liquidateTermination({
      name: 'Ana Ruiz',
      contractType: 'indefinido',
      salary: SMMLV,
      integral: false,
      startDate: '2023-03-01',
      terminationDate: '2026-09-15',
      reason: 'sin_justa_causa',
      salaryPaidThrough: '2026-08-31',
      vacationDaysPending: 10,
    });
    const get = (c: string) => r.lines.find((l) => l.code === c)?.amount;
    const daily = SMMLV / 30;
    expect(get('salario_pendiente')).toBe(Math.round(daily * 15));
    expect(get('cesantias')).toBe(Math.round((2_000_000 * 255) / 360)); // 1.416.667
    expect(get('prima')).toBe(Math.round((2_000_000 * 75) / 360)); // 416.667
    expect(get('vacaciones_compensadas')).toBe(Math.round(daily * 10));
    // 1.275 días: 30 por el primer año + 20 × 915/360 por los siguientes.
    expect(r.indemnization).toBe(Math.round(daily * (30 + (20 * 915) / 360)));
    expect(r.estimate).toBe(true);
  });

  it('término fijo: los salarios que faltan', () => {
    const r = liquidateTermination({
      name: 'B',
      contractType: 'fijo',
      salary: 3_000_000,
      integral: false,
      startDate: '2026-01-01',
      terminationDate: '2026-09-30',
      contractEnd: '2026-12-31',
      reason: 'sin_justa_causa',
      salaryPaidThrough: '2026-09-30',
      vacationDaysPending: 0,
    });
    expect(r.indemnization).toBe(9_000_000); // 90 días × $100.000
  });

  it('renuncia: sin indemnización', () => {
    const r = liquidateTermination({
      name: 'C',
      contractType: 'indefinido',
      salary: SMMLV,
      integral: false,
      startDate: '2024-01-01',
      terminationDate: '2026-09-30',
      reason: 'renuncia',
      salaryPaidThrough: '2026-09-30',
      vacationDaysPending: 0,
    });
    expect(r.indemnization).toBe(0);
  });
});

describe('PILA', () => {
  it('suma empleado + empleador y redondea a la centena superior', () => {
    const l = liquidate({ employee: emp(), company: { exonerated1141: false }, period: SEPT });
    const { rows, totals } = pilaRows(
      '2026-09',
      [
        {
          id: 'e1',
          name: 'Ana Ruiz',
          documentType: 'CC',
          documentNumber: '1020',
          contractType: 'indefinido',
          integral: false,
          arlClass: 1,
          eps: 'Sura',
          afp: 'Porvenir',
          ccf: 'Compensar',
          arl: 'Sura',
          bankName: null,
          bankAccountType: null,
          bankAccountLast4: null,
          apprenticePhase: null,
          startDate: '2024-01-15',
          endDate: null,
          costCenter: null,
        },
      ],
      [l],
    );
    expect(rows).toHaveLength(1);
    expect(totals.pension).toBe(Math.ceil((70_036 + 210_109) / 100) * 100); // 280.200
    expect(totals.salud).toBe(Math.ceil((70_036 + 148_827) / 100) * 100); // 218.900
  });
});
