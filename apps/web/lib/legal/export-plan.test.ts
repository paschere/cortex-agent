import { TABLE_TENANCY } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  EXPORT_EXCLUDED,
  columnTreatment,
  companyExportQuery,
  exportTables,
  personalExportQuery,
  safeIdentifier,
} from './export-plan';

describe('«descargar todos los datos» cubre todo el registro de tenencia', () => {
  it('exportadas ∪ excluidas = tenant ∪ derived del registro, sin una tabla de más ni de menos', () => {
    const expected = Object.entries(TABLE_TENANCY)
      .filter(([, t]) => t.kind === 'tenant' || t.kind === 'derived')
      .map(([name]) => name)
      .sort();
    const exported = exportTables().map((t) => t.table);
    const covered = [...exported, ...Object.keys(EXPORT_EXCLUDED)].sort();
    expect(covered).toEqual(expected);
    expect(new Set(exported).size).toBe(exported.length);
  });

  it('una tabla nueva del registro entra sola en la exportación', () => {
    const registry = { ...TABLE_TENANCY, tabla_de_manana: { kind: 'tenant' as const } };
    expect(exportTables(registry).map((t) => t.table)).toContain('tabla_de_manana');
  });

  it('las compartidas (identidad, OAuth, catálogo, autorizaciones) no salen', () => {
    const exported = new Set(exportTables().map((t) => t.table));
    for (const [name, t] of Object.entries(TABLE_TENANCY)) {
      if (t.kind === 'shared') expect(exported.has(name), name).toBe(false);
    }
  });

  it('cada exclusión existe en el registro y dice por qué', () => {
    for (const [name, why] of Object.entries(EXPORT_EXCLUDED)) {
      expect(TABLE_TENANCY[name], name).toBeDefined();
      expect(why.length).toBeGreaterThan(40);
    }
  });

  it('las derivadas se exportan por su padre, filtrado por la empresa', () => {
    const chunks = exportTables().find((t) => t.table === 'kb_chunks');
    expect(chunks).toMatchObject({
      kind: 'derived',
      parent: 'kb_documents',
      parentKey: 'document_id',
    });
    const { sql } = companyExportQuery(chunks as NonNullable<typeof chunks>);
    expect(sql).toContain(
      '"document_id" in (select p.id from public."kb_documents" p where p.organization_id = $1)',
    );
  });

  it('toda consulta de empresa lleva el filtro de la empresa', () => {
    for (const t of exportTables()) {
      expect(companyExportQuery(t).sql, t.table).toMatch(/organization_id = \$1/);
    }
  });
});

describe('qué columnas nunca salen', () => {
  it.each([
    ['access_token_enc', 'secret'],
    ['refresh_token_enc', 'secret'],
    ['auth_value_encrypted', 'secret'],
    ['client_secret', 'secret'],
    ['credentials_enc', 'secret'],
    ['password', 'secret'],
    ['token', 'secret'],
    ['share_token', 'secret'],
    ['code_hash', 'secret'],
    ['storage_state', 'secret'],
    ['embedding', 'derived'],
    ['name', 'keep'],
    ['amount', 'keep'],
    ['token_count', 'keep'],
    ['dedupe_key', 'keep'],
  ])('%s → %s', (column, expected) => {
    expect(columnTreatment(column)).toBe(expected);
  });
});

describe('exportación personal', () => {
  it('sólo lo que está a nombre de la persona', () => {
    const tenant = { table: 'user_memories', kind: 'tenant' as const };
    expect(personalExportQuery(tenant, ['id', 'organization_id', 'user_id'])).toContain(
      't.user_id = $2',
    );
    expect(
      personalExportQuery({ table: 'invoices', kind: 'tenant' }, ['id', 'organization_id']),
    ).toBeNull();
    expect(personalExportQuery({ table: 'users', kind: 'tenant' }, ['id'])).toContain('t.id = $2');
    expect(
      personalExportQuery({ table: 'messages', kind: 'tenant' }, [
        'id',
        'organization_id',
        'conversation_id',
      ]),
    ).toContain('c.user_id = $2');
  });
});

describe('identificadores', () => {
  it('rechaza cualquier cosa que no sea un nombre de tabla simple', () => {
    expect(safeIdentifier('kb_documents')).toBe('"kb_documents"');
    expect(() => safeIdentifier('x"; drop table users; --')).toThrow();
    expect(() => safeIdentifier('Public.Tabla')).toThrow();
  });
});
