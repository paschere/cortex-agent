import { describe, expect, it } from 'vitest';
import {
  cleanText,
  formatClock,
  formatCompactMoney,
  formatDateTime,
  formatDay,
  formatDuration,
  formatLoose,
  formatMoney,
  formatNumber,
  formatPercent,
  formatQuantity,
  roundMoney,
  sumMoney,
} from './display';
import { displayTrackerValue } from '../trackers/schema';

const nb = (s: string) => s.replace(/ /g, ' ');

describe('dinero', () => {
  it('pesos completos con puntos de miles; abrevia sólo desde mil millones', () => {
    expect(nb(formatMoney(240000))).toBe('$ 240.000');
    expect(nb(formatMoney(1147232.5))).toBe('$ 1.147.233');
    expect(nb(formatCompactMoney(999_999_999))).toBe('$ 999.999.999');
    expect(nb(formatCompactMoney(1_600_000_000))).toBe('$ 1,6 mil millones');
  });
  it('dólares con dos decimales', () => {
    expect(nb(formatMoney(1250.5, 'USD'))).toMatch(/1\.250,50/);
  });
  it('negativos con signo claro y sin «-$ 0»', () => {
    expect(nb(formatMoney(-25000))).toBe('-$ 25.000');
    expect(nb(formatMoney(-0.3))).toBe('$ 0');
  });
  it('nunca NaN ni Infinity', () => {
    expect(formatMoney(Number.NaN)).toBe('—');
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatPercent(Number.NaN)).toBe('—');
  });
  it('el total cuadra con lo que se ve', () => {
    const parts = [0.4, 0.4, 0.4];
    expect(sumMoney(parts, 'USD')).toBe(1.2);
    expect(sumMoney([100.4, 100.4, 100.4])).toBe(300);
    expect(roundMoney(1.005, 'USD')).toBe(1.01);
  });
});

describe('fechas y horas', () => {
  it('un día no cambia por zona y un instante sale en Bogotá', () => {
    expect(formatDay('2026-10-02')).toBe('2 oct 2026');
    expect(formatDateTime('2026-10-02T20:04:00Z')).toBe('2 oct 2026, 3:04 p. m.');
    expect(formatClock('15:04')).toBe('3:04 p. m.');
    expect(formatClock('00:30')).toBe('12:30 a. m.');
  });
  it('formatLoose limpia lo que no sabe de tipo', () => {
    expect(formatLoose('2026-10-02')).toBe('2 oct 2026');
    expect(formatLoose('2026-10-02T20:04:00.000Z')).toBe('2 oct 2026, 3:04 p. m.');
    expect(formatLoose(240000)).toBe('240.000');
    expect(formatLoose(null)).toBe('—');
    expect(formatLoose('undefined')).toBe('—');
    expect(formatLoose(Number.NaN)).toBe('—');
    expect(formatLoose('Hola')).toBe('Hola');
  });
});

describe('duraciones y cantidades', () => {
  it('duraciones legibles', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(180)).toBe('3 min');
    expect(formatDuration(4800)).toBe('1 h 20 min');
    expect(formatDuration(100_800)).toBe('1 d 4 h');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
  it('cantidad con unidad', () => {
    expect(formatQuantity(1250, 'kg')).toBe('1.250 kg');
    expect(formatQuantity(2.5, 'm')).toBe('2,5 m');
    expect(formatQuantity(3, undefined)).toBe('3');
  });
  it('cleanText descarta basura', () => {
    expect(cleanText('NaN')).toBe('');
    expect(cleanText(undefined)).toBe('');
    expect(cleanText('Bogotá')).toBe('Bogotá');
  });
});

describe('displayTrackerValue (vista previa de relaciones, chat, avisos)', () => {
  it('dinero, números, fechas y horas formateados', () => {
    expect(nb(displayTrackerValue({ type: 'money' }, 1147232))).toBe('$ 1.147.232');
    expect(displayTrackerValue({ type: 'number' }, 240000)).toBe('240.000');
    expect(displayTrackerValue({ type: 'date' }, '2026-10-02')).toBe('2 oct 2026');
    expect(displayTrackerValue({ type: 'time' }, '15:04')).toBe('3:04 p. m.');
    expect(displayTrackerValue({ type: 'number' }, 'abc')).toBe('abc');
  });
});
