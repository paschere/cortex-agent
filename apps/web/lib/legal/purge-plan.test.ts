import { TABLE_TENANCY } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { type ForeignKey, PURGE_KEEP, type PurgeStep, planPurge, purgeTables } from './purge-plan';

const t = (table: string): PurgeStep => ({ table, kind: 'tenant' });
const fk = (child: string, parent: string, onDelete: ForeignKey['onDelete'] = 'a'): ForeignKey => ({
  child,
  parent,
  onDelete,
});

function position(order: PurgeStep[], table: string): number {
  return order.findIndex((s) => s.table === table);
}

describe('orden de la purga (simulacro sobre un grafo inventado)', () => {
  it('borra las hijas antes que las madres cuando la llave bloquea', () => {
    const steps = [t('clients'), t('invoices'), t('invoice_lines'), t('payments')];
    const plan = planPurge(steps, [
      fk('invoices', 'clients'),
      fk('invoice_lines', 'invoices', 'r'),
      fk('payments', 'invoices'),
    ]);
    const o = plan.order;
    expect(position(o, 'invoice_lines')).toBeLessThan(position(o, 'invoices'));
    expect(position(o, 'payments')).toBeLessThan(position(o, 'invoices'));
    expect(position(o, 'invoices')).toBeLessThan(position(o, 'clients'));
    expect(plan.brokenCycles).toEqual([]);
  });

  it('cascade y set null no obligan a ordenar (la base resuelve sola)', () => {
    const plan = planPurge([t('a'), t('b')], [fk('b', 'a', 'c'), fk('a', 'b', 'n')]);
    expect(plan.order.map((s) => s.table)).toEqual(['a', 'b']);
    expect(plan.brokenCycles).toEqual([]);
  });

  it('una derivada se borra antes que su padre aunque la base no tenga la llave', () => {
    const plan = planPurge(
      [
        t('kb_documents'),
        { table: 'kb_chunks', kind: 'derived', parent: 'kb_documents', parentKey: 'document_id' },
      ],
      [],
    );
    expect(plan.order.map((s) => s.table)).toEqual(['kb_chunks', 'kb_documents']);
  });

  it('las autorreferencias no bloquean (se resuelven en la misma sentencia)', () => {
    const plan = planPurge([t('docs')], [fk('docs', 'docs')]);
    expect(plan.order.map((s) => s.table)).toEqual(['docs']);
  });

  it('un ciclo que bloquea se rompe y SE INFORMA', () => {
    const plan = planPurge([t('x'), t('y'), t('z')], [fk('x', 'y'), fk('y', 'x')]);
    expect(plan.order).toHaveLength(3);
    expect(plan.brokenCycles).toEqual([['x', 'y']]);
  });

  it('ignora llaves hacia tablas que no se purgan (identidad, catálogo)', () => {
    const plan = planPurge([t('users')], [fk('users', 'ba_organization'), fk('users', 'plans')]);
    expect(plan.order.map((s) => s.table)).toEqual(['users']);
  });

  it('es estable: el mismo grafo da el mismo plan', () => {
    const steps = purgeTables();
    const a = planPurge(steps, []).order.map((s) => s.table);
    const b = planPurge([...steps].reverse(), []).order.map((s) => s.table);
    expect(a).toEqual(b);
  });
});

describe('qué se purga', () => {
  it('todas las tenant y derived del registro, menos el acta del borrado', () => {
    const expected = Object.entries(TABLE_TENANCY)
      .filter(([name, x]) => (x.kind === 'tenant' || x.kind === 'derived') && !(name in PURGE_KEEP))
      .map(([name]) => name)
      .sort();
    expect(
      purgeTables()
        .map((s) => s.table)
        .sort(),
    ).toEqual(expected);
    expect(purgeTables().map((s) => s.table)).not.toContain('organization_deletions');
  });

  it('suma las tablas con organization_id que la base revela y el registro no nombra', () => {
    const tables = purgeTables(TABLE_TENANCY, ['tabla_olvidada', 'legal_consents']).map(
      (s) => s.table,
    );
    expect(tables).toContain('tabla_olvidada');
    // Compartida en el registro (es de la persona): la purga no la toca.
    expect(tables).not.toContain('legal_consents');
  });

  it('el plan del registro completo cubre cada tabla una sola vez', () => {
    const steps = purgeTables();
    const plan = planPurge(steps, []);
    expect(plan.order).toHaveLength(steps.length);
    expect(new Set(plan.order.map((s) => s.table)).size).toBe(steps.length);
    // Toda derivada antes que su padre.
    for (const s of plan.order) {
      if (s.kind === 'derived' && s.parent) {
        expect(position(plan.order, s.table), s.table).toBeLessThan(position(plan.order, s.parent));
      }
    }
  });
});
