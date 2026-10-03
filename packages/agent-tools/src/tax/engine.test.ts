import { describe, expect, it } from 'vitest';
import { calendarFor, nthBusinessDay, ruleDigitRow, taxHolidays } from './calendar-co';
import { buildTaxCalendar, generateObligations, pilaBusinessDay } from './engine';
import { type TaxProfile, nitCheckDigit, splitNit } from './shape';
import { normalizeProfileInput } from './store';
import { planTaxSync } from './sync';

const BASE: Pick<
  TaxProfile,
  | 'nit'
  | 'personType'
  | 'granContribuyente'
  | 'regimenSimple'
  | 'ivaPeriodicity'
  | 'agenteRetencion'
  | 'icaCity'
  | 'icaPeriodicity'
  | 'exogena'
  | 'activosExterior'
  | 'camaraComercio'
  | 'nominaElectronica'
  | 'pila'
  | 'facturacionElectronica'
> = {
  nit: '900123453',
  personType: 'juridica',
  granContribuyente: false,
  regimenSimple: false,
  ivaPeriodicity: 'none',
  agenteRetencion: false,
  icaCity: null,
  icaPeriodicity: null,
  exogena: false,
  activosExterior: false,
  camaraComercio: false,
  nominaElectronica: false,
  pila: false,
  facturacionElectronica: false,
};

const due = (p: Partial<typeof BASE>, key: string, year = 2026) =>
  generateObligations({ ...BASE, ...p }, year).find((o) => o.key === key)?.dueDate;

describe('las tablas de 2026 son las del PDF de la DIAN y cuadran con la regla', () => {
  it('cada mes «por último dígito» es el 7.º a 16.º día hábil, con el 17 de abril y el 13 de julio', () => {
    const cal = calendarFor(2026);
    expect(cal).not.toBeNull();
    for (const [month, row] of Object.entries(cal?.digitMonths ?? {})) {
      expect(ruleDigitRow(month), month).toEqual(row);
    }
  });

  it('los dos cambios de 2026 están: Día Cívico y el festivo nuevo de julio', () => {
    expect(taxHolidays(2026).has('2026-04-17')).toBe(true);
    expect(taxHolidays(2026).has('2026-07-13')).toBe(true);
    // Abril: los NIT terminados en 0 declaran renta GC el 27, no el 24.
    expect(due({ granContribuyente: true, nit: '800000010' }, 'renta:gc-dec')).toBe('2026-04-27');
  });

  it('renta de personas naturales: agosto 7–19, septiembre 1–20, octubre 1–17 hábiles', () => {
    const cal = calendarFor(2026);
    const rule = [
      ...Array.from({ length: 13 }, (_, i) => nthBusinessDay('2026-08', 7 + i)),
      ...Array.from({ length: 20 }, (_, i) => nthBusinessDay('2026-09', 1 + i)),
      ...Array.from({ length: 17 }, (_, i) => nthBusinessDay('2026-10', 1 + i)),
    ];
    expect(cal?.rentaNaturales).toEqual(rule);
  });
});

