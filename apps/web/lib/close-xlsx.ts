import { type XlsxSheet, buildXlsx, xlsxFileName } from '@/lib/xlsx/write';
import type { ClosePdfInput } from '@cortex/agent-tools';

/**
 * EL INFORME DEL CIERRE EN EXCEL, PARA EL CONTADOR (0228). Puro.
 *
 * La misma información que el PDF (`close/pdf.ts`) en una hoja que se puede
 * filtrar y sumar: el resumen del mes, la lista con su estado, detalle,
 * responsable y evidencia, y lo que Cortex registró en el programa contable.
 * Un mes cerrado sale con la foto que se guardó al cerrarlo.
 */

const STATUS_LABEL = { abierto: 'Abierto', en_cierre: 'En cierre', cerrado: 'Cerrado' } as const;

function taskState(t: ClosePdfInput['tasks'][number]): string {
  if (t.status === 'hecha') return 'Hecha';
  if (t.status === 'no_aplica') return 'No aplica';
  return t.ready ? 'Al día (revisión automática)' : 'Pendiente';
}

function whenBogota(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(Date.parse(iso) - 5 * 3_600_000);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' ');
}

export function closeSheet(input: ClosePdfInput): XlsxSheet {
  const rows: unknown[][] = [];
  const add = (
    section: string,
    concept: string,
    state = '',
    detail = '',
    owner = '',
    evidence = '',
    count: number | null = null,
    value: number | null = null,
  ) => rows.push([section, concept, state, detail, owner, evidence, count, value]);

  add('Resumen', 'Mes', input.label);
  add(
    'Resumen',
    'Estado del cierre',
    STATUS_LABEL[input.status],
    input.status === 'cerrado'
      ? `Cerrado el ${whenBogota(input.closedAt)}${input.closedByName ? ` por ${input.closedByName}` : ''}`
      : 'Revisión de este momento: el mes sigue abierto',
  );
  add(
    'Resumen',
    'Avance de la lista',
    `${input.progress.done} de ${input.progress.total}`,
    '',
    '',
    '',
    input.progress.done,
  );
  if (input.note) add('Resumen', 'Nota del cierre', '', input.note);
  add('Resumen', 'Generado', whenBogota(input.generatedAt), 'Hora de Bogotá');

  for (const t of input.tasks)
    add(
      'Lista del cierre',
      t.title,
      taskState(t),
      t.detail,
      t.ownerName ?? '',
      [t.evidence, t.doneByName ? `(${t.doneByName})` : ''].filter(Boolean).join(' '),
    );

  for (const w of input.writebacks)
    add(
      'Registrado en el programa contable',
      `${w.label}${input.providerName ? ` · ${input.providerName}` : ''}`,
      '',
      '',
      '',
      '',
      w.count,
      w.amount,
    );

  return {
    name: 'Cierre',
    columns: [
      { header: 'Sección', type: 'text', width: 30 },
      { header: 'Concepto', type: 'text', width: 58 },
      { header: 'Estado', type: 'text', width: 26 },
      { header: 'Detalle de la revisión', type: 'text', width: 70 },
      { header: 'Responsable', type: 'text', width: 22 },
      { header: 'Evidencia', type: 'text', width: 60 },
      { header: 'Cantidad', type: 'number', width: 11 },
      { header: 'Valor', type: 'money', width: 18 },
    ],
    rows,
  };
}

export function closeWorkbook(input: ClosePdfInput): { bytes: Uint8Array; fileName: string } {
  return {
    bytes: buildXlsx(closeSheet(input)),
    fileName: xlsxFileName(`Cierre ${input.label}`),
  };
}
