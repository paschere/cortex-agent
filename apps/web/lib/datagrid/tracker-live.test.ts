import type { GridRow } from '@/components/datagrid/types';
import { describe, expect, it } from 'vitest';
import {
  type ChangedRow,
  hasNewSince,
  mergeChanges,
  nextSince,
  parseAlerts,
  summarizeChanges,
} from './tracker-live';
import { UPDATED_KEY } from './trackers';

const row = (id: string, at: string, alert = false): GridRow => ({
  id,
  values: { guia: id, [UPDATED_KEY]: at },
  ...(alert ? { alert: true } : {}),
});
const change = (id: string, at: string, dup = false): ChangedRow => ({
  id,
  label: id,
  created_at: at,
  updated_at: at,
  duplicate_flagged: dup,
  values: { guia: id },
});

describe('mergeChanges', () => {
  const base = [row('a', '2026-10-05T10:00:00Z'), row('b', '2026-10-05T09:00:00Z')];

  it('pone las nuevas arriba y las cuenta', () => {
    const r = mergeChanges(base, [change('c', '2026-10-05T10:05:00Z')]);
    expect(r.rows.map((x) => x.id)).toEqual(['c', 'a', 'b']);
    expect(r).toMatchObject({ created: 1, changed: 0, fresh: ['c'] });
  });

  it('reemplaza en su sitio la que cambió', () => {
    const r = mergeChanges(base, [change('b', '2026-10-05T10:06:00Z')]);
    expect(r.rows.map((x) => x.id)).toEqual(['a', 'b']);
    expect(r.rows[1]?.values[UPDATED_KEY]).toBe('2026-10-05T10:06:00Z');
    expect(r).toMatchObject({ created: 0, changed: 1 });
  });

  it('el traslape no es novedad', () => {
    const r = mergeChanges(base, [change('a', '2026-10-05T10:00:00Z')]);
    expect(r.fresh).toEqual([]);
    expect(r.created + r.changed).toBe(0);
  });

  it('lo que escribió la propia persona se integra pero no avisa', () => {
    const r = mergeChanges(base, [change('c', '2026-10-05T10:05:00Z')], new Set(['c']));
    expect(r.rows).toHaveLength(3);
    expect(r.fresh).toEqual([]);
  });

  it('cuenta los duplicados que llegan marcados', () => {
    const r = mergeChanges(base, [
      change('c', '2026-10-05T10:05:00Z', true),
      change('a', '2026-10-05T10:07:00Z', true),
    ]);
    expect(r).toMatchObject({ created: 1, changed: 1, duplicates: 2 });
    expect(r.rows.find((x) => x.id === 'a')?.alert).toBe(true);
  });

  it('una fila que ya era duplicado y cambia no suma otro duplicado', () => {
    const cur = [row('a', '2026-10-05T10:00:00Z', true)];
    const r = mergeChanges(cur, [change('a', '2026-10-05T10:09:00Z', true)]);
    expect(r).toMatchObject({ changed: 1, duplicates: 0 });
  });
});

describe('summarizeChanges', () => {
  it('dice nuevas y duplicados aparte', () => {
    expect(summarizeChanges({ created: 2, changed: 0, duplicates: 1 }, 'Guías')).toBe(
      '2 filas nuevas en Guías · 1 marcada Duplicado',
    );
  });
  it('singular y plural', () => {
    expect(summarizeChanges({ created: 1, changed: 3, duplicates: 0 }, 'Guías')).toBe(
      '1 fila nueva y 3 filas cambiaron en Guías',
    );
    expect(summarizeChanges({ created: 0, changed: 1, duplicates: 2 }, 'Guías')).toBe(
      '1 fila cambió en Guías · 2 marcadas Duplicado',
    );
  });
  it('sin novedades no hay texto', () => {
    expect(summarizeChanges({ created: 0, changed: 0, duplicates: 0 }, 'Guías')).toBe('');
  });
});

describe('parseAlerts', () => {
  it('default: sólo titilar, sin notificación del sistema', () => {
    expect(parseAlerts(null)).toEqual({ mode: 'flash', system: false });
    expect(parseAlerts('no es json')).toEqual({ mode: 'flash', system: false });
    expect(parseAlerts('{"mode":"raro"}')).toEqual({ mode: 'flash', system: false });
  });
  it('lee lo guardado', () => {
    expect(parseAlerts('{"mode":"sound","system":true}')).toEqual({ mode: 'sound', system: true });
    expect(parseAlerts('{"mode":"off"}').mode).toBe('off');
  });
});

describe('nextSince y hasNewSince', () => {
  it('deja un traslape', () => {
    expect(nextSince('2026-10-05T10:00:10.000Z', 3000)).toBe('2026-10-05T10:00:07.000Z');
  });
  it('sin visita previa no hay punto nuevo', () => {
    expect(hasNewSince(null, '2026-10-05T10:00:00Z')).toBe(false);
    expect(hasNewSince('2026-10-05T09:00:00Z', '2026-10-05T10:00:00Z')).toBe(true);
    expect(hasNewSince('2026-10-05T11:00:00Z', '2026-10-05T10:00:00Z')).toBe(false);
  });
});
