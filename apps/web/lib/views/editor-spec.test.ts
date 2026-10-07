import {
  type CatalogTracker,
  PLATFORM_SOURCES,
  type ViewSpec,
  blockSchema,
  checkSpecAgainst,
  viewSpecSchema,
} from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import { KNOWN_BLOCK_TYPES } from './editor-shape';
import {
  type EditorSource,
  duplicateBlock,
  moveBlock,
  newBlock,
  problemsFromCheck,
  problemsFromZod,
  removeBlock,
  uniqueBlockId,
  withSource,
} from './editor-spec';
import { STARTER_TEMPLATES } from './starter-templates';

/**
 * Lo que el lienzo le hace a un spec, sin navegador. La prueba que importa es
 * la de las plantillas: un bloque recién salido de la paleta tiene que pasar
 * el MISMO contrato y la MISMA comprobación de catálogo que un guardado, o el
 * primer clic de alguien termina en un aviso amarillo.
 */

const remates: EditorSource = {
  slug: 'remates',
  name: 'Remates',
  description: '',
  kind: 'tracker',
  sensitivity: 'shareable',
  readOnly: false,
  fields: [
    {
      key: 'ciudad',
      label: 'Ciudad',
      type: 'select',
      required: false,
      options: ['Bogotá', 'Cali'],
    },
    { key: 'valor', label: 'Valor', type: 'money', required: false },
    { key: 'cierre', label: 'Cierre', type: 'date', required: false },
    { key: 'notas', label: 'Notas', type: 'text', required: false },
  ],
};

const platform: EditorSource[] = [...PLATFORM_SOURCES.values()].map((s) => ({
  slug: s.id,
  name: s.name,
  description: s.description,
  kind: 'platform',
  sensitivity: s.sensitivity,
  readOnly: true,
  fields: s.fields,
}));

const catalogOf = (sources: EditorSource[]): CatalogTracker[] =>
  sources.map((s) => ({ slug: s.slug, name: s.name, fields: s.fields }));

const base = (): ViewSpec =>
  viewSpecSchema.parse({
    version: 1,
    blocks: [
      { id: 'a', type: 'text', markdown: 'Hola' },
      { id: 'b', type: 'metric', title: 'Remates', tracker: 'remates' },
      { id: 'c', type: 'table', title: 'Lista', tracker: 'remates' },
    ],
  });

