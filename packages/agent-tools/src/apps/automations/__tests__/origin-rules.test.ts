import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../../../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../../../tenancy/scoped-client';
import { forgetAutomationWatch } from '../emit';
import { validateAutomation } from '../store';

/**
 * Al GUARDAR una regla que escribe un campo de un programa contable se rechaza,
 * con el mismo mensaje que daría el servidor al ejecutarla.
 */

const ORG = 'org-a';
const f = (key: string, type = 'text', extra: object = {}) => ({
  key,
  label: key.toUpperCase(),
  type,
  required: false,
  ...extra,
});
const tracker = (id: string, slug: string, fields: unknown[], origins: unknown[] = []) => ({
  id,
  organization_id: ORG,
  slug,
  name: slug,
  description: '',
  fields,
  origins,
  duplicates: null,
  created_by: null,
  created_at: 'x',
  updated_at: 'x',
});
const siigo = {
  kind: 'accounting',
  provider: 'siigo',
  label: 'Siigo',
  ref: 'c1',
  fields: ['total', 'cliente_id'],
  creates: true,
};
const sheet = { kind: 'sheet', label: 'la hoja «V»', ref: 's1', fields: ['estado'], creates: true };

function world() {
  const fake = createFakeSupabase({
    trackers: [
      tracker(
        't-fac',
        'siigo_facturas',
        [f('total', 'money'), f('notas'), f('cliente_id', 'relation', { tracker: 'clientes' })],
        [siigo],
      ),
      tracker('t-cli', 'clientes', [f('nombre'), f('saldo', 'money')]),
      tracker('t-vue', 'vuelos', [f('estado'), f('nota')], [sheet]),
    ],
    custom_apps: [
      {
        id: 'app-1',
        organization_id: ORG,
        slug: 'a',
        name: 'A',
        icon: 'x',
        status: 'draft',
        archived_at: null,
      },
    ],
    custom_app_screens: [],
    custom_app_roles: [],
    custom_app_automations: [],
    custom_app_users: [],
    custom_app_members: [],
  });
  forgetAutomationWatch();
  return createOrgScopedClient(fake.client, ORG);
}

const rule = (tracker_: string, actions: unknown[]) => ({
  name: 'x',
  trigger: { type: 'row_created', tracker: tracker_ },
  actions,
});

describe('automatizaciones sobre campos de un programa contable', () => {
  it('set_field sobre un campo del programa se rechaza al guardar; sobre uno propio pasa', async () => {
    const db = world();
    await expect(
      validateAutomation(
        db,
        'app-1',
        rule('siigo_facturas', [{ type: 'set_field', field: 'total', value: '0' }]),
      ),
    ).rejects.toThrow('«TOTAL» viene de Siigo');
    await expect(
      validateAutomation(
        db,
        'app-1',
        rule('siigo_facturas', [{ type: 'set_field', field: 'notas', value: 'x' }]),
      ),
    ).resolves.toBeTruthy();
  });

  it('update_related hacia una tabla del programa se rechaza', async () => {
    const db = world();
    await expect(
      validateAutomation(
        db,
        'app-1',
        rule('siigo_facturas', [{ type: 'update_related', up: 'cliente_id', set: { saldo: '1' } }]),
      ),
    ).resolves.toBeTruthy(); // cliente_id apunta a «clientes» (propia): nada bloqueado
    await expect(
      validateAutomation(db, 'app-1', {
        name: 'x',
        trigger: { type: 'row_created', tracker: 'clientes' },
        actions: [
          {
            type: 'update_rows',
            tracker: 'siigo_facturas',
            where: [{ field: 'notas', op: 'eq', value: 'x' }],
            set: { total: '1' },
          },
        ],
      }),
    ).rejects.toThrow('viene de Siigo');
    await expect(
      validateAutomation(db, 'app-1', {
        name: 'x',
        trigger: { type: 'row_created', tracker: 'clientes' },
        actions: [
          {
            type: 'update_related',
            down: { tracker: 'siigo_facturas', via: 'cliente_id' },
            set: { total: '1' },
          },
        ],
      }),
    ).rejects.toThrow('viene de Siigo');
  });

  it('crear filas en una tabla del programa se rechaza', async () => {
    const db = world();
    await expect(
      validateAutomation(
        db,
        'app-1',
        rule('clientes', [
          { type: 'create_row', tracker: 'siigo_facturas', values: { notas: 'x' } },
        ]),
      ),
    ).rejects.toThrow('se llena sola desde Siigo');
  });

  it('una hoja no se bloquea al diseñar: sus filas a mano se pueden automatizar', async () => {
    const db = world();
    await expect(
      validateAutomation(
        db,
        'app-1',
        rule('vuelos', [{ type: 'set_field', field: 'estado', value: 'x' }]),
      ),
    ).resolves.toBeTruthy();
  });
});
