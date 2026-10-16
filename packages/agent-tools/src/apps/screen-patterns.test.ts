import { describe, expect, it } from 'vitest';
import type { TrackerField } from '../trackers/schema';
import { checkSpecAgainst } from '../views/spec';
import {
  PATTERN_IDS,
  SCREEN_PATTERNS,
  buildScreenFromPattern,
  describePatterns,
  formStepsFor,
  inferFieldRoles,
} from './screen-patterns';

const f = (x: Partial<TrackerField> & Pick<TrackerField, 'key' | 'type'>): TrackerField =>
  ({ label: x.key, required: false, ...x }) as TrackerField;

const GUIAS = {
  slug: 'guias',
  name: 'Guías',
  fields: [
    f({ key: 'numero_guia', label: 'Número de guía', type: 'text', required: true }),
    f({ key: 'fecha', label: 'Fecha', type: 'date' }),
    f({ key: 'estado', label: 'Estado', type: 'select', options: ['Pendiente', 'Aprobada', 'Rechazada'] }),
    f({ key: 'ubicacion', label: 'Ubicación', type: 'text' }),
    f({ key: 'foto', label: 'Foto', type: 'file', accept: 'image' }),
    f({ key: 'observaciones', label: 'Observaciones', type: 'longtext' }),
    f({ key: 'registrado_por', label: 'Registrado por', type: 'text' }),
  ],
};

const VISITAS = {
  slug: 'visitas',
  name: 'Visitas',
  fields: [
    f({ key: 'cliente', label: 'Cliente', type: 'text', required: true }),
    f({ key: 'cita', label: 'Fecha de la cita', type: 'date' }),
    f({ key: 'hora', label: 'Hora', type: 'time' }),
    f({ key: 'situacion', label: 'Situación', type: 'select', options: ['Programada', 'En camino', 'Hecha'] }),
    f({ key: 'sitio', label: 'Sitio', type: 'location' }),
    f({ key: 'valor', label: 'Valor cobrado', type: 'money' }),
    f({ key: 'tecnico', label: 'Técnico', type: 'text' }),
  ],
};

const TICKETS = {
  slug: 'tickets',
  name: 'Tickets',
  fields: [f({ key: 'asunto', label: 'Asunto', type: 'text' }), f({ key: 'nota', label: 'Nota', type: 'longtext' })],
};

describe('inferFieldRoles', () => {
  it('reconoce estado, fecha, foto y título por tipo y nombre', () => {
    const r = inferFieldRoles(GUIAS);
    expect(r).toMatchObject({ title: 'numero_guia', status: 'estado', date: 'fecha', photo: 'foto', place: 'ubicacion', notes: 'observaciones' });
  });
  it('reconoce monto, hora, ubicación y cliente en otra tabla', () => {
    const r = inferFieldRoles(VISITAS);
    expect(r).toMatchObject({ title: 'cliente', status: 'situacion', date: 'cita', time: 'hora', location: 'sitio', amount: 'valor' });
  });
  it('una tabla pobre cae en label y no inventa', () => {
    const r = inferFieldRoles({ slug: 'x', name: 'X', fields: [f({ key: 'n', type: 'number' })] });
    expect(r.title).toBe('label');
    expect(r.status).toBeUndefined();
    expect(r.location).toBeUndefined();
  });
});

