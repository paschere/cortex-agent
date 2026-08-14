import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTools } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { RICH, TABLE, normalizeToolId, resolveView, structuralView } from './registry';

/**
 * EL ESPEJO, Y POR QUÉ EXISTE DESDE EL PRIMER COMMIT.
 *
 * `registry.tsx` es `'use client'` y vive a un import de distancia de romper el
 * build de producción sin que nada local se entere. El barril
 * `@cortex/agent-tools` alcanza `node:dns`; un VALOR importado desde ahí en un
 * componente de cliente compila en local, pasa el typecheck y pasa las pruebas,
 * y falla en Vercel. Está contado con detalle en `lib/reports-shape.ts`, que ya
 * lo vivió.
 *
 * Un tipo se borra al compilar y es seguro. Un valor no. La diferencia no la
 * ve nadie leyendo un diff, así que la comprueba esto.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('el registro no puede arrastrar node:dns al navegador', () => {
  it('solo importa TIPOS de @cortex/agent-tools, nunca valores', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(HERE)) {
      const src = readFileSync(file, 'utf8');
      // `import type { X } from '@cortex/agent-tools'` es seguro: desaparece.
      // `import { X } from '@cortex/agent-tools'` no lo es, aunque X resulte
      // ser un tipo — el bundler no lo sabe hasta que ya lo ha seguido.
      for (const line of src.split('\n')) {
        if (!line.includes('@cortex/agent-tools')) continue;
        if (!line.trimStart().startsWith('import')) continue;
        if (/^\s*import\s+type\s/.test(line)) continue;
        offenders.push(`${file.slice(HERE.length)}: ${line.trim()}`);
      }
    }

    expect(
      offenders,
      'Estos importan un VALOR de @cortex/agent-tools en un componente de cliente. ' +
        'Ese barril alcanza node:dns: compila en local, pasa el typecheck y rompe el ' +
        'build de producción. Usa `import type`, o copia lo que necesites a un ' +
        '`lib/*-shape.ts` como hace lib/reports-shape.ts.',
    ).toEqual([]);
  });
});

describe('normalizar el id de la herramienta', () => {
  it('acepta las dos grafías que llegan de verdad', () => {
    // El AI SDK nombra con guiones bajos; el registro declaró con punto; una
    // conversación archivada guarda la que hubiera ese día. Antes esto eran
    // cuatro predicados dobles escritos a mano.
    expect(normalizeToolId('reports.chart')).toBe('reports_chart');
    expect(normalizeToolId('reports_chart')).toBe('reports_chart');
    expect(resolveView('sales.draft_proposal').as).toBe('rich');
    expect(resolveView('sales_draft_proposal').as).toBe('rich');
  });

  it('lo que no está en ningún mapa sigue siendo un paso', () => {
    expect(resolveView('github.get_repo_contents').as).toBe('step');
  });
});

describe('la capa estructural', () => {
  it('convierte un único array de objetos planos en tabla', () => {
    const view = structuralView({
      flows: [
        { slug: 'runt', name: 'Consulta RUNT', site: 'runt.gov.co' },
        { slug: 'dian', name: 'RUT', site: 'dian.gov.co' },
      ],
      guidance: 'Usa browser.run_flow para los de consulta.',
    });
    expect(view).toMatchObject({
      kind: 'table',
      note: 'Usa browser.run_flow para los de consulta.',
    });
    expect(view?.kind === 'table' && view.columns).toEqual(['slug', 'name', 'site']);
  });

  it('no mete un objeto anidado en una celda', () => {
    // Una celda con `{...}` dentro es ilegible, y peor que el JSON entero
    // porque parece que hay un dato cuando lo que hay es un objeto.
    const view = structuralView({
      items: [{ id: 'a', owner: { name: 'Ana' }, total: 4 }],
    });
    expect(view?.kind === 'table' && view.columns).toEqual(['id', 'total']);
  });

  it('un objeto plano y corto se lee como campos', () => {
    const view = structuralView({ placa: 'ABC123', soat: '2027-01-10', multas: 2 });
    expect(view).toMatchObject({ kind: 'fields' });
    expect(view?.kind === 'fields' && view.entries).toHaveLength(3);
  });

  it('se rinde antes que adivinar', () => {
    // Dos arrays: no se sabe cuál es «el» contenido. Devolver null hace que
    // quien llama enseñe el JSON, que es exactamente lo que hacía antes —
    // dibujar una tabla que se come la mitad de los datos sería peor, porque
    // el JSON al menos se ve entero.
    expect(structuralView({ a: [{ x: 1 }], b: [{ y: 2 }] })).toBeNull();
    expect(structuralView('una frase')).toBeNull();
    expect(structuralView(null)).toBeNull();
  });

  it('no enseña el ruido de protocolo como si fuera contenido', () => {
    const view = structuralView({ ok: true, _security: { riskLevel: 'high' }, placa: 'ABC123' });
    expect(view?.kind === 'fields' && view.entries).toEqual([['placa', 'ABC123']]);
  });

  it('acota una lista larga en vez de pintar quinientas filas en el hilo', () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ id: String(i), n: i }));
    const view = structuralView({ rows });
    expect(view?.kind === 'table' && view.rows).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// Las tablas declaradas, contra el esquema de salida DE VERDAD
// ---------------------------------------------------------------------------

/**
 * LA PRUEBA QUE IMPIDE UNA TABLA LLENA DE RAYAS.
 *
 * Una entrada de `TABLE` nombra campos: cuál trae las filas, y cuáles se
 * enseñan. Nombrar uno que no existe NO FALLA en ninguna parte — sale una raya,
 * en silencio, en la columna de siempre, para todo el que use esa herramienta. Y
 * una raya es indistinguible de un dato que esa fila no traía, así que ni
 * siquiera se lee como un fallo: se lee como «no hay».
 *
 * Aquí se lee el `outputSchema` real de cada herramienta —se puede, porque esto
 * corre en Node y no en el navegador, que es la única razón por la que el
 * registro no puede hacerlo él mismo— y se comprueba campo por campo. Este es el
 * intercambio completo: el mapa se queda siendo datos puros, escribibles en
 * sesenta segundos por quien conoce la herramienta y no React, PORQUE hay algo
 * que verifica esos datos contra la fuente.
 */
