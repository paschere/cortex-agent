import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { duplicateKeyFor, duplicateSentence, findLikelyDuplicates, sameForDuplicates } from './duplicate-check';
import type { TrackerField } from './schema';

const ORG = 'org-1';
const fields = [
  { key: 'nombre', label: 'Nombre', type: 'text', required: true },
  { key: 'guia', label: 'Guía', type: 'text' },
  { key: 'vuelo', label: 'Vuelo', type: 'relation', tracker: 'vuelos' },
] as unknown as TrackerField[];

function world() {
  const tables = {
    trackers: [{ id: 't1', organization_id: ORG, slug: 'clientes', name: 'Clientes', fields, duplicates: null }],
    tracker_rows: [
      { id: 'r1', organization_id: ORG, tracker_id: 't1', label: 'Acme Ltda', values: { nombre: 'Acme Ltda', guia: '045-1234' }, updated_at: '2026-10-01T00:00:00Z' },
      { id: 'r2', organization_id: ORG, tracker_id: 't1', label: 'Beta', values: { nombre: 'Beta', guia: '777 0001' }, updated_at: '2026-10-02T00:00:00Z' },
    ],
  };
  return createOrgScopedClient(createFakeSupabase(tables).client, ORG);
}

describe('«Parece que ya existe»', () => {
  it('sin regla compara el nombre que se escribe a mano, sin tildes ni mayúsculas', async () => {
    const db = world();
    const out = await findLikelyDuplicates(db, { id: 't1', fields }, { nombre: ' ACME  ltda ' });
    expect(out.keys).toEqual(['nombre']);
    expect(out.matches.map((m) => m.id)).toEqual(['r1']);
    expect(duplicateSentence(out.matches)).toBe('Ya existe «Acme Ltda» (Nombre: Acme Ltda)');
  });
  it('con regla compara la clave sin guiones ni espacios', async () => {
    const db = world();
    const out = await findLikelyDuplicates(db, { id: 't1', fields }, { guia: '0451234' }, { ruleKey: 'guia' });
    expect(out.matches.map((m) => m.id)).toEqual(['r1']);
    const other = await findLikelyDuplicates(db, { id: 't1', fields }, { guia: '7770001' }, { ruleKey: 'guia' });
    expect(other.matches.map((m) => m.id)).toEqual(['r2']);
  });
  it('no avisa con texto corto, con otra fila nueva, ni contra sí misma al editar', async () => {
    const db = world();
    expect((await findLikelyDuplicates(db, { id: 't1', fields }, { nombre: 'Ac' })).matches).toEqual([]);
    expect((await findLikelyDuplicates(db, { id: 't1', fields }, { nombre: 'Gamma' })).matches).toEqual([]);
    expect(
      (await findLikelyDuplicates(db, { id: 't1', fields }, { nombre: 'Acme Ltda' }, { selfId: 'r1' })).matches,
    ).toEqual([]);
  });
  it('una tabla cuyo nombre sale de una relación no compara (repetirse es normal)', () => {
    const onlyRelation = [{ key: 'vuelo', label: 'Vuelo', type: 'relation', tracker: 'vuelos' }] as unknown as TrackerField[];
    expect(duplicateKeyFor(onlyRelation, null)).toBeNull();
    expect(sameForDuplicates('key', '045-1', '0451')).toBe(true);
    expect(sameForDuplicates('name', 'Ñandú', 'nandu')).toBe(true);
    expect(sameForDuplicates('name', 'av 2041', 'AV-2041')).toBe(true);
  });
});
