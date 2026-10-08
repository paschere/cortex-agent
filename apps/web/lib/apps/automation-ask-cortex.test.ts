import { filterTools } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { decideAutomationCall } from './automation-ask-cortex';

/**
 * «Pedirle algo a Cortex» con permiso de escribir en la fila: sólo esa fila y
 * sólo los campos declarados corren sin aprobación; las herramientas de lectura
 * (web, cerebro, tablas) siguen disponibles.
 */
const upsert = { id: 'trackers.upsert' };
const scope = { rowId: 'r1', fields: new Set(['estado', 'eta']) };

describe('escritura en la fila de la regla', () => {
  it('campos declarados en la fila de contexto: se escribe sin aprobación', () => {
    expect(
      decideAutomationCall(
        upsert,
        { tracker: 'vuelos', rowId: 'r1', values: { estado: 'En vuelo' } },
        'vuelos',
        scope,
      ),
    ).toBe('row_write');
  });
  it('un campo no declarado, otra fila u otra tabla pasan por aprobación', () => {
    const call = (input: unknown) => decideAutomationCall(upsert, input, 'vuelos', scope);
    expect(call({ tracker: 'vuelos', rowId: 'r1', values: { kilos: 5 } })).toBe('stage');
    expect(call({ tracker: 'vuelos', rowId: 'r2', values: { estado: 'x' } })).toBe('stage');
    expect(call({ tracker: 'vuelos', values: { estado: 'x' } })).toBe('stage');
    expect(call({ tracker: 'otra', rowId: 'r1', values: { estado: 'x' } })).toBe('stage');
  });
  it('sin permiso declarado se conserva el comportamiento de siempre', () => {
    expect(decideAutomationCall(upsert, { tracker: 'vuelos', values: {} }, 'vuelos', null)).toBe(
      'run',
    );
  });
  it('tocar reglas, apps o permisos está prohibido', () => {
    expect(decideAutomationCall({ id: 'apps.update' }, {}, 'vuelos', scope)).toBe('forbidden');
  });
});

describe('herramientas de lectura disponibles', () => {
  it('web.search, web.scrape y kb.search corren sin aprobación y sin ser prohibidas', () => {
    const tools = filterTools(['*']);
    for (const id of ['web.search', 'web.scrape', 'kb.search']) {
      const t = tools.find((x) => x.id === id);
      expect(t, id).toBeDefined();
      expect(
        decideAutomationCall(t as never, { query: 'x', url: 'https://a.co' }, 'vuelos', scope),
      ).toBe('run');
    }
  });
});

describe('consultar un portal con un trámite aprendido', () => {
  it('browser.run_flow corre sin aprobación (sólo lee y lo admite un administrador); resume_flow y submit_flow no', () => {
    expect(decideAutomationCall({ id: 'browser.run_flow' }, {}, 'vuelos', scope)).toBe('run');
    expect(decideAutomationCall({ id: 'browser.run_flow' }, {}, null, null)).toBe('run');
    expect(decideAutomationCall({ id: 'browser.submit_flow' }, {}, 'vuelos', scope)).toBe('stage');
    expect(decideAutomationCall({ id: 'browser.resume_flow' }, {}, 'vuelos', scope)).toBe('stage');
  });
});
