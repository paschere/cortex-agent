import type { PlanItem } from '../autopilot/types';
import { closeHeadline } from './shape';

/**
 * EL PILOTO MIRA EL CIERRE DEL MES (0192) — la parte pura.
 *
 * Del día 1 al 5 de cada mes, mientras el mes anterior no esté cerrado:
 * «Cierre de septiembre: faltan 4 cosas», con cuáles. Es un AVISO (`tell`):
 * cerrar el mes y registrar en el programa contable siempre los decide una
 * persona. La lectura está en ./autopilot.ts; con el módulo «Cierre
 * contable» apagado no corre ninguna de las dos.
 */

export interface SnapshotClose {
  period: string;
  pending: number;
  total: number;
  /** Los títulos de lo que falta, en el orden de la lista. */
  missing: string[];
}

/** Los días del mes en que el piloto recuerda el cierre del anterior. */
export const CLOSE_REMINDER_DAYS = 5;

export function collectCierre(s: SnapshotClose | undefined, today: string): PlanItem[] {
  if (!s) return [];
  const shown = s.missing.slice(0, 4);
  return [
    {
      area: 'finanzas',
      title: closeHeadline(s.period, s.pending),
      why: s.pending
        ? `Van ${s.total - s.pending} de ${s.total}. Falta: ${shown.join('; ')}${s.missing.length > shown.length ? '…' : ''}. En /cierre está cada una con su arreglo.`
        : `Las ${s.total} tareas están listas: falta que un administrador lo cierre en /cierre.`,
      proposedAction: null,
      effect: null,
      risk: s.pending > 3 ? 'medium' : 'low',
      dedupeKey: `cierre:${s.period}:${today}`,
      href: `/cierre?mes=${s.period}`,
    },
  ];
}
