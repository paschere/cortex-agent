import { describe, expect, it } from 'vitest';
import {
  columnTotals,
  formatAmount,
  formatDate,
  isHttpUrl,
  isNumericColumn,
  rowCountLabel,
  shortUrl,
  sortOrder,
} from './result-grid';

/**
 * LAS DOS COSAS DE UNA TABLA QUE PUEDEN MENTIR.
 *
 * Un orden mal calculado enseña el segundo importe más grande como si fuera el
 * mayor. Un total mal sumado es una cifra que alguien copia a un correo. Las dos
 * salen de aquí, y por eso las dos se comprueban aquí: el entorno de pruebas de
 * esta app es `node`, no monta componentes, y lo que hubiera quedado dentro del
 * `.tsx` no se habría podido probar nunca.
 */

describe('el orden', () => {
  it('ordena por magnitud cuando la columna son números', () => {
    const rows = [{ n: 90 }, { n: 1200 }, { n: 300 }];
    expect(sortOrder(rows, { key: 'n', dir: 'desc' })).toEqual([1, 2, 0]);
    expect(sortOrder(rows, { key: 'n', dir: 'asc' })).toEqual([0, 2, 1]);
  });

  it('deja los huecos al final, suba o baje', () => {
    // Una raya no es «lo más pequeño», es «no se sabe». Si gana el primer
    // puesto al bajar el orden, la primera fila de la tabla deja de ser la
    // respuesta a la pregunta que alguien acaba de hacer.
    const rows = [{ n: 5 }, { n: null }, { n: 9 }, {}];
    expect(sortOrder(rows, { key: 'n', dir: 'asc' })).toEqual([0, 2, 1, 3]);
    expect(sortOrder(rows, { key: 'n', dir: 'desc' })).toEqual([2, 0, 1, 3]);
  });

  it('ordena fechas ISO cronológicamente, que es como se escriben', () => {
    const rows = [{ d: '2026-10-02' }, { d: '2026-09-14' }, { d: '2026-09-14T10:00:00Z' }];
    expect(sortOrder(rows, { key: 'd', dir: 'asc' })).toEqual([1, 2, 0]);
  });

  it('no ordena «Fila 10» antes que «Fila 2»', () => {
    const rows = [{ t: 'Fila 10' }, { t: 'Fila 2' }];
    expect(sortOrder(rows, { key: 't', dir: 'asc' })).toEqual([1, 0]);
  });

  it('conserva el orden de la herramienta en los empates', () => {
    // El orden en que una herramienta devuelve sus filas suele ser el que ella
    // considera relevante. Un empate no es permiso para barajarlo.
    const rows = [
      { n: 1, id: 'a' },
      { n: 1, id: 'b' },
      { n: 0, id: 'c' },
    ];
    expect(sortOrder(rows, { key: 'n', dir: 'desc' })).toEqual([0, 1, 2]);
  });

  it('baja un nivel con `a.b`, igual que las columnas declaradas', () => {
    const rows = [{ s: { at: '2027-01-10' } }, { s: { at: '2026-01-10' } }];
    expect(sortOrder(rows, { key: 's.at', dir: 'asc' })).toEqual([1, 0]);
  });

  it('sin orden pedido devuelve el de la herramienta', () => {
    expect(sortOrder([{ n: 3 }, { n: 1 }], null)).toEqual([0, 1]);
  });
});

