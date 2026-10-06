import { describe, expect, it } from 'vitest';
import { syncPatchSchema, updateDriveFolderSync, updateTrackerSync } from './settings';

describe('syncPatchSchema', () => {
  it('acepta 5 a 1440 minutos y nada más', () => {
    expect(syncPatchSchema.safeParse({ intervalMinutes: 5 }).success).toBe(true);
    expect(syncPatchSchema.safeParse({ intervalMinutes: 1440 }).success).toBe(true);
    expect(syncPatchSchema.safeParse({ intervalMinutes: 4 }).success).toBe(false);
    expect(syncPatchSchema.safeParse({ intervalMinutes: 1441 }).success).toBe(false);
    expect(syncPatchSchema.safeParse({ intervalMinutes: 7.5 }).success).toBe(false);
  });
  it('rechaza campos que no son ajustes (no se cuela tracker_id, mapping…)', () => {
    expect(syncPatchSchema.safeParse({ trackerId: 'x' }).success).toBe(false);
    expect(syncPatchSchema.safeParse({ mapping: {} }).success).toBe(false);
  });
});

describe('updateSync validaciones previas a la base', () => {
  const db = {} as never;
  it('una clave que la tabla no tiene se rechaza antes de escribir', async () => {
    await expect(
      updateTrackerSync(db, 's1', { keyFields: ['fantasma'] }, ['guia']),
    ).rejects.toThrow(/no tiene/);
  });
  it('sin columnas clave se rechaza', async () => {
    await expect(updateTrackerSync(db, 's1', { keyFields: [] }, ['guia'])).rejects.toThrow(
      /al menos una columna clave/,
    );
  });
  it('instrucciones sólo en Drive', async () => {
    await expect(updateTrackerSync(db, 's1', { instructions: 'x' }, ['guia'])).rejects.toThrow(
      /Drive/,
    );
  });
  it('minutos fuera de rango', async () => {
    await expect(updateDriveFolderSync(db, 's1', { intervalMinutes: 2 }, [])).rejects.toThrow(
      /mínimo/,
    );
  });
});
