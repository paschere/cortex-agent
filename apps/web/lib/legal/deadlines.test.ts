import { describe, expect, it } from 'vitest';
import {
  addBusinessDays,
  bogotaDate,
  businessDaysLeft,
  isLegalBusinessDay,
  legalDueDate,
  legalExtendedDueDate,
  legalHolidays,
} from './deadlines';

describe('festivos de Colombia', () => {
  it('2026: los 18 de la Ley 51 de 1983 más el de la Ley 2578 de 2026', () => {
    expect([...legalHolidays(2026)].sort()).toEqual([
      '2026-01-01',
      '2026-01-12', // Reyes, corrido al lunes
      '2026-03-23', // San José
      '2026-04-02', // Jueves Santo
      '2026-04-03', // Viernes Santo
      '2026-05-01',
      '2026-05-18', // Ascensión
      '2026-06-08', // Corpus Christi
      '2026-06-15', // Sagrado Corazón
      '2026-06-29', // San Pedro y San Pablo
      '2026-07-13', // Virgen de Chiquinquirá (Ley 2578 de 2026), 9 de julio al lunes
      '2026-07-20',
      '2026-08-07',
      '2026-08-17', // Asunción
      '2026-10-12', // Día de la Raza
      '2026-11-02', // Todos los Santos
      '2026-11-16', // Independencia de Cartagena
      '2026-12-08',
      '2026-12-25',
    ]);
  });

  it('el Día Cívico de abril NO es festivo nacional (es de la DIAN)', () => {
    expect(isLegalBusinessDay('2026-04-17')).toBe(true);
  });

  it('antes de 2026 no existe el festivo de julio', () => {
    expect(legalHolidays(2025).has('2025-07-14')).toBe(false);
  });
});

describe('plazos de la Ley 1581', () => {
  it('consulta: 10 días hábiles desde el día siguiente, saltando el festivo del 12 de octubre', () => {
    // Recibida el viernes 2 de octubre de 2026 a mediodía en Bogotá.
    const received = new Date('2026-10-02T17:00:00Z');
    // 5,6,7,8,9 · (12 festivo) · 13,14,15,16 · 19
    expect(legalDueDate('consulta', received)).toBe('2026-10-19');
  });

  it('reclamo: 15 días hábiles', () => {
    expect(legalDueDate('reclamo', new Date('2026-10-02T17:00:00Z'))).toBe('2026-10-26');
  });

  it('prórrogas: +5 hábiles la consulta, +8 el reclamo, desde el vencimiento', () => {
    expect(legalExtendedDueDate('consulta', '2026-10-19')).toBe('2026-10-26');
    // 27,28,29,30 · (2 nov festivo) · 3,4,5,6 → 8
    expect(legalExtendedDueDate('reclamo', '2026-10-26')).toBe('2026-11-06');
  });

  it('el día de recibo es el de Bogotá, no el UTC', () => {
    // 3 de octubre 03:00 UTC = viernes 2 de octubre 22:00 en Bogotá.
    expect(bogotaDate(new Date('2026-10-03T03:00:00Z'))).toBe('2026-10-02');
    expect(legalDueDate('consulta', new Date('2026-10-03T03:00:00Z'))).toBe('2026-10-19');
  });

  it('recibida un sábado: el conteo empieza el lunes hábil', () => {
    // Sábado 3 de octubre → 5..9 (5), 13..16 (9), 19 (10)
    expect(legalDueDate('consulta', new Date('2026-10-03T15:00:00Z'))).toBe('2026-10-19');
  });

  it('Semana Santa y fin de año', () => {
    // Lunes 30 de marzo de 2026: 31, (1 abr hábil), (2 y 3 festivos) …
    expect(addBusinessDays('2026-03-30', 3)).toBe('2026-04-06');
    // 24 de diciembre: 25 festivo, 26-27 fin de semana.
    expect(addBusinessDays('2026-12-24', 1)).toBe('2026-12-28');
  });

  it('días hábiles que faltan, y negativos cuando venció', () => {
    expect(businessDaysLeft('2026-10-09', '2026-10-19')).toBe(5);
    expect(businessDaysLeft('2026-10-19', '2026-10-19')).toBe(0);
    expect(businessDaysLeft('2026-10-21', '2026-10-19')).toBe(-2);
  });
});
