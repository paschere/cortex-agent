import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { computedProblems } from './computed';
import { nitKeys } from '../views/store';
import { prepareValues } from './store';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TARIFAS = { id: ID(900), slug: 'tarifas', name: 'Tarifas' };
const CLIENTES = { id: ID(901), slug: 'clientes', name: 'Clientes' };

const tarifaFields = [
  { key: 'nombre', label: 'Nombre', type: 'text' },
  { key: 'tarifa_usd_kg', label: 'Tarifa USD/kg', type: 'number' },
];
const clienteFields = [
  { key: 'nombre', label: 'Nombre', type: 'text' },
  { key: 'tarifa', label: 'Tarifa', type: 'relation', tracker: 'tarifas' },
];
const rows: Record<string, { tracker_id: string; label: string; values: Record<string, unknown> }> = {
  [ID(1)]: { tracker_id: CLIENTES.id, label: 'Aero', values: { tarifa: JSON.stringify({ id: ID(11), label: 'Alta' }) } },
  [ID(2)]: { tracker_id: CLIENTES.id, label: 'Sin tarifa', values: {} },
  [ID(11)]: { tracker_id: TARIFAS.id, label: 'Alta', values: { tarifa_usd_kg: 0.12 } },
  [ID(12)]: { tracker_id: TARIFAS.id, label: 'Baja', values: { tarifa_usd_kg: 0.05 } },
};

/** Una base de mentira con lo justo para `prepareValues`. */
function fakeDb(): SupabaseClient {
  const trackers: Record<string, unknown> = {
    tarifas: { ...TARIFAS, fields: tarifaFields, created_at: 'x', updated_at: 'x' },
    clientes: { ...CLIENTES, fields: clienteFields, created_at: 'x', updated_at: 'x' },
  };
  return {
    from(table: string) {
      const f: Record<string, string> = {};
      const q = {
        select: () => q,
        eq: (k: string, v: string) => ((f[k] = v), q),
        maybeSingle: async () => {
          if (table === 'trackers') return { data: trackers[f.slug as string] ?? null, error: null };
          const r = rows[f.id as string];
          const ok = r && (!f.tracker_id || r.tracker_id === f.tracker_id);
          return { data: ok ? { id: f.id, label: r.label, values: r.values } : null, error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const fields = [
  { key: 'cliente', label: 'Cliente', type: 'relation', tracker: 'clientes' },
  {
    key: 'tarifa',
    label: 'Tarifa',
    type: 'relation',
    tracker: 'tarifas',
    lookup: { via: 'cliente', field: 'tarifa', editable: true },
  },
  { key: 'kilos', label: 'Kilos', type: 'number' },
  {
    key: 'tarifa_usd',
    label: 'Tarifa USD',
    type: 'number',
    lookup: { via: 'tarifa', field: 'tarifa_usd_kg', editable: true },
  },
  { key: 'total_usd', label: 'Total USD', type: 'money', currency: 'USD', formula: '[kilos] × [tarifa_usd]' },
] as never;
const rel = (id: string, label = 'x') => JSON.stringify({ id, label });
const tracker = { id: ID(950), slug: 'pre', fields };

describe('lookup de relación encadenado', () => {
  it('valida: una relación-lookup debe ser editable; el destino, una relación', () => {
    const bad = computedProblems([
      { key: 'cliente', label: 'C', type: 'relation', tracker: 'clientes' },
      { key: 'tarifa', label: 'T', type: 'relation', tracker: 'tarifas', lookup: { via: 'cliente', field: 'tarifa' } },
    ] as never);
    expect(bad[0]?.message).toMatch(/editable/);
    expect(computedProblems(fields)).toEqual([]);
  });

  it('al elegir cliente trae su tarifa, el precio y el total', async () => {
    const v = await prepareValues(fakeDb(), tracker as never, { cliente: rel(ID(1)), kilos: 100 });
    expect(JSON.parse(String(v.tarifa))).toEqual({ id: ID(11), label: 'Alta' });
    expect(v.tarifa_usd).toBe(0.12);
    expect(v.total_usd).toBe(12);
  });

  it('cliente sin tarifa por defecto: no inventa nada', async () => {
    const v = await prepareValues(fakeDb(), tracker as never, { cliente: rel(ID(2)), kilos: 10 });
    expect(v.tarifa).toBeUndefined();
    expect(v.tarifa_usd).toBeUndefined();
  });

  it('cambiar de cliente sin tarifa por defecto conserva la tarifa elegida', async () => {
    const v = await prepareValues(
      fakeDb(),
      tracker as never,
      { cliente: rel(ID(2)), tarifa: rel(ID(12)), kilos: 10, tarifa_usd: 0.05 },
      { only: new Set(['cliente']) },
    );
    expect(JSON.parse(String(v.tarifa)).id).toBe(ID(12));
    expect(v.tarifa_usd).toBe(0.05);
  });

  it('elegir la tarifa a mano recalcula el precio y el total', async () => {
    const v = await prepareValues(
      fakeDb(),
      tracker as never,
      { cliente: rel(ID(1)), tarifa: rel(ID(12)), kilos: 100, tarifa_usd: 0.12 },
      { only: new Set(['tarifa']) },
    );
    expect(v.tarifa_usd).toBe(0.05);
    expect(v.total_usd).toBe(5);
  });
});

describe('nitKeys (pegar relaciones por NIT)', () => {
  it('acepta puntos, guion y dígito de verificación', () => {
    expect(nitKeys('900.123.456-7')).toEqual(['900123456', '9001234567']);
    expect(nitKeys('900123456')).toEqual(['900123456']);
    expect(nitKeys(' 900 123 456 - 7 ')).toEqual(['900123456', '9001234567']);
  });
  it('un nombre o un número corto no es un NIT', () => {
    expect(nitKeys('Aeroexpress SAS')).toEqual([]);
    expect(nitKeys('Cliente 12')).toEqual([]);
    expect(nitKeys('123')).toEqual([]);
    expect(nitKeys(undefined)).toEqual([]);
  });
});
