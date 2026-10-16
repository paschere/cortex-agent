import { describe, expect, it } from 'vitest';
import {
  BLOCK_VARIANTS,
  describeDesign,
  designSchemaFor,
  gridSpanClass,
  hasDesign,
  variantOf,
} from './design-shape';
import { blockSchema, viewSpecSchema } from './spec';

const metric = { id: 'm1', type: 'metric', title: 'Ventas', tracker: 'ventas' };

describe('design de los bloques', () => {
  it('un spec viejo, sin design, sigue siendo válido y no gana design', () => {
    const r = blockSchema.parse(metric);
    expect('design' in r && r.design !== undefined).toBe(false);
    const spec = viewSpecSchema.parse({ version: 1, blocks: [metric] });
    expect(spec.blocks).toHaveLength(1);
  });

  it('acepta un design completo', () => {
    const r = blockSchema.parse({
      ...metric,
      design: { surface: 'hero', size: 'two-thirds', height: 'tall', tone: 'emerald', emphasis: 'strong', title: 'hidden', icon: 'BarChart3', variant: 'ring' },
    });
    expect(r.design?.variant).toBe('ring');
  });

  it('rechaza opciones inválidas con mensaje en español', () => {
    const bad = blockSchema.safeParse({ ...metric, design: { surface: 'neón' } });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('«design.surface» admite');
    const v = blockSchema.safeParse({ ...metric, design: { variant: 'zebra' } });
    expect(v.success).toBe(false);
    expect(JSON.stringify(v.error?.issues)).toContain('«design.variant» admite');
  });

  it('rechaza claves desconocidas y variantes en bloques que no las tienen', () => {
    const k = blockSchema.safeParse({ ...metric, design: { color: 'rojo' } });
    expect(JSON.stringify(k.error?.issues)).toContain('«design» no tiene «color»');
    const m = designSchemaFor('map').safeParse({ variant: 'x' });
    expect(m.success).toBe(false);
    expect(JSON.stringify(m.error?.issues)).toContain('no tienen variantes');
  });

  it('cada tipo con variantes acepta todas las suyas', () => {
    for (const [type, list] of Object.entries(BLOCK_VARIANTS))
      for (const v of list) expect(designSchemaFor(type).safeParse({ variant: v }).success).toBe(true);
  });

  it('la rejilla respeta size sobre width', () => {
    expect(gridSpanClass('third')).toBe('md:col-span-3 xl:col-span-2');
    expect(gridSpanClass('third', { size: 'two-thirds' })).toBe('md:col-span-4');
    expect(gridSpanClass('half', { size: 'auto' })).toBe('md:col-span-3');
    expect(gridSpanClass('half', { size: 'full' })).toBe('md:col-span-6');
  });

  it('variantOf solo devuelve la pedida y de ese tipo', () => {
    expect(variantOf('metric', undefined)).toBeUndefined();
    expect(variantOf('metric', { variant: 'ring' })).toBe('ring');
    expect(variantOf('metric', { variant: 'zebra' })).toBeUndefined();
  });

  it('describeDesign y hasDesign', () => {
    expect(hasDesign({})).toBe(false);
    expect(describeDesign(undefined)).toBe('Diseño de siempre');
    expect(describeDesign({ surface: 'hero', size: 'half', variant: 'ring' })).toBe('Destacada · 1/2 · Anillo');
  });
});
