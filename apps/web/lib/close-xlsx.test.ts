import { describe, expect, it } from 'vitest';
import { closeSheet, closeWorkbook } from './close-xlsx';

const input = {
  label: 'Septiembre de 2026',
  status: 'cerrado' as const,
  closedAt: '2026-10-03T15:30:00Z',
  closedByName: 'Ana Gómez',
  note: 'Cierre con la contadora',
  progress: { done: 2, total: 3 },
  tasks: [
    {
      title: 'Extractos importados',
      status: 'pendiente' as const,
      ready: true,
      detail: '2 cuentas con extracto hasta fin de mes.',
      evidence: null,
      doneByName: null,
      ownerName: 'Luis',
    },
    {
      title: 'Movimientos inusuales revisados',
      status: 'hecha' as const,
      ready: true,
      detail: '1 cosa fuera de lo normal',
      evidence: 'El pago de $ 6,8 M es el mantenimiento anual',
      doneByName: 'Ana Gómez',
    },
    {
      title: 'Facturas causadas',
      status: 'pendiente' as const,
      ready: false,
      detail: '3 facturas aprobadas sin causar.',
      evidence: null,
      doneByName: null,
    },
  ],
  writebacks: [{ label: 'Compras causadas', count: 4, amount: 12_500_000 }],
  providerName: 'Siigo',
  generatedAt: '2026-10-03T16:00:00Z',
};

describe('informe del cierre en Excel', () => {
  const sheet = closeSheet(input);
  const col = (name: string) => sheet.columns.findIndex((c) => c.header === name);

  it('una fila por tarea con su estado, detalle, responsable y evidencia', () => {
    const lista = sheet.rows.filter((r) => r[0] === 'Lista del cierre');
    expect(lista).toHaveLength(3);
    expect(lista[0]?.[col('Estado')]).toBe('Al día (revisión automática)');
    expect(lista[0]?.[col('Responsable')]).toBe('Luis');
    expect(lista[1]?.[col('Estado')]).toBe('Hecha');
    expect(lista[1]?.[col('Evidencia')]).toContain('mantenimiento anual (Ana Gómez)');
    expect(lista[2]?.[col('Estado')]).toBe('Pendiente');
  });

  it('el resumen dice quién cerró, cuándo (hora de Bogotá) y el avance', () => {
    const resumen = sheet.rows.filter((r) => r[0] === 'Resumen');
    const estado = resumen.find((r) => r[1] === 'Estado del cierre');
    expect(estado?.[col('Estado')]).toBe('Cerrado');
    expect(estado?.[col('Detalle de la revisión')]).toBe(
      'Cerrado el 2026-10-03 10:30 por Ana Gómez',
    );
    expect(resumen.find((r) => r[1] === 'Avance de la lista')?.[col('Estado')]).toBe('2 de 3');
  });

  it('lo registrado en el programa va con cantidad y valor en pesos', () => {
    const wb = sheet.rows.find((r) => r[0] === 'Registrado en el programa contable');
    expect(wb?.[1]).toBe('Compras causadas · Siigo');
    expect(wb?.[col('Cantidad')]).toBe(4);
    expect(wb?.[col('Valor')]).toBe(12_500_000);
    expect(sheet.columns[col('Valor')]?.type).toBe('money');
  });

  it('un mes abierto lo dice, y el archivo es un .xlsx real', () => {
    const open = closeSheet({ ...input, status: 'en_cierre', closedAt: null, closedByName: null });
    const estado = open.rows.find((r) => r[1] === 'Estado del cierre');
    expect(estado?.[3]).toContain('sigue abierto');
    const { bytes, fileName } = closeWorkbook(input);
    expect(fileName).toBe('cierre-septiembre-de-2026.xlsx');
    expect(String.fromCharCode(bytes[0] as number, bytes[1] as number)).toBe('PK');
  });
});
