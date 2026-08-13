import type { Classification } from '@cortex/agent-tools';
import { applyMandate, loadMandates } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { revokeMandate } from './store';

/**
 * REVOCAR DESDE EL CHAT TIENE QUE DEJAR EL MANDATO SIN EFECTO. YA.
 *
 * ===========================================================================
 * POR QUÉ ESTA PRUEBA VIVE EN LA APP WEB Y NO EN EL PAQUETE
 * ===========================================================================
 * El botón «Revocar el permiso» que ahora sale dentro de la conversación hace
 * una promesa muy concreta: que a partir de la siguiente llamada Cortex vuelve a
 * preguntar. Esa promesa la cumplen dos piezas que viven en repositorios
 * distintos del árbol —`revokeMandate` aquí, `loadMandates` + `applyMandate` en
 * el paquete— y ninguna de las dos por sí sola la demuestra. Así que se prueba
 * el camino entero: la escritura que hace el botón, y la lectura que hace la
 * llamada siguiente.
 *
 * El cliente falso APLICA los filtros de verdad en vez de devolver lo que se le
 * diga. Es la mitad del valor de la prueba: `loadMandates` filtra la vigencia en
 * Postgres (`revoked_at is null`), así que un doble que ignorase los filtros
 * daría verde con la revocación rota, que es exactamente el fallo que esto
 * existe para atrapar.
 */

interface Row {
  id: string;
  label: string;
  tool_patterns: string[];
  covered_tool_ids: string[];
  max_risk_level: string;
  amount_ceiling: number | null;
  currency: string | null;
  applies_unattended: boolean;
  max_uses_per_day: number | null;
  starts_at: string;
  expires_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

type Filter = (row: Row) => boolean;

/**
 * Un PostgREST de mentira que sí filtra, y que además acepta el `update` que
 * escribe `revokeMandate` con su guarda `.is('revoked_at', null)`.
 */
function fakeDb(rows: Row[]) {
  const table = rows;

  const builder = () => {
    const filters: Filter[] = [];
    let patch: Partial<Row> | null = null;

    const self: Record<string, unknown> = {};
    self.select = () => self;
    self.order = () => self;
    self.limit = () => self;
    self.update = (values: Partial<Row>) => {
      patch = values;
      return self;
    };
    self.eq = (col: keyof Row, value: unknown) => {
      filters.push((r) => r[col] === value);
      return self;
    };
    self.is = (col: keyof Row, value: unknown) => {
      filters.push((r) => r[col] === value);
      return self;
    };
    self.lte = (col: keyof Row, value: string) => {
      filters.push((r) => String(r[col]) <= value);
      return self;
    };
    self.gt = (col: keyof Row, value: string) => {
      filters.push((r) => String(r[col]) > value);
      return self;
    };
    self.gte = (col: keyof Row, value: string) => {
      filters.push((r) => String(r[col]) >= value);
      return self;
    };
    self.in = (col: keyof Row, values: unknown[]) => {
      filters.push((r) => values.includes(r[col]));
      return self;
    };
    self.contains = (col: keyof Row, values: string[]) => {
      filters.push((r) => values.every((v) => (r[col] as string[]).includes(v)));
      return self;
    };

    const run = () => {
      const matched = table.filter((r) => filters.every((f) => f(r)));
      if (patch) {
        for (const r of matched) Object.assign(r, patch);
        return { data: null, error: null };
      }
      return { data: matched, error: null };
    };

    // biome-ignore lint/suspicious/noThenProperty: imita el builder de PostgREST
    self.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(run()).then(onFulfilled, onRejected);
    return self;
  };

  // `mandate_uses` no se consulta en este escenario (sin presupuesto diario),
  // pero el doble responde igual para que un cambio que empiece a consultarla no
  // reviente con un error que no dice nada.
  return { from: () => builder() } as never;
}

const TOOL_ID = 'gmail.send_draft';
const NOW = new Date('2026-08-13T12:00:00.000Z');

function liveRow(): Row {
  return {
    id: 'm-1',
    label: 'Correos a clientes',
    tool_patterns: ['gmail.*'],
    covered_tool_ids: [TOOL_ID],
    max_risk_level: 'high',
    amount_ceiling: null,
    currency: null,
    applies_unattended: false,
    max_uses_per_day: null,
    starts_at: '2026-08-03T20:00:00.000Z',
    expires_at: '2026-11-01T20:00:00.000Z',
    revoked_at: null,
    revoked_by: null,
  };
}

const CLASSIFICATION: Classification = {
  riskLevel: 'high',
  reason: 'contenido que sale de la empresa',
  signals: [],
  sensitivity: 'client',
  blastRadius: 'external_send',
};

const TOOL = { id: TOOL_ID, requiresConfirmation: true };

describe('revocar deja el mandato sin efecto en la llamada siguiente', () => {
  it('antes de revocar, la concesión convierte el confirm en allow', async () => {
    const db = fakeDb([liveRow()]);
    const mandates = await loadMandates(db, { toolId: TOOL_ID, now: NOW });
    expect(mandates).toHaveLength(1);

    const outcome = applyMandate({
      classification: CLASSIFICATION,
      decision: 'confirm',
      tool: TOOL,
      input: {},
      surface: 'web',
      mandates,
    });
    expect(outcome.decision).toBe('allow');
    expect(outcome.mandate?.id).toBe('m-1');
  });

  it('después de revocar, la misma llamada vuelve a pararse a preguntar', async () => {
    const rows = [liveRow()];
    const db = fakeDb(rows);

    await revokeMandate(db, 'm-1', 'usuario-que-revoca');

    // Revocar es un acto con autor, igual que conceder: la tabla lo exige con un
    // CHECK y aquí es donde se cumple.
    expect(rows[0]?.revoked_at).toBeTruthy();
    expect(rows[0]?.revoked_by).toBe('usuario-que-revoca');

    // Sin caché por medio: la lectura siguiente ya no la ve.
    const mandates = await loadMandates(db, { toolId: TOOL_ID, now: NOW });
    expect(mandates).toEqual([]);

    const outcome = applyMandate({
      classification: CLASSIFICATION,
      decision: 'confirm',
      tool: TOOL,
      input: {},
      surface: 'web',
      mandates,
    });
    expect(outcome.decision).toBe('confirm');
    expect(outcome.mandate).toBeNull();
  });

  it('no revoca dos veces: la guarda `revoked_at is null` deja intacto el primer autor', async () => {
    const rows = [liveRow()];
    const db = fakeDb(rows);

    await revokeMandate(db, 'm-1', 'la-primera');
    const firstAt = rows[0]?.revoked_at;
    await revokeMandate(db, 'm-1', 'la-segunda');

    expect(rows[0]?.revoked_by).toBe('la-primera');
    expect(rows[0]?.revoked_at).toBe(firstAt);
  });
});
