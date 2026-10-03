import { describe, expect, it } from 'vitest';
import { findDates, makeIso, quoteStatesDate, readValidity } from '../dates';

const isos = (text: string) => findDates(text).map((h) => h.iso);

describe('findDates: las formas en que un papel colombiano escribe una fecha', () => {
  it.each([
    ['15 de marzo de 2027', '2027-03-15'],
    ['15 de marzo del 2027', '2027-03-15'],
    ['1° de abril de 2026', '2026-04-01'],
    ['1ro de abril de 2026', '2026-04-01'],
    ['primero de abril de 2026', '2026-04-01'],
    ['15 marzo 2027', '2027-03-15'],
    ['15 de Marzo, 2027', '2027-03-15'],
    ['marzo 15 de 2027', '2027-03-15'],
    ['15-mar-2027', '2027-03-15'],
    ['15/MAR/2027', '2027-03-15'],
    ['30 de setiembre de 2026', '2026-09-30'],
    ['30 de Septiembre de 2026', '2026-09-30'],
    ['01/04/2026', '2026-04-01'],
    ['1-4-2026', '2026-04-01'],
    ['01.04.2026', '2026-04-01'],
    ['31/03/27', '2027-03-31'],
    ['2026-04-01', '2026-04-01'],
    ['2026/04/01', '2026-04-01'],
    ['VENCE: 15 DE MARZO DE 2027', '2027-03-15'],
  ])('«%s» → %s', (text, iso) => {
    expect(isos(text)).toEqual([iso]);
  });

  it('lee DÍA/MES/AÑO: 04/01/2026 es el 4 de enero, no el 1 de abril', () => {
    expect(isos('04/01/2026')).toEqual(['2026-01-04']);
  });

  it('acepta el orden gringo sólo cuando el segundo número no puede ser mes', () => {
    expect(isos('03/31/2027')).toEqual(['2027-03-31']);
  });

  it('rechaza días que no existen', () => {
    expect(isos('31 de febrero de 2027')).toEqual([]);
    expect(isos('30/02/2027')).toEqual([]);
    expect(makeIso(2027, 2, 29)).toBeNull();
    expect(makeIso(2028, 2, 29)).toBe('2028-02-29');
  });

  it('no inventa fechas con números que no lo son', () => {
    expect(isos('Póliza No. 1001234567, valor $1.250.000')).toEqual([]);
    expect(isos('vigencia de doce meses')).toEqual([]);
    expect(isos('marzo de 2027')).toEqual([]);
  });

  it('encuentra varias fechas en orden', () => {
    expect(isos('desde 01/04/2026 hasta 31/03/2027')).toEqual(['2026-04-01', '2027-03-31']);
  });
});

describe('quoteStatesDate', () => {
  it('exige que la fecha esté ESCRITA en la cita', () => {
    expect(quoteStatesDate('vigente hasta el 15 de marzo de 2027', '2027-03-15')).toBe(true);
    // Calculada («doce meses desde…») no es leída.
    expect(
      quoteStatesDate('vigencia de doce meses desde el 15 de marzo de 2026', '2027-03-15'),
    ).toBe(false);
    expect(quoteStatesDate('vence el 15/03/2027', '2027-03-16')).toBe(false);
  });
});

describe('readValidity: desde y hasta', () => {
  it('«vigente hasta el 15 de marzo de 2027»', () => {
    const v = readValidity('El seguro está vigente hasta el 15 de marzo de 2027.');
    expect(v.until?.iso).toBe('2027-03-15');
    expect(v.from).toBeNull();
  });

  it('«desde 01/04/2026 hasta 31/03/2027»', () => {
    const v = readValidity('Vigencia: desde 01/04/2026 hasta 31/03/2027');
    expect(v.from?.iso).toBe('2026-04-01');
    expect(v.until?.iso).toBe('2027-03-31');
  });

  it('«vigencia del 1 de abril de 2026 al 31 de marzo de 2027»', () => {
    const v = readValidity('Vigencia del 1 de abril de 2026 al 31 de marzo de 2027');
    expect(v.from?.iso).toBe('2026-04-01');
    expect(v.until?.iso).toBe('2027-03-31');
  });

  it('expedición y vencimiento en la misma línea, cada uno con su pista', () => {
    const v = readValidity('Fecha de expedición: 02/04/2026   Fecha de vencimiento: 01/04/2027');
    expect(v.from?.iso).toBe('2026-04-02');
    expect(v.until?.iso).toBe('2027-04-01');
  });

  it('SOAT: «inicio de vigencia» y «fin de vigencia»', () => {
    const v = readValidity('INICIO DE VIGENCIA 10/05/2026 00:00 FIN DE VIGENCIA 09/05/2027 23:59');
    expect(v.from?.iso).toBe('2026-05-10');
    expect(v.until?.iso).toBe('2027-05-09');
  });

  it('dos fechas sin pistas: la menor es el comienzo y la mayor el fin', () => {
    const v = readValidity('Vigencia 01/04/2026 - 31/03/2027');
    expect(v.from?.iso).toBe('2026-04-01');
    expect(v.until?.iso).toBe('2027-03-31');
  });

  it('una fecha suelta sin pista no decide nada', () => {
    const v = readValidity('Bogotá, 3 de octubre de 2026');
    expect(v.from).toBeNull();
    expect(v.until).toBeNull();
  });

  it('un «desde» posterior al «hasta» se descarta', () => {
    const v = readValidity('desde el 1 de abril de 2028 hasta el 31 de marzo de 2027');
    expect(v.from).toBeNull();
    expect(v.until).toBeNull();
  });
});
