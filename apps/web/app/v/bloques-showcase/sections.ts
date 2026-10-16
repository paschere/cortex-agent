import type { ComputedBlock, ComputedView } from '@cortex/agent-tools';
import {
  BLOCK_VARIANTS,
  DESIGN_TONES,
  EMPHASES,
  SIZES,
  SURFACES,
  VARIANT_LABEL,
  type BlockDesign,
} from '@cortex/agent-tools/src/views/design-shape';
import { showcaseView } from '../views-showcase/fixture';
import { screensView } from '../views-showcase/screens-fixture';

export const SECTIONS = [
  'superficies',
  'tamanos',
  'metric',
  'cards',
  'table',
  'board',
  'chart',
  'detail',
  'calendar',
  'gallery',
  'progress',
  'links',
  'text',
  'editor',
] as const;

const pool = (): ComputedBlock[] => [
  ...showcaseView().blocks,
  ...screensView('tarjetas', {}).blocks,
  ...screensView('detalle', {}).blocks,
];

/** Un bloque de ese tipo (y, si se pide, ese id) de las fixtures. */
function pick(blocks: ComputedBlock[], type: string, id?: string): ComputedBlock {
  const found = blocks.find((b) => b.type === type && (!id || b.id === id)) ?? blocks.find((b) => b.type === type);
  if (!found) throw new Error(`Sin fixture de ${type}`);
  return found;
}

function withDesign(b: ComputedBlock, id: string, design: BlockDesign, extra: Partial<{ title: string }> = {}): ComputedBlock {
  return { ...b, id, width: 'half', design, ...extra } as ComputedBlock;
}

export function sectionBlocks(section: string): ComputedBlock[] {
  const all = pool();
  if (section === 'superficies') {
    const metric = pick(all, 'metric', 'ventas');
    const out: ComputedBlock[] = SURFACES.map((s) =>
      withDesign(metric, `sf-${s}`, { surface: s, icon: 'DollarSign' }, { title: `Superficie ${s}` }),
    );
    const cards = pick(all, 'chart', 'por-ciudad');
    out.push(...(['hero', 'tinted'] as const).flatMap((s) =>
      DESIGN_TONES.slice(1).map((t) => withDesign(cards, `sf-${s}-${t}`, { surface: s, tone: t }, { title: `${s} · ${t}` })),
    ));
    EMPHASES.forEach((e) =>
      out.push(withDesign(metric, `em-${e}`, { emphasis: e }, { title: `Énfasis ${e}` })),
    );
    out.push(withDesign(metric, 'sin-titulo', { title: 'hidden', surface: 'outline' }, { title: 'Título oculto' }));
    out.push(withDesign(pick(all, 'text'), 'tx-hero', { surface: 'hero' }));
    out.push(withDesign(pick(all, 'text'), 'tx-card', { surface: 'card' }));
    return out;
  }
  if (section === 'tamanos') {
    const m = pick(all, 'metric', 'ventas');
    const out: ComputedBlock[] = [];
    SIZES.forEach((s) => out.push({ ...m, id: `sz-${s}`, design: { size: s }, title: `size ${s}` } as ComputedBlock));
    (['compact', 'tall'] as const).forEach((h) =>
      out.push({ ...m, id: `h-${h}`, design: { size: 'third', height: h }, title: `altura ${h}` } as ComputedBlock),
    );
    return out;
  }
  const variants = (BLOCK_VARIANTS as Record<string, readonly string[]>)[section];
  if (!variants) return [];
  const base = pick(all, section, section === 'metric' ? 'ventas' : section === 'chart' ? 'tendencia' : undefined);
  const wide = ['cards', 'table', 'board', 'detail', 'calendar', 'gallery'].includes(section);
  const out: ComputedBlock[] = [
    { ...base, id: `v-default`, width: wide ? 'full' : 'half', title: 'title' in base ? `${base.title} · sin variante` : undefined } as ComputedBlock,
  ];
  variants.forEach((v) =>
    out.push({
      ...base,
      id: `v-${v}`,
      width: wide ? 'full' : 'half',
      design: { variant: v },
      ...('title' in base ? { title: `${(base as { title?: string }).title ?? ''} · ${VARIANT_LABEL[v] ?? v}` } : {}),
    } as ComputedBlock),
  );
  if (section === 'metric') {
    // Con meta y con serie, para el anillo y la línea.
    const goalMetric = pick(all, 'metric', 'cartera');
    out.push({ ...goalMetric, id: 'v-ring-goal', width: 'half', design: { variant: 'ring' } } as ComputedBlock);
    out.push({ ...goalMetric, id: 'v-split-goal', width: 'half', design: { variant: 'split' } } as ComputedBlock);
    out.push({ ...pick(all, 'metric', 'devoluciones'), id: 'v-compare-down', width: 'half', design: { variant: 'compare', surface: 'hero' } } as ComputedBlock);
  }
  return out;
}


export function buildView(section: string, layout: string | null): ComputedView {
  const base = showcaseView();
  return {
    ...base,
    blocks: sectionBlocks(section),
    filtersBar: [],
    pages: [],
    alerts: [],
    theme: {
      ...(base.theme as NonNullable<ComputedView['theme']>),
      ...(layout === 'operario' ? { layout: 'operator' as const } : {}),
      ...(layout === 'tv' ? { layout: 'tv' as const } : {}),
    },
  };
}