describe('las tablas declaradas', () => {
  const BY_ID = new Map(listTools().map((t) => [normalizeToolId(t.id), t]));

  it('declara una herramienta que existe', () => {
    const unknown = Object.keys(TABLE).filter((id) => !BY_ID.has(id));
    expect(
      unknown,
      'Estas entradas de TABLE no corresponden a ninguna herramienta registrada.',
    ).toEqual([]);
  });

  it('nombra en `rows` un campo que de verdad trae un array de filas', () => {
    const offenders: string[] = [];
    for (const [id, spec] of Object.entries(TABLE)) {
      const tool = BY_ID.get(id);
      if (!tool) continue;
      const output = shapeOf(tool.outputSchema);
      if (!output) {
        offenders.push(`${id}: el outputSchema no es un objeto`);
        continue;
      }
      const rows = output[spec.rows];
      if (!rows) {
        offenders.push(`${id}: no hay campo "${spec.rows}" en el outputSchema`);
        continue;
      }
      if (!elementOf(rows)) offenders.push(`${id}: "${spec.rows}" no es un array de objetos`);
    }
    expect(offenders).toEqual([]);
  });

  it('nombra en cada columna un campo que existe en la fila', () => {
    const offenders: string[] = [];
    for (const [id, spec] of Object.entries(TABLE)) {
      const tool = BY_ID.get(id);
      if (!tool) continue;
      const output = shapeOf(tool.outputSchema);
      const rows = output?.[spec.rows];
      const row = rows ? elementOf(rows) : null;
      if (!row) continue; // ya lo dice la prueba de arriba

      for (const column of spec.columns) {
        // `a.b` baja un nivel, que es lo único que `DeclaredTable` sabe hacer.
        const [head, tail] = column.key.split('.', 2);
        const field = row[head ?? ''];
        if (!field) {
          offenders.push(`${id}.${column.key}: "${head}" no existe en la fila`);
          continue;
        }
        if (!tail) continue;
        const nested = shapeOf(field);
        if (!nested) {
          offenders.push(`${id}.${column.key}: "${head}" no es un objeto, no se le puede bajar`);
        } else if (!nested[tail]) {
          offenders.push(`${id}.${column.key}: "${tail}" no existe dentro de "${head}"`);
        }
      }
    }
    expect(
      offenders,
      'Cada uno de estos sale como una raya en la tabla, en silencio, para siempre.',
    ).toEqual([]);
  });

  it('cabe en el ancho de una conversación y dice algo cuando no hay nada', () => {
    for (const [id, spec] of Object.entries(TABLE)) {
      // Seis. Una tabla que no cabe en una burbuja de chat no es una tabla.
      expect(
        spec.columns.length,
        `${id} tiene ${spec.columns.length} columnas`,
      ).toBeLessThanOrEqual(6);
      expect(spec.columns.length, `${id} no tiene ninguna columna`).toBeGreaterThan(0);
      // Dos columnas con la misma clave son la misma columna dos veces, y React
      // además pierde una de ellas por la key repetida.
      expect(new Set(spec.columns.map((c) => c.key)).size, `${id} repite una columna`).toBe(
        spec.columns.length,
      );
      // `empty` es una frase que dice QUÉ SIGNIFICA que no haya nada, no una
      // etiqueta. "Sin resultados" no le sirve a nadie para decidir si volver a
      // preguntar; el punto final es la prueba barata de que es una frase.
      expect(
        spec.empty.length,
        `${id} tiene un vacío demasiado corto para explicar nada`,
      ).toBeGreaterThan(30);
      expect(spec.empty.trim().endsWith('.'), `${id}: "empty" no es una frase`).toBe(true);
    }
  });

  it('no declara la misma herramienta en las dos capas', () => {
    // Una herramienta con vista propia Y tabla declarada es una decisión sin
    // tomar: `resolveView` elige siempre la vista, y la tabla queda escrita para
    // nadie hasta que alguien la borre creyendo que hacía algo.
    const both = Object.keys(TABLE).filter((id) => id in RICH);
    expect(both).toEqual([]);
  });
});