describe('buildScreenFromPattern', () => {
  for (const table of [GUIAS, VISITAS]) {
    for (const id of PATTERN_IDS) {
      it(`${id} sobre ${table.slug} produce una pantalla válida contra la tabla (o explica qué falta)`, () => {
        const res = buildScreenFromPattern(id, table);
        if (!res.ok) {
          expect(res.reason.length).toBeGreaterThan(10);
          expect(res.missing.length).toBeGreaterThan(0);
          return;
        }
        expect(checkSpecAgainst(res.screen.spec, [table as never])).toEqual([]);
        // el vocabulario de `design` de los patrones lo acepta el esquema vigente
        expect(res.hadDesign).toBe(true);
        expect(res.screen.spec.blocks.length).toBeGreaterThanOrEqual(1);
        expect(res.screen.spec.blocks.length).toBeLessThanOrEqual(8);
      });
    }
  }

  it('el mapa exige un campo de ubicación y lo dice', () => {
    const res = buildScreenFromPattern('mapa_con_lista', GUIAS);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.missing).toEqual(['location']);
    expect(buildScreenFromPattern('mapa_con_lista', VISITAS).ok).toBe(true);
  });

  it('un patrón desconocido no lanza', () => {
    const res = buildScreenFromPattern('nada', GUIAS);
    expect(res.ok).toBe(false);
  });

  it('mi lista de hoy: operario, tarjetas con estado y detalle', () => {
    const res = buildScreenFromPattern('mi_lista_hoy', GUIAS, { roles: ['operario'] });
    if (!res.ok) throw new Error(res.reason);
    const { spec } = res.screen;
    expect(spec.theme?.layout).toBe('operator');
    const types = spec.blocks.map((b) => b.type);
    expect(types).toEqual(['metric', 'metric', 'cards', 'detail']);
    const cards = spec.blocks.find((b) => b.type === 'cards');
    expect(cards).toMatchObject({ statusField: 'estado', imageField: 'foto', dateField: 'fecha' });
    expect(res.screen.roles).toEqual(['operario']);
    // el esquema vigente conoce `design`: se conserva con su vocabulario real
    expect(res.hadDesign).toBe(true);
    expect(cards).toMatchObject({ design: { emphasis: 'strong', variant: 'image' } });
  });

  it('registrar: por pasos y con voz, sin pedir el estado', () => {
    const res = buildScreenFromPattern('registrar', GUIAS);
    if (!res.ok) throw new Error(res.reason);
    const form = res.screen.spec.blocks[0];
    expect(form?.type).toBe('form');
    if (form?.type !== 'form') return;
    expect(form.fields).not.toContain('estado');
    expect(form.steps?.length).toBeGreaterThan(1);
    expect(form.voice).toBe('conversation');
    for (const s of form.steps ?? []) expect(s.fields.length).toBeLessThanOrEqual(6);
  });

  it('tablero: columnas por estado, arrastrable, con Aprobar y Rechazar', () => {
    const res = buildScreenFromPattern('tablero_estado', GUIAS);
    if (!res.ok) throw new Error(res.reason);
    const board = res.screen.spec.blocks.find((b) => b.type === 'board');
    expect(board).toMatchObject({ groupBy: 'estado', draggable: true });
    if (board?.type === 'board') expect(board.actions.map((a) => a.label)).toEqual(['Aprobar', 'Rechazar']);
  });

  it('tablero sin estado explica qué falta', () => {
    const res = buildScreenFromPattern('tablero_estado', TICKETS);
    expect(res.ok).toBe(false);
  });

  it('panel gerencial: métricas arriba comparadas, dos gráficos y ranking; dinero en pesos', () => {
    const res = buildScreenFromPattern('panel_gerencial', VISITAS);
    if (!res.ok) throw new Error(res.reason);
    const blocks = res.screen.spec.blocks;
    expect(blocks.slice(0, 3).every((b) => b.type === 'metric')).toBe(true);
    expect(blocks.filter((b) => b.type === 'chart')).toHaveLength(2);
    expect(blocks.some((b) => b.type === 'progress')).toBe(true);
    expect(blocks.some((b) => b.type === 'form')).toBe(false);
    const total = blocks.find((b) => b.id === 'total_monto');
    expect(total).toMatchObject({ format: 'money', compare: 'previous_period' });
  });

  it('TV: dark-panel, rota, sin formularios ni botones', () => {
    const res = buildScreenFromPattern('pantalla_planta_tv', GUIAS);
    if (!res.ok) throw new Error(res.reason);
    expect(res.screen.spec.theme).toMatchObject({ layout: 'tv', style: 'dark-panel' });
    expect(res.screen.spec.pages?.length).toBeGreaterThanOrEqual(1);
    expect(res.screen.spec.blocks.some((b) => b.type === 'form')).toBe(false);
  });

  it('portal: cabecera hero', () => {
    const res = buildScreenFromPattern('portal_cliente', VISITAS);
    if (!res.ok) throw new Error(res.reason);
    expect(res.screen.spec.theme?.header).toBe('hero');
  });

  it('el detalle incluye como relacionadas las tablas que apuntan a la suya', () => {
    const notas = {
      slug: 'notas',
      name: 'Notas',
      fields: [f({ key: 'texto', type: 'text' }), f({ key: 'guia', type: 'relation', tracker: 'guias' })],
    };
    const res = buildScreenFromPattern('detalle_linea_tiempo', GUIAS, { relatedTables: [notas] });
    if (!res.ok) throw new Error(res.reason);
    const detail = res.screen.spec.blocks.find((b) => b.type === 'detail');
    if (detail?.type === 'detail') expect(detail.related[0]).toMatchObject({ tracker: 'notas', field: 'guia' });
  });

  it('sin includeDesign no emite design', () => {
    const res = buildScreenFromPattern('mi_lista_hoy', GUIAS, { includeDesign: false });
    if (!res.ok) throw new Error(res.reason);
    expect(res.hadDesign).toBe(false);
    expect(res.screen.spec.blocks.some((b) => 'design' in b)).toBe(false);
  });
});

describe('catálogo', () => {
  it('cada patrón está descrito y el texto los nombra todos', () => {
    expect(SCREEN_PATTERNS.map((p) => p.id)).toEqual([...PATTERN_IDS]);
    const text = describePatterns();
    for (const id of PATTERN_IDS) expect(text).toContain(id);
  });
  it('formStepsFor reparte los campos sin repetir ni pasarse de 6', () => {
    const many = {
      slug: 'm',
      name: 'M',
      fields: Array.from({ length: 14 }, (_, i) => f({ key: `c${i}`, type: i % 2 ? 'number' : 'text' })),
    };
    const steps = formStepsFor(many, many.fields.map((x) => x.key));
    const flat = steps.flatMap((s) => s.fields);
    expect(new Set(flat).size).toBe(14);
    expect(steps.every((s) => s.fields.length <= 6)).toBe(true);
  });
});
