import { encodeViewFilterState, parseViewFilterParam, viewSpecSchema } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { encodeFilterState, stateFromComputed, withFilterParam } from './filter-param';

/**
 * El navegador escribe `?f=` con su copia; el servidor lo lee con la de
 * verdad. Si las dos se desvían, un filtro elegido en pantalla se perdería en
 * silencio al refrescar: esta prueba se pone roja antes.
 */

const spec = viewSpecSchema.parse({
  version: 1,
  blocks: [{ id: 't', type: 'table', title: 'T', tracker: 'citas' }],
  filtersBar: [
    { id: 'sede', label: 'Sede', source: 'citas', field: 'sede', kind: 'select' },
    { id: 'fechas', label: 'Fechas', source: 'citas', field: 'fecha', kind: 'date_range' },
    { id: 'q', label: 'Buscar', source: 'citas', field: 'paciente', kind: 'search' },
  ],
});

describe('el parámetro de la barra de filtros', () => {
  it('se escribe igual que en el servidor y el servidor lo lee entero', () => {
    const state = {
      sede: { kind: 'select' as const, value: 'Bogotá & Cía' },
      fechas: { kind: 'date_range' as const, from: '2026-09-01', to: null },
      q: { kind: 'search' as const, value: 'ana maría' },
    };
    const f = encodeFilterState(state);
    expect(f).toBe(encodeViewFilterState(state));
    expect(parseViewFilterParam(spec, f)).toEqual(state);
  });

  it('arma la dirección de datos con y sin filtro', () => {
    expect(withFilterParam('/api/views/public/data?token=abc', 'sede=Cali', 'http://x.test')).toBe(
      '/api/views/public/data?token=abc&f=sede%3DCali',
    );
    expect(withFilterParam('/api/views/1/data?f=old', '', 'http://x.test')).toBe(
      '/api/views/1/data',
    );
    expect(stateFromComputed([{ id: 'a', value: null }])).toEqual({});
  });
});