/**
 * Zod, mirado por dentro con cuidado.
 *
 * Se lee `_def.typeName` en vez de usar `instanceof`: en un monorepo con pnpm no
 * hay ninguna garantía de que el `zod` que cargó el paquete y el que carga esta
 * prueba sean la MISMA copia, y con dos copias todo `instanceof` da falso y la
 * prueba pasaría siempre — que es la peor forma en la que puede fallar una
 * guardia.
 */
/** Lo poco que hace falta saber de un nodo de Zod para caminarlo. */
interface Node {
  _def?: { typeName?: string; [key: string]: unknown };
  shape?: Record<string, unknown>;
}

function node(value: unknown): Node | null {
  return value && typeof value === 'object' ? (value as Node) : null;
}

/** Quita envoltorios que no cambian la forma: opcional, nullable, default… */
function unwrap(schema: unknown): Node | null {
  let current = node(schema);
  for (let i = 0; i < 10 && current?._def; i++) {
    const def = current._def;
    switch (def.typeName) {
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
        current = node(def.innerType);
        break;
      case 'ZodEffects':
        current = node(def.schema);
        break;
      case 'ZodBranded':
      case 'ZodReadonly':
        current = node(def.type);
        break;
      default:
        return current;
    }
  }
  return current;
}

/** Los campos de un objeto, o `null` si no lo es. */
function shapeOf(schema: unknown): Record<string, unknown> | null {
  const inner = unwrap(schema);
  return inner?._def?.typeName === 'ZodObject' ? (inner.shape ?? null) : null;
}

/** Los campos de la fila de un array de objetos, o `null`. */
function elementOf(schema: unknown): Record<string, unknown> | null {
  const inner = unwrap(schema);
  if (inner?._def?.typeName !== 'ZodArray') return null;
  return shapeOf(inner._def.type);
}