describe('operaciones del lienzo', () => {
  it('mueve, duplica y borra sin tocar el spec original', () => {
    const spec = base();
    const moved = moveBlock(spec, 2, 0);
    expect(moved.blocks.map((b) => b.id)).toEqual(['c', 'a', 'b']);
    expect(spec.blocks.map((b) => b.id)).toEqual(['a', 'b', 'c']);
    expect(moveBlock(spec, 0, 9)).toBe(spec);

    const dup = duplicateBlock(spec, 'b');
    expect(dup.spec.blocks.map((b) => b.id)).toEqual(['a', 'b', 'b_2', 'c']);
    expect(dup.spec.blocks[2]).toMatchObject({ title: 'Remates (copia)' });
    expect(viewSpecSchema.safeParse(dup.spec).success).toBe(true);

    const gone = removeBlock(spec, 'b');
    expect(gone.removed?.id).toBe('b');
    expect(gone.index).toBe(1);
    expect(gone.spec.blocks).toHaveLength(2);
  });

  it('no borra el último bloque: una vista necesita al menos uno', () => {
    const one = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 'a', type: 'text', markdown: 'Hola' }],
    });
    expect(removeBlock(one, 'a').removed).toBeNull();
  });

  it('inventa ids libres que cumplen el patrón', () => {
    const spec = base();
    expect(uniqueBlockId(spec, 'Gráfico')).toBe('grafico');
    expect(uniqueBlockId(spec, 'a')).toBe('a_2');
  });

  it('cada plantilla de la paleta pasa el contrato y el catálogo', () => {
    const sources = [remates, ...platform];
    for (const type of KNOWN_BLOCK_TYPES) {
      let spec = base();
      // El asistente de voz maneja un formulario de la vista: sin uno no nace.
      if (type === 'voice') {
        expect(newBlock('voice', spec, sources)).toBeNull();
        const form = newBlock('form', spec, sources) as ViewSpec['blocks'][number];
        spec = { ...spec, blocks: [...spec.blocks, form] };
      }
      const block = newBlock(type, spec, sources);
      expect(block, type).not.toBeNull();
      const next = { ...spec, blocks: [...spec.blocks, block as ViewSpec['blocks'][number]] };
      const parsed = viewSpecSchema.safeParse(next);
      expect(parsed.success, `${type}: ${parsed.error?.message}`).toBe(true);
      if (parsed.success)
        expect(checkSpecAgainst(parsed.data, catalogOf(sources)), type).toEqual([]);
    }
  });

  it('el plano (zones) sale válido cuando el contrato lo acepta', () => {
    const accepted = blockSchema.options.map((o) => o.shape.type.value as string);
    if (!accepted.includes('zones')) return;
    const spec = base();
    const block = newBlock('zones', spec, [remates]);
    const parsed = viewSpecSchema.safeParse({ ...spec, blocks: [...spec.blocks, block] });
    expect(parsed.success, parsed.error?.message).toBe(true);
    if (parsed.success) expect(checkSpecAgainst(parsed.data, catalogOf([remates]))).toEqual([]);
  });

  it('sin tablas propias no ofrece formulario, y el tablero busca un campo de opciones', () => {
    const spec = base();
    expect(newBlock('form', spec, platform)).toBeNull();
    const board = newBlock('board', spec, platform);
    expect(board).not.toBeNull();
    const parsed = viewSpecSchema.parse({ ...spec, blocks: [...spec.blocks.slice(0, 1), board] });
    expect(checkSpecAgainst(parsed, catalogOf(platform))).toEqual([]);
  });

  it('cambiar la fuente limpia lo que nombraba campos de la anterior', () => {
    const spec = base();
    const table = {
      ...spec.blocks[2],
      columns: ['valor'],
      editable: ['valor'],
    } as ViewSpec['blocks'][number];
    const ventas = platform.find((s) => s.slug === 'cortex.ventas') as EditorSource;
    const moved = withSource(table, ventas);
    expect(moved).toMatchObject({
      tracker: 'cortex.ventas',
      columns: [],
      editable: [],
      filters: [],
    });
  });
});

describe('problemas pegados a su bloque', () => {
  it('ata los de forma por posición y los dice en español', () => {
    const raw = {
      version: 1,
      blocks: [
        { id: 'a', type: 'text', markdown: 'Hola' },
        { id: 'b', type: 'metric', title: '', tracker: 'remates' },
      ],
    };
    const parsed = viewSpecSchema.safeParse(raw);
    expect(parsed.success).toBe(false);
    const problems = problemsFromZod(parsed.error?.issues ?? [], raw);
    expect(problems[0]).toEqual({ blockId: 'b', message: '«Título» no puede quedar vacío.' });
  });

  it('ata los del catálogo por el id que nombran y traduce operadores', () => {
    expect(
      problemsFromCheck([
        'Bloque «b»: «precio» no es un campo de Remates (cifra).',
        'Alerta «x»: «y» no existe.',
        'La vista tiene columnas editables, tableros que se arrastran o botones, pero `editing` está en "off": ponlo en "team" o "public" para que funcionen.',
      ]),
    ).toEqual([
      { blockId: 'b', message: '«precio» no es un campo de Remates (cifra).' },
      { alertId: 'x', message: '«y» no existe.' },
      { message: expect.stringContaining('Ajustes de la vista') },
    ]);
  });
});

describe('plantillas de inicio', () => {
  it('las que traen spec pasan el contrato y el catálogo de la plataforma', () => {
    for (const t of STARTER_TEMPLATES) {
      if (t.kind !== 'spec') continue;
      const parsed = viewSpecSchema.safeParse(t.spec);
      expect(parsed.success, t.id).toBe(true);
      if (parsed.success)
        expect(checkSpecAgainst(parsed.data, catalogOf(platform)), t.id).toEqual([]);
    }
  });
});