describe('el motor', () => {
  it('persona jurídica no grande: declaración en mayo y segunda cuota en julio, por último dígito', () => {
    // NIT terminado en 3 → tercera posición.
    expect(due({}, 'renta:pj-dec')).toBe('2026-05-14');
    expect(due({}, 'renta:pj-c2')).toBe('2026-07-14');
    expect(due({}, 'renta:gc-c1')).toBeUndefined();
  });

  it('gran contribuyente: tres cuotas (febrero, abril, junio)', () => {
    const p = { granContribuyente: true };
    expect(due(p, 'renta:gc-c1')).toBe('2026-02-12');
    expect(due(p, 'renta:gc-dec')).toBe('2026-04-15');
    expect(due(p, 'renta:gc-c3')).toBe('2026-06-12');
  });

  it('persona natural: por los dos últimos dígitos (… 99-00 el 26 de octubre)', () => {
    expect(due({ personType: 'natural', nit: '1020304000' }, 'renta:pn')).toBe('2026-10-26');
    expect(due({ personType: 'natural', nit: '1020304001' }, 'renta:pn')).toBe('2026-08-12');
    expect(due({ personType: 'natural', nit: '1020304066' }, 'renta:pn')).toBe('2026-09-28');
  });

  it('IVA bimestral: seis periodos, el último en enero del año siguiente', () => {
    const rows = generateObligations({ ...BASE, ivaPeriodicity: 'bimestral' }, 2026).filter(
      (o) => o.kind === 'iva',
    );
    expect(rows.map((r) => r.dueDate)).toEqual([
      '2026-03-12',
      '2026-05-14',
      '2026-07-14',
      '2026-09-11',
      '2026-11-13',
      '2027-01-15',
    ]);
    expect(rows.every((r) => r.form === '300' && r.requiresPayment)).toBe(true);
  });

  it('IVA cuatrimestral: mayo, septiembre y enero', () => {
    const rows = generateObligations({ ...BASE, ivaPeriodicity: 'cuatrimestral' }, 2026).filter(
      (o) => o.kind === 'iva',
    );
    expect(rows.map((r) => r.dueDate)).toEqual(['2026-05-14', '2026-09-11', '2027-01-15']);
  });

  it('retención mensual: doce periodos, marzo vence en abril corrido por el Día Cívico', () => {
    const rows = generateObligations({ ...BASE, agenteRetencion: true, nit: '900000009' }, 2026);
    const ret = rows.filter((r) => r.kind === 'retencion');
    expect(ret).toHaveLength(12);
    expect(ret.find((r) => r.key === 'retencion:2026-03')?.dueDate).toBe('2026-04-24');
    expect(ret.find((r) => r.key === 'retencion:2026-12')?.dueDate).toBe('2027-01-25');
  });

  it('Régimen Simple: sin renta, con declaración anual, anticipos e IVA anual en febrero', () => {
    const rows = generateObligations(
      { ...BASE, regimenSimple: true, ivaPeriodicity: 'bimestral', nit: '901000004' },
      2026,
    );
    expect(rows.some((r) => r.kind === 'renta')).toBe(false);
    expect(rows.find((r) => r.key === 'simple_declaracion:anual')?.dueDate).toBe('2026-04-21');
    expect(rows.find((r) => r.key === 'iva:simple-anual')?.dueDate).toBe('2026-02-17');
    expect(rows.filter((r) => r.kind === 'simple_anticipo')).toHaveLength(6);
    expect(rows.find((r) => r.key === 'simple_anticipo:b1')?.dueDate).toBe('2026-05-15');
    expect(rows.some((r) => r.key.startsWith('iva:b'))).toBe(false);
  });

  it('exógena: grandes contribuyentes con los plazos extraordinarios de 1, 2 y 3; los demás por rangos de cinco', () => {
    expect(due({ exogena: true, granContribuyente: true, nit: '800000001' }, 'exogena:anual')).toBe(
      '2026-05-14',
    );
    expect(due({ exogena: true, granContribuyente: true, nit: '800000000' }, 'exogena:anual')).toBe(
      '2026-05-13',
    );
    expect(due({ exogena: true, nit: '900000000' }, 'exogena:anual')).toBe('2026-06-12');
    expect(due({ exogena: true, nit: '900000003' }, 'exogena:anual')).toBe('2026-05-14');
    expect(due({ exogena: true, nit: '900000006' }, 'exogena:anual')).toBe('2026-05-15');
  });

  it('activos en el exterior: el mismo día que la renta', () => {
    expect(due({ activosExterior: true }, 'activos_exterior:anual')).toBe(due({}, 'renta:pj-dec'));
  });

  it('PILA por los dos últimos dígitos y la duda del Día Cívico sólo en abril tardío', () => {
    expect(pilaBusinessDay(0)).toBe(2);
    expect(pilaBusinessDay(7)).toBe(2);
    expect(pilaBusinessDay(8)).toBe(3);
    expect(pilaBusinessDay(64)).toBe(11);
    expect(pilaBusinessDay(99)).toBe(16);
    const early = generateObligations({ ...BASE, pila: true, nit: '900000001' }, 2026);
    expect(early.find((r) => r.key === 'pila:2026-02')?.dueDate).toBe('2026-02-03');
    expect(early.some((r) => r.needsConfirmation)).toBe(false);
    const late = generateObligations({ ...BASE, pila: true, nit: '900000099' }, 2026);
    expect(late.find((r) => r.key === 'pila:2026-04')?.needsConfirmation).toBe(true);
    expect(late.find((r) => r.key === 'pila:2026-05')?.needsConfirmation).toBe(false);
  });

  it('nómina electrónica: décimo día hábil del mes siguiente; junio por confirmar', () => {
    const rows = generateObligations({ ...BASE, nominaElectronica: true }, 2026).filter(
      (o) => o.kind === 'nomina_electronica',
    );
    expect(rows).toHaveLength(12);
    for (const r of rows.filter((x) => !x.key.endsWith('-06'))) {
      const [y, m] = r.dueDate.split('-');
      expect(nthBusinessDay(`${y}-${m}`, 10), r.key).toBe(r.dueDate);
      expect(r.needsConfirmation).toBe(false);
    }
    expect(rows.find((r) => r.key.endsWith('-06'))?.needsConfirmation).toBe(true);
  });

  it('Cámara de Comercio: 31 de marzo', () => {
    expect(due({ camaraComercio: true }, 'camara_comercio:2026')).toBe('2026-03-31');
  });

  it('ICA: Bogotá bimestral sale por confirmar; Cali no inventa fechas y lo dice', () => {
    const bog = buildTaxCalendar({ ...BASE, icaCity: 'bogota', icaPeriodicity: 'bimestral' }, 2026);
    const ica = bog.obligations.filter((o) => o.kind === 'ica');
    expect(ica).toHaveLength(6);
    expect(ica.every((o) => o.needsConfirmation)).toBe(true);
    const cali = buildTaxCalendar({ ...BASE, icaCity: 'cali', icaPeriodicity: 'anual' }, 2026);
    expect(cali.obligations.some((o) => o.kind === 'ica')).toBe(false);
    expect(cali.gaps.join(' ')).toMatch(/Cali/);
    const med = buildTaxCalendar({ ...BASE, icaCity: 'medellin', icaPeriodicity: 'anual' }, 2026);
    // Medellín va al revés: el 3 declara el 28 de abril.
    expect(med.obligations.find((o) => o.kind === 'ica')?.dueDate).toBe('2026-04-28');
  });

  it('2027 sale calculado por regla y todo por confirmar; sin exógena ni ICA', () => {
    const r = buildTaxCalendar(
      { ...BASE, ivaPeriodicity: 'bimestral', exogena: true, icaCity: 'bogota' },
      2027,
    );
    expect(r.obligations.length).toBeGreaterThan(0);
    expect(r.obligations.every((o) => o.needsConfirmation)).toBe(true);
    expect(r.obligations.some((o) => o.kind === 'exogena' || o.kind === 'ica')).toBe(false);
    expect(r.gaps.length).toBeGreaterThanOrEqual(2);
    expect(buildTaxCalendar(BASE, 2030).obligations).toEqual([]);
  });

  it('las llaves son estables y únicas: dos generaciones dan lo mismo', () => {
    const full = {
      ...BASE,
      granContribuyente: true,
      ivaPeriodicity: 'bimestral' as const,
      agenteRetencion: true,
      exogena: true,
      activosExterior: true,
      camaraComercio: true,
      nominaElectronica: true,
      pila: true,
      icaCity: 'bogota' as const,
      icaPeriodicity: 'bimestral' as const,
    };
    const a = generateObligations(full, 2026);
    expect(new Set(a.map((o) => o.key)).size).toBe(a.length);
    expect(generateObligations(full, 2026)).toEqual(a);
    expect(a.every((o) => o.ruleVersion === 'co-2026.1' && o.sourceNote)).toBe(true);
  });
});

