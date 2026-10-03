import { TABLE_TENANCY, type TableTenancy } from '@cortex/agent-tools';

/**
 * EN QUÉ ORDEN SE BORRA UNA EMPRESA.
 *
 * Casi todas las tablas de empresa llevan `organization_id … references
 * ba_organization on delete cascade`, así que borrar la fila de la empresa
 * arrastraría casi todo. «Casi» es la palabra que no sirve aquí: una tabla con
 * `organization_id` sin llave foránea, o una derivada cuyo hijo apunta al padre
 * con `on delete no action`, haría fallar el borrado a mitad, o —peor—
 * sobreviviría en silencio. Así que la purga no confía en la cascada: borra
 * TABLA POR TABLA, hijos antes que padres, en una transacción, y deja la fila de
 * la empresa para el final.
 *
 * El orden sale de las llaves foráneas REALES de la base (pg_constraint), no de
 * lo que creemos: sólo las que bloquean (`no action`/`restrict`) obligan a
 * ordenar; `cascade` y `set null` resuelven solas. Si hay un ciclo que bloquea,
 * se rompe por el nombre y se informa: la transacción fallará en esa tabla y la
 * purga quedará `fallida` con el motivo, sin haber borrado nada a medias.
 *
 * Esta función es pura para poder probarla con un grafo inventado
 * (purge-plan.test.ts) y para el «simulacro» (dry run) que cuenta filas sin
 * borrar nada.
 */

export interface ForeignKey {
  /** Tabla que tiene la columna (la hija). */
  child: string;
  /** Tabla a la que apunta (la madre). */
  parent: string;
  /** confdeltype de pg_constraint: a=no action, r=restrict, c=cascade, n=set null, d=set default. */
  onDelete: 'a' | 'r' | 'c' | 'n' | 'd';
}

export interface PurgeStep {
  table: string;
  kind: 'tenant' | 'derived';
  parentKey?: string;
  parent?: string;
}

/**
 * Tablas que la purga NO toca: el acta del borrado tiene que sobrevivirlo
 * (organization_deletions no tiene llave foránea a la empresa por eso).
 */
export const PURGE_KEEP: Readonly<Record<string, string>> = {
  organization_deletions:
    'El acta del borrado: prueba qué empresa se borró, cuándo y a pedido de quién.',
};

/** Qué tablas se purgan: tenant + derived del registro, más las que la base revela. */
export function purgeTables(
  registry: Readonly<Record<string, TableTenancy>> = TABLE_TENANCY,
  discoveredWithOrgColumn: readonly string[] = [],
): PurgeStep[] {
  const steps = new Map<string, PurgeStep>();
  for (const [table, t] of Object.entries(registry)) {
    if (table in PURGE_KEEP) continue;
    if (t.kind === 'tenant') steps.set(table, { table, kind: 'tenant' });
    else if (t.kind === 'derived') {
      steps.set(table, { table, kind: 'derived', parentKey: t.parentKey, parent: t.parent });
    }
  }
  // Una tabla con organization_id que el registro no nombra (un olvido, o una
  // tabla que sólo usa SQL directo) también es de la empresa.
  for (const table of discoveredWithOrgColumn) {
    if (table in PURGE_KEEP || steps.has(table)) continue;
    if (registry[table]?.kind === 'shared') continue;
    steps.set(table, { table, kind: 'tenant' });
  }
  return [...steps.values()];
}

export interface PurgePlan {
  order: PurgeStep[];
  /** Ciclos de llaves que bloquean, rotos a la fuerza (se informan). */
  brokenCycles: string[][];
}

/**
 * Ordena para borrar: toda tabla va ANTES que las tablas a las que apunta con
 * una llave que bloquea. Topológico de Kahn sobre «hija → madre», estable por
 * nombre para que el plan sea el mismo en cada corrida.
 */
export function planPurge(steps: readonly PurgeStep[], fks: readonly ForeignKey[]): PurgePlan {
  const names = new Set(steps.map((s) => s.table));
  // Las derivadas dependen de su padre aunque la base no tuviera la llave:
  // el hijo se borra buscando por el padre, así que el padre tiene que seguir ahí.
  const edges: ForeignKey[] = [...fks];
  for (const s of steps) {
    if (s.kind === 'derived' && s.parent)
      edges.push({ child: s.table, parent: s.parent, onDelete: 'a' });
  }
  // hija → madres a las que bloquea
  const parentsOf = new Map<string, Set<string>>();
  const blockingChildrenLeft = new Map<string, number>();
  for (const n of names) {
    parentsOf.set(n, new Set());
    blockingChildrenLeft.set(n, 0);
  }
  // Para borrar la madre hay que haber borrado antes a las hijas que bloquean.
  // indegree(madre) = cuántas hijas bloqueantes le quedan.
  const children = new Map<string, Set<string>>();
  for (const n of names) children.set(n, new Set());
  for (const e of edges) {
    if (e.onDelete !== 'a' && e.onDelete !== 'r') continue;
    if (!names.has(e.child) || !names.has(e.parent) || e.child === e.parent) continue;
    const set = children.get(e.parent) as Set<string>;
    if (set.has(e.child)) continue;
    set.add(e.child);
    (parentsOf.get(e.child) as Set<string>).add(e.parent);
    blockingChildrenLeft.set(e.parent, (blockingChildrenLeft.get(e.parent) ?? 0) + 1);
  }

  const byName = new Map(steps.map((s) => [s.table, s]));
  const done = new Set<string>();
  const order: PurgeStep[] = [];
  const brokenCycles: string[][] = [];

  const ready = () =>
    [...names].filter((n) => !done.has(n) && (blockingChildrenLeft.get(n) ?? 0) === 0).sort();

  const release = (n: string) => {
    done.add(n);
    order.push(byName.get(n) as PurgeStep);
    for (const parent of parentsOf.get(n) ?? []) {
      blockingChildrenLeft.set(parent, (blockingChildrenLeft.get(parent) ?? 0) - 1);
    }
  };

  while (done.size < names.size) {
    const batch = ready();
    if (batch.length > 0) {
      for (const n of batch) release(n);
      continue;
    }
    // Ciclo: lo que queda se bloquea entre sí. Se rompe por el primero en
    // orden alfabético y se informa.
    const stuck = [...names].filter((n) => !done.has(n)).sort();
    brokenCycles.push(stuck);
    release(stuck[0] as string);
  }
  return { order, brokenCycles };
}
