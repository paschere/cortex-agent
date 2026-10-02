import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { type ManagementCase, managementCaseSchema } from './shape';
import { saveManagementCase } from './store';

/**
 * Plata recuperada o ahorrada al cerrar un asunto (0166).
 *
 * Es parte del cierre: se propone en «por verificar», cuenta cuando un
 * administrador verifica, y desaparece al reabrir. Una actualización que no lo
 * trae (el modelo editando un asunto en revisión) no lo borra.
 */

const owner = '11111111-1111-4111-a111-111111111111';
const evidence = {
  reference: '/payments',
  observation: 'El cliente pagó tras el acuerdo',
  observedOn: '2026-09-20',
};
const base = () =>
  managementCaseSchema.parse({
    title: 'Cobro Coltrans',
    objective: 'Recuperar la factura FV-100',
    successCriteria: 'Pago registrado',
    ownerId: owner,
    dueOn: '2026-09-30',
    nextReviewOn: '2026-09-25',
    impact: 'high',
    nextAction: 'Llamar al cliente',
  });

function harness(existingData: Record<string, unknown>) {
  const existing = {
    id: '22222222-2222-4222-a222-222222222222',
    data: { ...base(), ...existingData },
    revision: 3,
    created_by: owner,
    updated_by: owner,
    created_at: '2026-09-05T12:00:00Z',
    updated_at: '2026-09-05T12:00:00Z',
  } as ManagementCase;
  const { client, rpcCalls } = createFakeSupabase(
    {
      management_cases: [{ ...existing, organization_id: 'acme' }],
      users: [{ id: owner, organization_id: 'acme', role: 'org_admin' }],
    },
    { management_save_case: (args) => ({ ...existing, data: args.p_data }) },
  );
  const save = (data: Record<string, unknown>, humanReview = true) =>
    saveManagementCase(createOrgScopedClient(client, 'acme'), owner, data, {
      id: existing.id,
      revision: existing.revision,
      humanReview,
    });
  return { existing, rpcCalls, save };
}

describe('plata recuperada en el asunto', () => {
  it('acepta pesos enteros positivos con una nota corta, y nada más', () => {
    const ok = managementCaseSchema.safeParse({
      ...base(),
      recovered: { amountCop: 1_500_000, note: 'Multa evitada' },
    });
    expect(ok.success).toBe(true);
    for (const recovered of [
      { amountCop: 0, note: 'x' },
      { amountCop: -5, note: 'x' },
      { amountCop: 10.5, note: 'x' },
      { amountCop: 1000, note: '' },
      { amountCop: 1000, note: 'x'.repeat(301) },
    ])
      expect(managementCaseSchema.safeParse({ ...base(), recovered }).success).toBe(false);
    // Opcional: un asunto de antes no lo trae y sigue siendo válido.
    expect(managementCaseSchema.parse(base())).not.toHaveProperty('recovered');
  });

  it('se guarda al cerrar con verificación', async () => {
    const h = harness({ state: 'review', evidence });
    await h.save({
      ...h.existing.data,
      state: 'verified',
      reviewNote: 'Pago visto en el extracto',
      recovered: { amountCop: 900_000, note: 'Descuento por pronto pago evitado' },
    });
    expect(h.rpcCalls[0]?.args.p_data).toMatchObject({
      state: 'verified',
      recovered: { amountCop: 900_000, note: 'Descuento por pronto pago evitado' },
    });
  });

  it('una edición que no lo trae no lo borra; un null explícito sí', async () => {
    const recovered = { amountCop: 900_000, note: 'Multa evitada' };
    const h = harness({ state: 'review', evidence, recovered });
    const { recovered: _omit, ...withoutIt } = h.existing.data;
    await h.save({ ...withoutIt, nextAction: 'Esperar al administrador' }, false);
    expect(h.rpcCalls[0]?.args.p_data).toMatchObject({ recovered });

    const h2 = harness({ state: 'review', evidence, recovered });
    await h2.save({ ...h2.existing.data, recovered: null }, false);
    expect((h2.rpcCalls[0]?.args.p_data as { recovered?: unknown }).recovered).toBeNull();
  });

  it('fuera de «por verificar» o «cerrado» no existe: reabrir lo quita', async () => {
    const h = harness({
      state: 'verified',
      evidence,
      reviewNote: 'ok',
      recovered: { amountCop: 900_000, note: 'Multa evitada' },
    });
    await h.save({ ...h.existing.data, state: 'open', reviewNote: '', evidence: null });
    expect((h.rpcCalls[0]?.args.p_data as { recovered?: unknown }).recovered).toBeUndefined();
  });
});
