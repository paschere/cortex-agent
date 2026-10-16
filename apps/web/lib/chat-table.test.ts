import { describe, expect, it } from 'vitest';
import { type HastNode, analyzeTable, parseCellNumber, tableToTsv } from './chat-table';

const t = (value: string): HastNode => ({ type: 'text', value });
const cell = (tag: 'th' | 'td', v: string): HastNode => ({ type: 'element', tagName: tag, children: [t(v)] });
const row = (tag: 'th' | 'td', ...vs: string[]): HastNode => ({ type: 'element', tagName: 'tr', children: vs.map((v) => cell(tag, v)) });
const table = (head: string[], body: string[][]): HastNode => ({
  type: 'element',
  tagName: 'table',
  children: [
    { type: 'element', tagName: 'thead', children: [row('th', ...head)] },
    { type: 'element', tagName: 'tbody', children: body.map((r) => row('td', ...r)) },
  ],
});

describe('parseCellNumber', () => {
  it('lee cifras colombianas', () => {
    expect(parseCellNumber('$1.147.232')).toBe(1147232);
    expect(parseCellNumber('$243.674.776')).toBe(243674776);
    expect(parseCellNumber('-$3.500')).toBe(-3500);
    expect(parseCellNumber('12,5 %')).toBe(12.5);
    expect(parseCellNumber('(1.200)')).toBe(-1200);
  });
  it('no confunde texto', () => {
    expect(parseCellNumber('mayo 2026')).toBeNull();
    expect(parseCellNumber('Prealertas')).toBeNull();
    expect(parseCellNumber('')).toBeNull();
  });
});

describe('analyzeTable', () => {
  const tb = table(
    ['Mes', 'Nómina'],
    [
      ['mayo 2026', '$1.147.232'],
      ['junio 2026', '$7.191.182'],
      ['septiembre 2026', '$103.191.662'],
      ['Total', '$111.530.076'],
    ],
  );
  const m = analyzeTable(tb);
  it('marca la columna de cifras y la fila de total', () => {
    expect([...m.numericCols]).toEqual([1]);
    expect(m.totalRows.size).toBe(1);
  });
  it('la barra se mide contra el mayor sin contar el total', () => {
    const shares = [...m.cells.values()].filter((c) => c.col === 1).map((c) => c.share);
    expect(shares[2]).toBe(1);
    expect(shares[3]).toBeNull();
  });
  it('exporta para pegar en una hoja', () => {
    expect(tableToTsv(m).split('\n')[0]).toBe('Mes\tNómina');
  });
});
