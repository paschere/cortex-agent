import type { XlsxColumn, XlsxSheet } from './write';

/**
 * LA TABLA DEL CHAT YA VIENE EN TEXTO («sin formato de moneda»); para Excel se
 * recupera el tipo mirando la columna entera: todo número → número (y dinero si
 * el encabezado habla de plata), todo `YYYY-MM-DD` → fecha. Una columna con
 * ceros a la izquierda o cifras larguísimas (NIT, teléfonos, cuentas) se queda
 * como texto: Excel las estropearía.
 */

const MONEY_HEADER =
  /(monto|valor|total|saldo|precio|costo|coste|deuda|pagar|cobrar|cartera|ingreso|gasto|venta|neto|bruto|iva|pesos|\$)/i;
const ID_HEADER =
  /(nit|c[eé]dula|tel[eé]fono|celular|cuenta|documento|c[oó]digo|id\b|n[uú]mero de)/i;

/** Un número como lo manda una máquina o lo escribe una persona en Colombia; `null` si no es. */
export function plainNumber(raw: string): number | null {
  const s = raw.trim().replace(/^\$\s*/, '');
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // 1.250.000 / 1.250.000,50
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) return Number(s.replace(/\./g, '').replace(',', '.'));
  // 1250000,5
  if (/^-?\d+,\d+$/.test(s)) return Number(s.replace(',', '.'));
  return null;
}

export function inferSheet(name: string, headers: string[], rows: string[][]): XlsxSheet {
  const columns: XlsxColumn[] = headers.map((header, i) => {
    const cells = rows.map((r) => (r[i] ?? '').trim()).filter((c) => c !== '');
    if (cells.length === 0) return { header, type: 'text' };
    if (cells.every((c) => /^\d{4}-\d{2}-\d{2}$/.test(c))) return { header, type: 'date' };
    const keepText =
      ID_HEADER.test(header) ||
      cells.some((c) => /^0\d/.test(c) || c.replace(/\D/g, '').length > 15);
    if (!keepText && cells.every((c) => plainNumber(c) !== null)) {
      return { header, type: MONEY_HEADER.test(header) ? 'money' : 'number', currency: 'COP' };
    }
    return { header, type: 'text' };
  });
  const body = rows.map((r) =>
    columns.map((c, i) => {
      const cell = (r[i] ?? '').trim();
      if (cell === '') return null;
      return c.type === 'number' || c.type === 'money' ? plainNumber(cell) : cell;
    }),
  );
  return { name, columns, rows: body };
}
