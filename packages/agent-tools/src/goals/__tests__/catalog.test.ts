import { describe, expect, it } from 'vitest';
import { METRIC_CATALOG, metricByKey, offerMetrics } from '../catalog';
import { createGoalsWorld } from './fake-db';

/**
 * EL TEST QUE DEFIENDE LA REGLA DEL MÓDULO.
 *
 * «Una meta sin datos que la alimenten es una casilla vacía, y una casilla
 * vacía resta más confianza de la que suma.» Todo el diseño depende de que eso
 * se decida ANTES de crear la meta, y de que quien lo lea sepa qué hacer.
 *
 * Así que se comprueban tres cosas y no una:
 *   que la métrica que el dueño pidió NO se ofrece en un espacio sin pagos;
 *   que el motivo dice qué hacer, y no sólo que no se puede;
 *   y que la MISMA métrica sí se ofrece en cuanto hay un pago, para que el test
 *   no pueda pasar por accidente con un catálogo roto que no ofrece nada.
 */

const ORG = 'org-metas';

describe('el selector se niega a ofrecer lo que este espacio no sabe medir', () => {
  it('no ofrece la cartera en un espacio sin pagos, y dice por qué', async () => {
    const world = createGoalsWorld(
      {
        // Facturas confirmadas sí hay. Pagos, ninguno — que es el caso real de
        // un espacio recién montado: se leen las facturas mucho antes de que
        // alguien conecte el banco.
        document_extractions: [
          {
            id: 'ext-1',
            organization_id: ORG,
            doc_type: 'invoice',
            review_state: 'confirmed',
            total_amount: 1_000_000,
            currency: 'COP',
            issued_on: '2026-06-01',
            due_on: '2026-07-01',
          },
        ],
        payments: [],
      },
      ORG,
    );

    const offers = await offerMetrics(world.db);
    const cartera = offers.find((o) => o.spec.key === 'receivables_days');

    expect(cartera).toBeDefined();
    expect(cartera?.available).toBe(false);
    // El motivo no es decorativo: es la mitad útil del rechazo. Un selector que
    // sólo esconde la opción deja a alguien buscando una función que existe.
    expect(cartera?.reason).toContain('Siigo');
    expect(cartera?.reason).toContain('pago');
  });

  it('ofrece la cartera en cuanto hay un pago registrado', async () => {
    const world = createGoalsWorld(
      {
        document_extractions: [
          {
            id: 'ext-1',
            organization_id: ORG,
            doc_type: 'invoice',
            review_state: 'confirmed',
            total_amount: 1_000_000,
            currency: 'COP',
            issued_on: '2026-06-01',
            due_on: '2026-07-01',
          },
        ],
        payments: [
          {
            id: 'pay-1',
            organization_id: ORG,
            state: 'reported',
            kind: 'payment',
            amount: 400_000,
            currency: 'COP',
            paid_on: '2026-06-15',
          },
        ],
      },
      ORG,
    );

    const offers = await offerMetrics(world.db);
    const cartera = offers.find((o) => o.spec.key === 'receivables_days');
    expect(cartera?.available).toBe(true);
    expect(cartera?.reason).toBeNull();
  });

  it('un espacio vacío no puede fijar NINGUNA meta, y cada negativa explica qué falta', async () => {
    const world = createGoalsWorld({}, ORG);
    const offers = await offerMetrics(world.db);

    expect(offers).toHaveLength(METRIC_CATALOG.length);
    expect(offers.every((o) => o.available === false)).toBe(true);
    for (const offer of offers) {
      // No basta con negarse: una negativa sin salida es una pantalla muerta.
      expect(offer.reason?.length).toBeGreaterThan(40);
    }
  });

  it('los pagos no abren la puerta a la cartera si nadie ha confirmado una factura', async () => {
    const world = createGoalsWorld(
      {
        payments: [
          {
            id: 'pay-1',
            organization_id: ORG,
            state: 'confirmed',
            kind: 'payment',
            amount: 400_000,
            currency: 'COP',
            paid_on: '2026-06-15',
          },
        ],
        document_extractions: [
          { id: 'ext-1', organization_id: ORG, doc_type: 'invoice', review_state: 'pending' },
        ],
      },
      ORG,
    );
    const cartera = (await offerMetrics(world.db)).find((o) => o.spec.key === 'receivables_days');
    expect(cartera?.available).toBe(false);
    expect(cartera?.reason).toContain('confirmada');
  });

  it('ofrece las disponibles primero', async () => {
    const world = createGoalsWorld(
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
        ],
      },
      ORG,
    );
    const offers = await offerMetrics(world.db);
    expect(offers[0]?.spec.key).toBe('fleet_current');
    expect(offers.slice(1).every((o) => o.available === false)).toBe(true);
  });
});

describe('el catálogo es un registro cerrado y coherente', () => {
  it('las claves son slugs únicos con la forma que acepta la 0101', () => {
    const keys = METRIC_CATALOG.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z][a-z0-9_]{2,39}$/);
  });

  it('un objetivo en porcentaje sugerido nunca se sale de la escala', () => {
    for (const spec of METRIC_CATALOG) {
      if (spec.unit !== 'percent') continue;
      expect(spec.suggestedTarget).toBeGreaterThanOrEqual(0);
      expect(spec.suggestedTarget).toBeLessThanOrEqual(100);
    }
  });

  it('cada métrica se puede recuperar por su clave, y ninguna inventada', () => {
    for (const spec of METRIC_CATALOG) expect(metricByKey(spec.key)).toBe(spec);
    expect(metricByKey('margen_bruto')).toBeNull();
  });

  it('no promete nada que no haya en el esquema: ni márgenes, ni SLA, ni ventas', () => {
    const keys = METRIC_CATALOG.map((m) => m.key).join(' ');
    for (const forbidden of ['margin', 'margen', 'cost', 'costo', 'sla', 'revenue', 'hubspot']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
