import { describe, expect, it } from 'vitest';
import { trackerFieldSchema } from '../trackers/schema';
import { appDraftSchema } from './design';
import { buildAppPreview } from './draft';
import { describeWouldSave } from './sample-screen';
import { APP_TEMPLATES } from './templates';

const f = (x: Record<string, unknown>) => trackerFieldSchema.parse(x);

describe('describeWouldSave', () => {
  const fields = [
    f({ key: 'numero', label: 'Número', type: 'text' }),
    f({ key: 'kilos', label: 'Kilos', type: 'number' }),
    f({ key: 'urgente', label: 'Urgente', type: 'checkbox' }),
    f({ key: 'nota', label: 'Nota', type: 'longtext' }),
  ];
  it('lista sólo lo que trae valor, con el nombre del campo', () => {
    expect(describeWouldSave(fields, { numero: 'GU-1', kilos: 12, urgente: 1, nota: '' })).toBe(
      'Número: GU-1 · Kilos: 12 · Urgente: Sí',
    );
  });
  it('sin valores dice que sería una fila vacía', () => {
    expect(describeWouldSave(fields, {})).toBe('una fila vacía');
  });
  it('recorta los textos largos', () => {
    const out = describeWouldSave(fields, { nota: 'x'.repeat(200) });
    expect(out.length).toBeLessThan(80);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('buildAppPreview para una pantalla de una app real', () => {
  const tpl = APP_TEMPLATES[0] as (typeof APP_TEMPLATES)[number];
  const draft = appDraftSchema.parse({
    name: tpl.name,
    description: tpl.body,
    icon: tpl.icon,
    roles: tpl.roles,
    screens: tpl.screens.map((s) => ({
      title: s.title,
      slug: s.slug,
      icon: s.icon,
      roles: s.roles,
      spec: s.spec,
    })),
    homeScreen: tpl.homeScreen,
    tables: tpl.trackers.map((t) => ({
      slug: t.slug,
      name: t.name,
      description: t.description,
      fields: t.fields,
    })),
  });

  it('`only` calcula sólo las pantallas pedidas', () => {
    const first = draft.screens[0]?.slug ?? '';
    const all = buildAppPreview(draft, []);
    const one = buildAppPreview(draft, [], { only: [first] });
    expect(Object.keys(all.views).length).toBeGreaterThan(1);
    expect(Object.keys(one.views)).toEqual([first]);
  });

  it('las filas son de ejemplo y las mismas cada vez (nada real, nada que parpadee)', () => {
    const slug = draft.screens[0]?.slug ?? '';
    const now = new Date('2026-10-19T15:00:00Z');
    const a = buildAppPreview(draft, [], { only: [slug], now });
    const b = buildAppPreview(draft, [], { only: [slug], now });
    expect(JSON.stringify(a.views[slug])).toBe(JSON.stringify(b.views[slug]));
    expect(a.samples.length).toBeGreaterThan(0);
    expect(a.notes.join(' ')).toMatch(/no se guardan/);
  });
});
