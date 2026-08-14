import { GOAL_STATUSES, GOAL_STATUS_TONE } from '@/lib/goals-shape';
import * as tools from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';

/**
 * Las dos copias del veredicto de una meta, comparadas en Node.
 *
 * La del paquete la usan el cron y la pantalla de servidor; la del navegador la
 * usa la tarjeta del chat, que no puede importar un valor de `@cortex/agent-tools`
 * sin arrastrar `node:dns` al bundle. Ninguna de las dos se puede borrar, así que
 * lo que se prueba es que no se separen: una meta incumplida pintada de verde en
 * una superficie y de rojo en la otra es peor que no pintarla.
 */
describe('el veredicto de una meta se pinta igual en los dos lados', () => {
  it('tiene los mismos estados', () => {
    expect([...GOAL_STATUSES]).toEqual([...tools.READING_STATUSES]);
  });

  it('les da el mismo tono', () => {
    expect(GOAL_STATUS_TONE).toEqual(tools.GOAL_STATUS_TONE);
  });
});
