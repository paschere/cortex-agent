import { describe, expect, it } from 'vitest';
import { shapeProcesses } from './processes';
import { buildSetupSteps, setupProgress } from './setup';

describe('los cinco pasos del Inicio', () => {
  it('una empresa nueva tiene todo pendiente y el primer paso es contar el negocio', () => {
    const steps = buildSetupSteps({
      facts: 0,
      google: false,
      data: 0,
      processes: 0,
      views: 0,
      people: 1,
    });
    const p = setupProgress(steps);
    expect(p.ready).toBe(0);
    expect(p.next?.id).toBe('company');
    expect(p.complete).toBe(false);
  });

  it('una lectura caída deja el paso pendiente, nunca hecho', () => {
    const steps = buildSetupSteps({
      facts: null,
      google: null,
      data: null,
      processes: null,
      views: null,
      people: null,
    });
    expect(steps.every((s) => !s.ready)).toBe(true);
    expect(steps.find((s) => s.id === 'data')?.done).toBe('');
  });

  it('una vista cuenta como primer proceso, y el equipo pide al menos dos personas', () => {
    const steps = buildSetupSteps({
      facts: 4,
      google: true,
      data: 3,
      processes: 0,
      views: 1,
      people: 2,
    });
    const p = setupProgress(steps);
    expect(p.complete).toBe(true);
    expect(p.percent).toBe(100);
    expect(steps.find((s) => s.id === 'data')?.done).toBe('3 fuentes');
  });
});

describe('tus procesos', () => {
  it('aplana las tres clases y pone primero lo que falló', () => {
    const items = shapeProcesses({
      drive: [
        {
          id: 'd1',
          folder_name: 'Guías del socio',
          interval_minutes: 10,
          enabled: true,
          last_run_at: '2026-10-01T10:00:00Z',
          last_status: 'ok',
          last_error: null,
          trackers: { name: 'Guías' },
        },
      ],
      syncs: [
        {
          id: 's1',
          interval_minutes: 120,
          enabled: true,
          last_run_at: '2026-10-01T09:00:00Z',
          last_status: 'error',
          last_error: 'La hoja ya no existe',
          trackers: [{ name: 'Inventario' }],
          feed_sources: { name: 'Hoja de bodega' },
        },
      ],
      routines: [
        {
          id: 'r1',
          name: 'Resumen de la mañana',
          status: 'paused',
          next_run_at: null,
          last_run: null,
        },
      ],
    });
    expect(items.map((i) => i.id)).toEqual(['sync:s1', 'drive:d1', 'routine:r1']);
    expect(items[0]).toMatchObject({
      name: 'Hoja de bodega → Inventario',
      detail: 'Trae filas nuevas y cambios cada 2 horas',
      state: 'error',
    });
    expect(items[1]).toMatchObject({
      name: 'Guías del socio → Guías',
      detail: 'Lee los archivos nuevos cada 10 minutos',
      state: 'ok',
    });
    expect(items[2]?.state).toBe('paused');
  });
});