describe('el NIT', () => {
  it('separa el dígito de verificación sólo con guion y lo comprueba', () => {
    expect(splitNit('900.123.456-7')).toEqual({ nit: '900123456', dv: '7' });
    expect(splitNit('900123456')).toEqual({ nit: '900123456', dv: null });
    expect(nitCheckDigit('800197268')).toBe('4'); // NIT de la DIAN: 800.197.268-4
    expect(() => normalizeProfileInput({ nit: '800197268-5' })).toThrow(/verificación/);
    expect(normalizeProfileInput({ nit: '800.197.268-4' }).nit).toBe('800197268');
  });

  it('el ICA sin ciudad no tiene periodicidad; Bogotá elige bimestral por defecto', () => {
    expect(
      normalizeProfileInput({ nit: '900123456', icaPeriodicity: 'anual' }).icaPeriodicity,
    ).toBe(null);
    expect(normalizeProfileInput({ nit: '900123456', icaCity: 'bogota' }).icaPeriodicity).toBe(
      'bimestral',
    );
  });
});

describe('la sincronización decide sin tocar lo que alguien marcó', () => {
  const gen = generateObligations({ ...BASE, ivaPeriodicity: 'bimestral' }, 2026);
  const row = (key: string, extra: Record<string, unknown> = {}) => {
    const g = gen.find((x) => x.key === key);
    if (!g) throw new Error(key);
    return {
      ...g,
      id: `id-${key}`,
      status: 'pendiente' as const,
      statusAt: null,
      statusBy: null,
      statusNote: null,
      evidenceDocumentId: null,
      evidenceUrl: null,
      commitmentId: null,
      ...extra,
    };
  };

  it('inserta lo nuevo, no repite lo igual y actualiza lo pendiente que cambió', () => {
    const plan = planTaxSync({
      existing: [row('iva:b1'), row('iva:b2', { dueDate: '2026-05-01' })],
      generated: gen,
      today: '2026-01-15',
      years: [2026],
    });
    expect(plan.insert.map((i) => i.key).filter((k) => k.startsWith('iva'))).toEqual([
      'iva:b3',
      'iva:b4',
      'iva:b5',
      'iva:b6',
    ]);
    expect(plan.update.map((u) => u.id)).toEqual(['id-iva:b2']);
    expect(plan.remove).toEqual([]);
  });

  it('lo presentado o pagado no se actualiza aunque la regla cambie', () => {
    const plan = planTaxSync({
      existing: [row('iva:b2', { dueDate: '2026-05-01', status: 'pagada' })],
      generated: gen,
      today: '2026-01-15',
      years: [2026],
    });
    expect(plan.update).toEqual([]);
  });

  it('al cambiar el perfil borra sólo lo pendiente FUTURO que ya no aplica', () => {
    const plan = planTaxSync({
      existing: [row('iva:b1'), row('iva:b5'), row('iva:b6', { status: 'presentada' })],
      generated: [],
      today: '2026-10-03',
      years: [2026],
    });
    expect(plan.remove.map((r) => r.key)).toEqual(['iva:b5']);
  });

  it('es idempotente: con todo al día no hay nada que hacer', () => {
    const plan = planTaxSync({
      existing: gen.map((g) => row(g.key)),
      generated: gen,
      today: '2026-01-15',
      years: [2026],
    });
    expect(plan).toEqual({ insert: [], update: [], remove: [] });
  });
});
