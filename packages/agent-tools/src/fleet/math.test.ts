import { describe, expect, it } from 'vitest';
import {
  type FuelLogFacts,
  type TripFacts,
  fuelReport,
  maintenanceDue,
  tripCost,
  tripKm,
  utilization,
  vehicleCostPerKm,
} from './math';

const TODAY = '2026-10-03';

describe('mantenimiento que toca por km o por tiempo', () => {
  const oil = { task: 'Cambio de aceite', everyKm: 5000, everyDays: 180 };

  it('por km: al día, pronto (10 % del intervalo, mínimo 300) y vencido', () => {
    const at = (odo: number) =>
      maintenanceDue({ ...oil, everyDays: null, lastDoneKm: 40_000, lastDoneOn: null }, odo, TODAY);
    expect(at(43_000)).toMatchObject({ status: 'al_dia', nextKm: 45_000, kmLeft: 2000 });
    expect(at(44_600).status).toBe('pronto');
    expect(at(45_200)).toMatchObject({ status: 'vencido', kmLeft: -200 });
    expect(at(45_200).reason).toContain('Se pasó por 200 km');
  });

  it('por tiempo: cuenta días desde la última vez', () => {
    const plan = { ...oil, everyKm: null, lastDoneKm: null, lastDoneOn: '2026-04-01' };
    const due = maintenanceDue(plan, null, TODAY);
    expect(due.nextOn).toBe('2026-09-28');
    expect(due.status).toBe('vencido');
    expect(due.daysLeft).toBe(-5);
    expect(maintenanceDue({ ...plan, lastDoneOn: '2026-04-15' }, null, TODAY).status).toBe(
      'pronto',
    );
  });

  it('con las dos reglas, manda la que vence primero', () => {
    const due = maintenanceDue(
      { ...oil, lastDoneKm: 40_000, lastDoneOn: '2026-03-01' },
      41_000,
      TODAY,
    );
    expect(due.status).toBe('vencido');
    expect(due.reason).toContain('días');
    expect(due.kmLeft).toBe(4000);
  });

  it('sin último registro no inventa una fecha', () => {
    const due = maintenanceDue({ ...oil, lastDoneKm: null, lastDoneOn: null }, 50_000, TODAY);
    expect(due.status).toBe('sin_base');
    expect(due.nextKm).toBeNull();
  });
});

describe('rendimiento de combustible y consumo raro', () => {
  const log = (id: string, filledOn: string, km: number | null, gallons: number, full = true) =>
    ({
      id,
      filledOn,
      odometerKm: km,
      gallons,
      amount: gallons * 15_000,
      fullTank: full,
    }) satisfies FuelLogFacts;

  it('mide km/gal entre tanques llenos y suma los parciales al tramo', () => {
    const r = fuelReport([
      log('a', '2026-09-01', 10_000, 10),
      log('b', '2026-09-05', 10_200, 4, false),
      log('c', '2026-09-08', 10_400, 6),
    ]);
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]).toMatchObject({ km: 400, gallons: 10, kmPerGallon: 40, costPerKm: 375 });
  });

  it('marca el tramo que rinde 25 % menos que la mediana del mismo vehículo', () => {
    const r = fuelReport([
      log('a', '2026-09-01', 10_000, 10),
      log('b', '2026-09-05', 10_400, 10), // 40
      log('c', '2026-09-09', 10_800, 10), // 40
      log('d', '2026-09-13', 11_190, 10), // 39
      log('e', '2026-09-17', 11_440, 10), // 25 ← raro
    ]);
    expect(r.medianKmPerGallon).toBe(39.5);
    const raro = r.anomalies.filter((x) => x.kind === 'rendimiento_bajo');
    expect(raro.map((x) => x.logId)).toEqual(['e']);
    expect(raro[0]?.message).toContain('25 km/gal');
  });

  it('con pocos tramos no hay con qué comparar y no acusa', () => {
    const r = fuelReport([
      log('a', '2026-09-01', 10_000, 10),
      log('b', '2026-09-05', 10_400, 10),
      log('c', '2026-09-09', 10_500, 10),
    ]);
    expect(r.anomalies).toEqual([]);
  });

  it('un odómetro que retrocede y más galones que el tanque son anomalías', () => {
    const r = fuelReport(
      [
        log('a', '2026-09-01', 10_000, 10),
        log('b', '2026-09-05', 9_000, 30),
        log('c', '2026-09-09', null, 5),
      ],
      { tankGallons: 20 },
    );
    expect(r.anomalies.map((x) => x.kind).sort()).toEqual(['excede_tanque', 'odometro_atras']);
    expect(r.withoutOdometer).toBe(1);
    expect(r.segments).toEqual([]);
  });
});

