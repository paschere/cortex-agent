import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MetricUnavailableError, UnknownMetricError, metricByKey } from '../catalog';
import { judge, lastClosedPeriod, periodContaining, previousPeriod } from '../shape';
import {
  archiveGoal,
  claimGoalNotice,
  goalNoticesOwed,
  lastMeasuredStatus,
  listGoals,
  measureAndRecord,
  recordGoalReading,
  writeGoal,
} from '../store';
import { createGoalsWorld } from './fake-db';

const ORG = 'org-metas';
const ANA = 'user-ana';

/** Un mes cerrado cualquiera, para no depender del día en que corran los tests. */
const JULIO = periodContaining('month', '2026-07-15');

function seedWithFleet() {
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

describe('una lectura ya escrita no se recalcula', () => {
  it('el segundo intento del mismo período devuelve la fila que ya había, intacta', async () => {
    const world = seedWithFleet();

    const first = await recordGoalReading(world.db, {
      goalId: 'goal-1',
      period: JULIO,
      value: 50,
      display: '50%',
      unit: 'percent',
      sourceId: 'vehicles_runt',
      method: '1 de 2 vehículos con SOAT y tecnomecánica vigentes al 2026-07-31.',
      targetValue: 100,
      direction: 'higher_is_better',
      sampleSize: 2,
      status: 'breached',
    });
    expect(first.outcome).toBe('recorded');

    // Lo que pasa de verdad: al mes siguiente la flota está al día, el cron
    // vuelve a correr —porque reintenta, porque se redesplegó, porque el
    // dispatcher disparó dos veces— y trae OTRO número para el MISMO julio.
    const second = await recordGoalReading(world.db, {
      goalId: 'goal-1',
      period: JULIO,
      value: 100,
      display: '100%',
      unit: 'percent',
      sourceId: 'vehicles_runt',
      method: '2 de 2 vehículos con SOAT y tecnomecánica vigentes al 2026-07-31.',
      targetValue: 100,
      direction: 'higher_is_better',
      sampleSize: 2,
      status: 'met',
    });

    expect(second.outcome).toBe('frozen');
    // Julio sigue diciendo lo que dijo julio. Ni el número, ni el veredicto, ni
    // la frase que explica la aritmética se han movido.
    expect(second.reading.value).toBe(50);
    expect(second.reading.status).toBe('breached');
    expect(second.reading.method).toContain('1 de 2');
    // Y no hay dos filas: hay una.
    expect(world.tables.goal_readings).toHaveLength(1);
  });

  it('cambiar el objetivo mañana no reescribe el veredicto de julio', async () => {
    const world = seedWithFleet();
    await recordGoalReading(world.db, {
      goalId: 'goal-1',
      period: JULIO,
      value: 52,
      display: '52 d',
      unit: 'days',
      sourceId: 'receivables',
      method: 'Edad media ponderada de 8 facturas abiertas en COP al 2026-07-31.',
      targetValue: 45,
      direction: 'lower_is_better',
      sampleSize: 8,
      status: 'breached',
    });

    // El objetivo y la dirección viajan CON la lectura, no se leen de la meta.
    // Por eso subir la meta a 60 días no convierte julio en un mes cumplido.
    const row = (world.tables.goal_readings ?? [])[0] as Record<string, unknown>;
    expect(row.target_value).toBe(45);
    expect(row.direction).toBe('lower_is_better');
    expect(row.status).toBe('breached');
  });

  it('mide y congela en un paso, y el segundo paso no vuelve a medir', async () => {
    const world = seedWithFleet();
    const spec = metricByKey('fleet_current');
    if (!spec) throw new Error('la métrica de flota tiene que existir');

    const goal = await writeGoal(world.db, {
      metricKey: 'fleet_current',
      cadence: 'month',
      targetValue: 100,
      createdBy: ANA,
    });

    const first = await measureAndRecord(world.db, goal, JULIO, spec);
    expect(first.outcome).toBe('recorded');
    expect(first.reading.value).toBe(50);
    expect(first.reading.status).toBe('breached');

    // Se arregla el SOAT del segundo camión…
    const fleet = world.tables.vehicles as Array<Record<string, unknown>>;
    const stale = fleet.find((v) => v.plate === 'XYZ789');
    if (stale) stale.soat_expires_at = '2027-05-01';

    // …y julio sigue siendo julio.
    const second = await measureAndRecord(world.db, goal, JULIO, spec);
    expect(second.outcome).toBe('frozen');
    expect(second.reading.value).toBe(50);
    expect(world.tables.goal_readings).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('no se puede fijar una meta que este espacio no sabe medir', () => {
  it('writeGoal se niega aunque el selector se lo hubiera saltado', async () => {
    // Sin pagos: la cartera no es medible aquí, y la pantalla ni la ofrece.
    // Esto simula el formulario manipulado, o la métrica que dejó de estar
    // disponible entre que se abrió la pantalla y se pulsó el botón.
    const world = createGoalsWorld({}, ORG);
    await expect(
      writeGoal(world.db, {
        metricKey: 'receivables_days',
        cadence: 'month',
        targetValue: 45,
        createdBy: ANA,
      }),
    ).rejects.toBeInstanceOf(MetricUnavailableError);
    expect(world.tables.goals ?? []).toHaveLength(0);
  });

  it('una métrica que no existe en el catálogo no crea nada', async () => {
    const world = createGoalsWorld({}, ORG);
    await expect(
      writeGoal(world.db, {
        metricKey: 'margen_bruto',
        cadence: 'month',
        targetValue: 30,
        createdBy: ANA,
      }),
    ).rejects.toBeInstanceOf(UnknownMetricError);
  });

  it('copia dirección y unidad del catálogo, no de quien llama', async () => {
    const world = seedWithFleet();
    const goal = await writeGoal(world.db, {
      metricKey: 'fleet_current',
      label: '  ',
      cadence: 'month',
      targetValue: 100,
      createdBy: ANA,
    });
    expect(goal.direction).toBe('higher_is_better');
    expect(goal.unit).toBe('percent');
    // Etiqueta en blanco: se cae a la del catálogo en vez de guardar vacío.
    expect(goal.label).toBe('Flota al día');
    expect(goal.created_by).toBe(ANA);
  });

  it('no deja dos metas activas para la misma métrica y cadencia', async () => {
    const world = seedWithFleet();
    const input = {
      metricKey: 'fleet_current',
      cadence: 'month' as const,
      targetValue: 100,
      createdBy: ANA,
    };
    await writeGoal(world.db, input);
    await expect(writeGoal(world.db, input)).rejects.toThrow(/Ya hay una meta activa/);

    // Retirarla libera el sitio, y la retirada lleva nombre.
    const [existing] = await listGoals(world.db);
    if (!existing) throw new Error('debería haber una meta');
    const archived = await archiveGoal(world.db, existing.id, ANA);
    expect(archived.archived_by).toBe(ANA);
    await expect(writeGoal(world.db, input)).resolves.toBeTruthy();
  });

  it('rechaza un porcentaje fuera de escala y una meta sin autor', async () => {
    const world = seedWithFleet();
    await expect(
      writeGoal(world.db, {
        metricKey: 'fleet_current',
        cadence: 'month',
        targetValue: 140,
        createdBy: ANA,
      }),
    ).rejects.toThrow(/entre 0 y 100/);
    await expect(
      writeGoal(world.db, {
        metricKey: 'fleet_current',
        cadence: 'month',
        targetValue: 100,
        createdBy: '',
      }),
    ).rejects.toThrow(/quién la fijó/);
  });
});

// ---------------------------------------------------------------------------

describe('los avisos', () => {
  it('el mismo aviso reclamado dos veces sólo se manda una', async () => {
    const world = seedWithFleet();
    const claim = {
      goalId: 'goal-1',
      readingId: null,
      periodStart: JULIO.start,
      noticeClass: 'breached' as const,
      sentOn: '2026-08-01',
      recipientUserId: ANA,
      recipientEmail: 'ana@example.com',
    };
    const first = await claimGoalNotice(world.db, claim);
    const second = await claimGoalNotice(world.db, claim);
    expect(first.outcome).toBe('claimed');
    expect(second.outcome).toBe('taken');
    expect(world.tables.goal_notices).toHaveLength(1);
  });

  it('una recuperación es su propia clase y convive con el incumplimiento', async () => {
    const world = seedWithFleet();
    const base = {
      goalId: 'goal-1',
      readingId: null,
      periodStart: JULIO.start,
      sentOn: '2026-08-01',
      recipientUserId: ANA,
      recipientEmail: 'ana@example.com',
    };
    expect((await claimGoalNotice(world.db, { ...base, noticeClass: 'breached' })).outcome).toBe(
      'claimed',
    );
    expect((await claimGoalNotice(world.db, { ...base, noticeClass: 'recovered' })).outcome).toBe(
      'claimed',
    );
  });

  it('un período sin datos no debe ningún aviso, y tampoco corta una racha', () => {
    expect(goalNoticesOwed({ status: 'breached', previousStatus: null })).toEqual(['breached']);
    expect(goalNoticesOwed({ status: 'breached', previousStatus: 'breached' })).toEqual([
      'breached',
    ]);
    expect(goalNoticesOwed({ status: 'met', previousStatus: 'breached' })).toEqual(['recovered']);
    // Una meta recién fijada que cumple no ha recuperado nada.
    expect(goalNoticesOwed({ status: 'met', previousStatus: null })).toEqual([]);
    expect(goalNoticesOwed({ status: 'met', previousStatus: 'met' })).toEqual([]);
    // Sin datos: ni alarma ni celebración.
    expect(goalNoticesOwed({ status: 'unmeasurable', previousStatus: 'breached' })).toEqual([]);
  });

  it('lastMeasuredStatus salta los períodos sin datos', async () => {
    const world = seedWithFleet();
    const common = {
      goalId: 'goal-1',
      unit: 'percent' as const,
      sourceId: 'vehicles_runt',
      method: 'Método de prueba con la longitud que exige el CHECK de la 0101.',
      targetValue: 100,
      direction: 'higher_is_better' as const,
      sampleSize: 1,
    };
    await recordGoalReading(world.db, {
      ...common,
      period: periodContaining('month', '2026-06-10'),
      value: 40,
      display: '40%',
      status: 'breached',
    });
    await recordGoalReading(world.db, {
      ...common,
      period: JULIO,
      value: null,
      display: '—',
      status: 'unmeasurable',
    });

    const agosto = periodContaining('month', '2026-08-10');
    expect(await lastMeasuredStatus(world.db, 'goal-1', agosto.start)).toBe('breached');
    expect(goalNoticesOwed({ status: 'met', previousStatus: 'breached' })).toEqual(['recovered']);
  });
});

// ---------------------------------------------------------------------------

describe('períodos y veredictos', () => {
  it('el umbral es inclusivo por los dos lados', () => {
    expect(judge(45, 45, 'lower_is_better')).toBe('met');
    expect(judge(45.1, 45, 'lower_is_better')).toBe('breached');
    expect(judge(95, 95, 'higher_is_better')).toBe('met');
    expect(judge(94, 95, 'higher_is_better')).toBe('breached');
  });

  it('no medir no es incumplir', () => {
    expect(judge(null, 45, 'lower_is_better')).toBe('unmeasurable');
    expect(judge(Number.NaN, 45, 'lower_is_better')).toBe('unmeasurable');
    // Y medir cero sí es un número.
    expect(judge(0, 0, 'lower_is_better')).toBe('met');
  });

  it('los meses cierran el último día y las semanas van de lunes a domingo', () => {
    const febrero = periodContaining('month', '2028-02-11');
    expect(febrero.start).toBe('2028-02-01');
    expect(febrero.end).toBe('2028-02-29'); // bisiesto, y sin rodar a marzo
    expect(febrero.label).toBe('febrero de 2028');

    // 2026-08-13 es jueves.
    const semana = periodContaining('week', '2026-08-13');
    expect(semana.start).toBe('2026-08-10');
    expect(semana.end).toBe('2026-08-16');

    // Un domingo pertenece a la semana que empezó el lunes anterior, no a la
    // siguiente: `getUTCDay()` devuelve 0 y la aritmética ingenua lo mandaría
    // seis días hacia adelante.
    const domingo = periodContaining('week', '2026-08-16');
    expect(domingo.start).toBe('2026-08-10');
  });

  it('sólo se congela lo que ya cerró', () => {
    expect(lastClosedPeriod('month', '2026-08-13').start).toBe('2026-07-01');
    expect(lastClosedPeriod('month', '2026-01-04').start).toBe('2025-12-01');
    expect(lastClosedPeriod('week', '2026-08-13').start).toBe('2026-08-03');
    expect(previousPeriod(JULIO).start).toBe('2026-06-01');
  });
});

// ---------------------------------------------------------------------------

describe('la congelación también está en los permisos, no sólo en el código', () => {
  const sql = readFileSync(
    fileURLToPath(
      new URL('../../../../../infra/supabase/migrations/0101_goals.sql', import.meta.url),
    ),
    'utf8',
  );

  /**
   * EL FALLO QUE ESTE TEST EXISTE PARA CAZAR, Y QUE YA OCURRIÓ AQUÍ.
   *
   * Supabase deja puesto un `alter default privileges ... grant all on tables
   * to service_role`, así que toda tabla nueva NACE con UPDATE concedido. Un
   * `grant select, insert, delete` que simplemente omite el verbo se lee como
   * una restricción en el diff y no lo es: contra la base local, sin el revoke,
   * `set role service_role; update public.goal_readings ...` devolvía UPDATE 1.
   *
   * Conceder de menos no es revocar. Esta línea es la garantía entera.
   */
  it('nadie puede actualizar una lectura, ni siquiera service_role', () => {
    expect(sql).toMatch(
      /revoke\s+update\s+on\s+table\s+public\.goal_readings\s+from\s+service_role/i,
    );
    expect(sql).not.toMatch(/grant[^;]*update[^;]*on\s+table\s+public\.goal_readings/i);
  });

  it('las tres tablas llevan organization_id NOT NULL desde la primera línea', () => {
    for (const table of ['goals', 'goal_readings', 'goal_notices']) {
      const body = sql.slice(sql.indexOf(`create table if not exists public.${table} (`));
      expect(body.slice(0, 400)).toMatch(/organization_id\s+text\s+not null/);
    }
  });

  it('una meta no puede existir sin quien la fijó', () => {
    expect(sql).toMatch(/created_by\s+uuid\s+not null references public\.users\(id\)/);
  });
});
