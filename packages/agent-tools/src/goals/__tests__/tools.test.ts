import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../../types';
import { METRIC_CATALOG, metricByKey } from '../catalog';
import { lastClosedPeriod, periodContaining } from '../shape';
import { measureAndRecord, writeGoal } from '../store';
import { goalsList, goalsMeasure, goalsOfferMetrics, goalsSet } from '../tools';
import { createGoalsWorld } from './fake-db';

/**
 * LAS CUATRO HERRAMIENTAS NO PUEDEN TENER OPINIONES PROPIAS.
 *
 * Todo lo que importa de este módulo ya está probado en `catalog.test.ts` y
 * `store.test.ts`. Lo que se comprueba aquí es lo único que las herramientas
 * podrían romper: que dejan hablar al motor en vez de contestar por él.
 *
 *   · que el rechazo que llega al chat es LA FRASE DEL CATÁLOGO, no una nueva;
 *   · que lo que no se puede medir NO desaparece de la respuesta;
 *   · que la cifra que devuelve `goals.list` es la CONGELADA, juzgada contra el
 *     objetivo de entonces y no contra el de hoy;
 *   · que `goals.measure` no escribe una sola fila.
 *
 * Se llama al `handler` directamente: `runTool` añade auditoría, límites y la
 * barrera de seguridad, que tienen sus propias pruebas y necesitan medio
 * esquema más. Lo que se ejercita aquí es el trabajo.
 */

const ORG = 'org-metas';
const ANA = 'user-ana';

function ctxFor(db: SupabaseClient): ToolContext {
  return {
    organizationId: ORG,
    userId: ANA,
    agentId: 'agent-1',
    db,
    integrations: {
      getAccessToken: async () => ({ token: '', scopes: [] }),
      hasScopes: async () => true,
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} } as unknown as ToolContext['logger'],
  };
}

/** Una flota registrada y NADA más: sólo `fleet_current` se puede medir aquí. */
function worldWithFleet() {
  return createGoalsWorld(
    {
      vehicles: [
        {
          id: 'veh-1',
          organization_id: ORG,
          plate: 'ABC123',
          archived: false,
          soat_expires_at: '2027-01-01',
          rtm_expires_at: '2027-01-01',
          last_runt_sync: '2026-08-01T10:00:00Z',
        },
        {
          id: 'veh-2',
          organization_id: ORG,
          plate: 'XYZ789',
          archived: false,
          soat_expires_at: '2026-02-01',
          rtm_expires_at: '2027-01-01',
          last_runt_sync: '2026-08-01T10:00:00Z',
        },
      ],
    },
    ORG,
  );
}

// ---------------------------------------------------------------------------

describe('goals.offer_metrics', () => {
  it('no esconde lo que no se puede medir: lo devuelve con el motivo del catálogo', async () => {
    const world = worldWithFleet();
    const out = await goalsOfferMetrics.handler({}, ctxFor(world.db));

    // El catálogo entero, no sólo lo disponible. Esconder una métrica dejaría a
    // alguien buscando una función que sí existe.
    expect(out.metrics).toHaveLength(METRIC_CATALOG.length);

    const fleet = out.metrics.find((m) => m.key === 'fleet_current');
    expect(fleet?.available).toBe(true);
    expect(fleet?.reason).toBeNull();
    expect(out.availableCount).toBe(1);

    // Y el porqué es el del motor, palabra por palabra: aquí no se redacta un
    // segundo mensaje para lo mismo.
    const cartera = out.metrics.find((m) => m.key === 'receivables_days');
    expect(cartera?.available).toBe(false);
    expect(cartera?.reason).toContain('todavía no hay ni un pago registrado');
  });
});

// ---------------------------------------------------------------------------