describe('el total', () => {
  const money = [{ key: 'amount', label: 'Importe', kind: 'money' as const }];

  it('suma una columna que alguien declaró como dinero', () => {
    const rows = [{ amount: 1_200_000 }, { amount: 300_000 }];
    expect(columnTotals(rows, money)).toEqual([
      { key: 'amount', label: 'Importe', value: 1_500_000, currency: null },
    ]);
  });

  it('no totaliza una columna numérica que nadie dijo qué era', () => {
    // La suma de `Prioridad`, `Avance` o `Empleados` es una cifra que nadie
    // pidió y que en pantalla parece un dato. La capa estructural no sabe qué
    // es ninguna de sus columnas: por eso no totaliza nunca, y está bien.
    const rows = [{ priority: 1 }, { priority: 3 }];
    expect(columnTotals(rows, [{ key: 'priority', label: 'Prioridad', kind: 'number' }])).toEqual(
      [],
    );
    expect(columnTotals(rows, [{ key: 'priority', label: 'Prioridad' }])).toEqual([]);
  });

  it('se calla si a una fila le falta el número', () => {
    // Un total al que le faltan filas no se lee como parcial: se lee como el
    // total.
    expect(columnTotals([{ amount: 10 }, { amount: null }], money)).toEqual([]);
    expect(columnTotals([{ amount: 10 }, { amount: '$300.000' }], money)).toEqual([]);
  });

  it('se calla con dos monedas en la misma tabla', () => {
    const rows = [
      { amount: 10, currency: 'COP' },
      { amount: 20, currency: 'USD' },
    ];
    expect(columnTotals(rows, money)).toEqual([]);
  });

  it('lleva el código de moneda cuando las filas traen uno solo', () => {
    const rows = [
      { amount: 10, currency: 'cop' },
      { amount: 20, currency: 'COP' },
    ];
    expect(columnTotals(rows, money)[0]?.currency).toBe('COP');
  });

  it('no llama total a una sola fila', () => {
    expect(columnTotals([{ amount: 10 }], money)).toEqual([]);
  });

  it('agrupa los miles y no inventa símbolo', () => {
    expect(formatAmount(1_500_000)).toBe('1.500.000');
  });
});

describe('la columna', () => {
  it('es de cifras sólo si todo lo que hay son cifras', () => {
    expect(isNumericColumn([{ n: 1 }, { n: null }, { n: 3 }], 'n')).toBe(true);
    expect(isNumericColumn([{ n: 1 }, { n: 'dos' }], 'n')).toBe(false);
    expect(isNumericColumn([{ n: null }], 'n')).toBe(false);
  });
});

describe('el pie', () => {
  it('dice cuántas hay cuando no caben todas', () => {
    expect(rowCountLabel(7, 50)).toBe('7 filas');
    expect(rowCountLabel(1, 50)).toBe('1 fila');
    expect(rowCountLabel(312, 50)).toBe('312 filas, se muestran 50');
  });
});

describe('los enlaces', () => {
  it('sólo abre http y https', () => {
    expect(isHttpUrl('https://github.com/cortex/web/pull/12')).toBe(true);
    expect(isHttpUrl('http://runt.gov.co')).toBe(true);
    // Una herramienta que leyó una página web devuelve lo que había en ella.
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('ABC123')).toBe(false);
    expect(isHttpUrl('ana@empresa.co')).toBe(false);
  });

  it('parte por el medio, que es donde no está el dato', () => {
    expect(shortUrl('https://www.runt.gov.co/consulta/')).toBe('runt.gov.co/consulta');
    const long = shortUrl(`https://github.com/${'a'.repeat(40)}/issues/1234`);
    expect(long).toContain('…');
    expect(long.endsWith('/issues/1234')).toBe(true);
  });
});

describe('las fechas', () => {
  it('no mueve un día de calendario al día anterior', () => {
    // El fallo que esta función existe para no cometer: `2026-09-14` pasado por
    // `new Date` y vuelto a formatear sale como el 13 para todo el que esté al
    // oeste de Bogotá.
    expect(formatDate('2026-09-14')).toBe('14 sep 2026');
  });

  it('lee un instante completo en la hora de Bogotá', () => {
    expect(formatDate('2026-09-15T02:00:00Z')).toBe('14 sep 2026');
  });

  it('devuelve tal cual lo que no entiende, nunca «Invalid Date»', () => {
    expect(formatDate('pendiente')).toBe('pendiente');
  });
});
