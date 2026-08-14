import type { StatusTone } from './status-chip';

/**
 * LA COPIA DEL NAVEGADOR DEL VEREDICTO DE UNA META.
 *
 * Existe por lo mismo que `approvals-shape.ts`, `actions-shape.ts` y
 * `commitments-shape.ts`: importar un VALOR de `@cortex/agent-tools` desde un
 * componente `'use client'` arrastra `node:dns` al bundle y rompe el build de
 * producción mientras el typecheck y las pruebas siguen en verde. Los TIPOS sí
 * viajan —se borran al compilar—, así que aquí sólo se copia lo que es dato.
 *
 * Y se copia LO MÍNIMO: el color. La etiqueta («Cumplida», «Incumplida», «Sin
 * datos») y la cifra ya llegan escritas desde el servidor, y el veredicto lo
 * decidió `judge` cuando la lectura se congeló. Lo único que un componente de
 * cliente sigue necesitando decidir es de qué color se pinta.
 *
 * `lib/goals-parity.test.ts` importa las dos copias en Node y falla en cuanto
 * discrepan. Sin esa prueba esto no sería una copia, sería una segunda fuente.
 */

/** El veredicto de un período. `unmeasurable` es un hueco, no un incumplimiento. */
export const GOAL_STATUSES = ['met', 'breached', 'unmeasurable'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_STATUS_TONE: Record<GoalStatus, StatusTone> = {
  met: 'emerald',
  breached: 'rose',
  unmeasurable: 'neutral',
};
