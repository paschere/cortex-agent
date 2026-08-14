import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeToolId, resolveView, structuralView } from './registry';

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