describe('goals.set', () => {
  it('se niega con la frase del motor y no deja una meta a medio crear', async () => {
    const world = createGoalsWorld({}, ORG);
    await expect(
      goalsSet.handler(
        { metricKey: 'receivables_days', cadence: 'month', targetValue: 45, label: null },
        ctxFor(world.db),
      ),
    ).rejects.toThrow(/Conecta Siigo o el banco/);
    expect(world.tables.goals ?? []).toHaveLength(0);
  });

  it('fija la meta con el nombre de quien la fijó y la dirección del catálogo', async () => {
    const world = worldWithFleet();
    const out = await goalsSet.handler(
      { metricKey: 'fleet_current', cadence: 'month', targetValue: 100, label: null },
      ctxFor(world.db),
    );

    expect(out.goal.label).toBe('Flota al día');
    // «al menos 100%», no «no pasar de»: la dirección la pone el catálogo y no
    // hay parámetro con el que invertirla.
    expect(out.goal.targetLabel).toBe('al menos 100%');
    expect(out.goal.latest).toBeNull();
    expect(out.guidance).toContain('No se rellena hacia atrás');
    expect(world.tables.goals ?? []).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('goals.list', () => {
  it('devuelve la lectura congelada, juzgada contra el objetivo de ENTONCES', async () => {
    const world = worldWithFleet();
    const spec = metricByKey('fleet_current');
    if (!spec) throw new Error('la métrica debería existir');

    const goal = await writeGoal(world.db, {
      metricKey: 'fleet_current',
      cadence: 'month',
      targetValue: 100,
      createdBy: ANA,
    });
    const closed = lastClosedPeriod('month');
    const recorded = await measureAndRecord(world.db, goal, closed, spec);
    expect(recorded.reading.status).toBe('breached'); // uno de dos camiones

    // Alguien baja el listón HOY. El veredicto del período ya cerrado no se
    // toca: se juzgó contra el objetivo que la meta tenía ese día.
    const row = (world.tables.goals ?? []).find((r) => r.id === goal.id);
    if (!row) throw new Error('la meta debería estar en la tabla');
    row.target_value = 50;

    const out = await goalsList.handler(
      { state: 'active', metricKey: null, limit: 20 },
      ctxFor(world.db),
    );
    const [view] = out.goals;
    expect(out.goals).toHaveLength(1);
    expect(view?.targetLabel).toBe('al menos 50%');
    expect(view?.latest?.judgedAgainst).toBe('al menos 100%');
    expect(view?.latest?.status).toBe('breached');
    expect(view?.latest?.periodLabel).toBe(closed.label);
    // El método viaja entero: una cifra sin él es una afirmación.
    expect(view?.latest?.method).toContain('SOAT y tecnomecánica');
    expect(out.breached).toBe(1);
  });

  it('sin metas fijadas dice dónde se fija una, en vez de devolver una lista vacía', async () => {
    const world = createGoalsWorld({}, ORG);
    const out = await goalsList.handler(
      { state: 'active', metricKey: null, limit: 20 },
      ctxFor(world.db),
    );
    expect(out.goals).toEqual([]);
    expect(out.guidance).toContain('goals.set');
  });
});

// ---------------------------------------------------------------------------

describe('goals.measure', () => {
  it('mide el período en curso y NO escribe ni una fila', async () => {
    const world = worldWithFleet();
    await writeGoal(world.db, {
      metricKey: 'fleet_current',
      cadence: 'month',
      targetValue: 100,
      createdBy: ANA,
    });

    const out = await goalsMeasure.handler({ goalId: null }, ctxFor(world.db));
    const [live] = out.readings;
    expect(out.readings).toHaveLength(1);
    expect(live?.periodLabel).toBe(
      periodContaining('month', new Date().toISOString().slice(0, 10)).label,
    );
    expect(live?.display).toBe('50%');
    expect(live?.status).toBe('breached');

    // Lo que hace que esta lectura sea honesta: en el momento en que se
    // guardara, sería un marcador que cambia cada mañana.
    expect(world.tables.goal_readings ?? []).toHaveLength(0);
    expect(out.guidance).toContain('EN VIVO');
  });
});