describe('costo por km y costo de un recorrido', () => {
  const trip = (over: Partial<TripFacts> = {}): TripFacts => ({
    tripOn: '2026-09-10',
    vehicleId: 'v1',
    status: 'completado',
    km: null,
    startKm: null,
    endKm: null,
    plannedKm: null,
    tolls: 0,
    otherCosts: 0,
    ...over,
  });

  it('km de un recorrido: reales, odómetro o planeados', () => {
    expect(tripKm(trip({ km: 120 }))).toEqual({ km: 120, from: 'real' });
    expect(tripKm(trip({ startKm: 1000, endKm: 1180.5 }))).toEqual({ km: 180.5, from: 'odometro' });
    expect(tripKm(trip({ plannedKm: 90 }))).toEqual({ km: 90, from: 'planeado' });
    expect(tripKm(trip())).toEqual({ km: null, from: 'ninguno' });
  });

  it('costo por km = (combustible + mantenimiento + peajes y viáticos) / km recorridos', () => {
    const c = vehicleCostPerKm({
      fuelAmount: 1_200_000,
      maintenanceAmount: 300_000,
      trips: [
        trip({ km: 400, tolls: 60_000, otherCosts: 40_000 }),
        trip({ km: 600 }),
        trip({ km: 999, status: 'cancelado', tolls: 1_000_000 }),
      ],
      odometerReadings: [],
    });
    expect(c).toMatchObject({ km: 1000, total: 1_600_000, perKm: 1600, kmFrom: 'recorridos' });
  });

  it('sin recorridos usa el odómetro; sin km no hay costo por km', () => {
    expect(
      vehicleCostPerKm({
        fuelAmount: 500_000,
        maintenanceAmount: 0,
        trips: [],
        odometerReadings: [20_000, 20_500, 21_000],
      }),
    ).toMatchObject({ km: 1000, perKm: 500, kmFrom: 'odometro' });
    expect(
      vehicleCostPerKm({ fuelAmount: 1, maintenanceAmount: 0, trips: [], odometerReadings: [] })
        .perKm,
    ).toBeNull();
  });

  it('pocos recorridos registrados no inflan el costo: manda el odómetro si avanzó más', () => {
    const c = vehicleCostPerKm({
      fuelAmount: 1_000_000,
      maintenanceAmount: 0,
      trips: [trip({ km: 30 })],
      odometerReadings: [59_800, 60_850],
    });
    expect(c).toMatchObject({ km: 1050, kmFrom: 'odometro' });
    expect(c.perKm).toBeCloseTo(952.38, 1);
  });

  it('el costo de un recorrido suma su parte de la operación y sus gastos directos', () => {
    expect(tripCost({ ...trip({ km: 250, tolls: 45_000, otherCosts: 20_000 }) }, 1600)).toEqual({
      km: 250,
      running: 400_000,
      direct: 65_000,
      total: 465_000,
    });
    expect(tripCost(trip({ km: 250 }), null).total).toBeNull();
  });
});

describe('utilización', () => {
  it('días con recorrido sobre días hábiles (lunes a sábado)', () => {
    const u = utilization(
      ['2026-09-28', '2026-09-28', '2026-09-30', '2026-10-04'],
      '2026-09-28',
      '2026-10-04',
    );
    expect(u.workingDays).toBe(6);
    expect(u.daysUsed).toBe(2); // el domingo no cuenta
    expect(u.pct).toBe(33.3);
  });
});
