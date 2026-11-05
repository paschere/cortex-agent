import { cortex } from '@cortex/app-sdk';

/** CSV para Excel: UTF-8 con BOM, separador «;» (Excel en español) y comillas dobles. */
export function aCsv(columnas: string[], filas: (string | number | null | undefined)[][]): string {
  const celda = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columnas, ...filas].map((f) => f.map(celda).join(';')).join('\r\n');
}

/** Baja el CSV con la descarga del marco padre (el iframe no puede). */
export async function exportarCsv(
  nombre: string,
  columnas: string[],
  filas: (string | number | null | undefined)[][],
): Promise<void> {
  // El BOM va como primer carácter para que Excel lea las tildes.
  const blob = new Blob(['﻿', aCsv(columnas, filas)], { type: 'text/csv;charset=utf-8' });
  await cortex.ui.download(nombre.endsWith('.csv') ? nombre : `${nombre}.csv`, blob, 'text/csv;charset=utf-8');
}
