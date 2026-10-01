import { describe, expect, it } from 'vitest';
import { type ViewSource, blockWriteFields, computeView } from './compute';
import { embedSrc, httpsUrl, safeHref } from './embeds';
import { type CatalogTracker, checkSpecAgainst, viewSpecSchema } from './spec';
import { encodeViewFilterState, parseViewFilterParam } from './view-filters';

/**
 * La biblioteca de bloques nueva: galería, calendario, avance, imagen o video,
 * botones, el KPI contra el período anterior, la ficha de una fila, la barra
 * de filtros, las páginas y el aspecto. Lo que importa probar es lo que
 * protege: qué direcciones pasan, qué campos viajan afuera, qué se puede
 * escribir y que un filtro no deje cifras de un lado y tablas del otro.
 */

const citas: CatalogTracker = {
  slug: 'citas',
  name: 'Citas',
  fields: [
    { key: 'paciente', label: 'Paciente', type: 'text', required: true },
    { key: 'fecha', label: 'Fecha', type: 'date', required: false },
    {
      key: 'sede',
      label: 'Sede',
      type: 'select',
      required: false,
      options: ['Bogotá', 'Cali', 'Medellín'],
    },
    { key: 'valor', label: 'Valor', type: 'money', required: false },
    { key: 'foto', label: 'Foto', type: 'text', required: false },
    { key: 'telefono', label: 'Teléfono', type: 'text', required: false },
  ],
};

const row = (id: string, values: Record<string, string | number>, created = '2026-09-10') => ({
  id,
  label: String(values.paciente ?? id),
  values,
  created_at: `${created}T15:00:00Z`,
  updated_at: `${created}T15:00:00Z`,
});

const ROWS = [
  row('1', {
    paciente: 'Ana',
    fecha: '2026-09-25',
    sede: 'Bogotá',
    valor: 100,
    foto: 'https://cdn.example.com/ana.jpg',
    telefono: '300 111',
  }),
  row('2', {
    paciente: 'Beto',
    fecha: '2026-09-30',
    sede: 'Cali',
    valor: 300,
    foto: 'javascript:alert(1)',
    telefono: '300 222',
  }),
  row('3', { paciente: 'Caro', fecha: '2026-08-20', sede: 'Cali', valor: 50 }),
  row('4', { paciente: 'Dani', fecha: '2026-10-02', sede: 'Medellín', valor: 70 }),
  row('5', { paciente: 'Eva', fecha: '2027-01-05', sede: 'Bogotá', valor: 10 }),
];

const sources = () =>
  new Map<string, ViewSource>([['citas', { tracker: citas, truncated: false, rows: ROWS }]]);
const NOW = new Date('2026-09-28T17:00:00Z');

const spec = (blocks: unknown[], extra: Record<string, unknown> = {}) =>
  viewSpecSchema.parse({ version: 1, blocks, ...extra });

describe('direcciones: lo único que entra es https, y los embeds de la lista', () => {
  it('httpsUrl rechaza todo lo que no es https público', () => {
    expect(httpsUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    for (const bad of [
      'javascript:alert(1)',
      'http://example.com/a.png',
      'data:image/png;base64,AAAA',
      'https://localhost/a.png',
      'https://192.168.0.1/a.png',
      'https://user:pw@example.com/a.png',
      'https://example .com/a.png',
      '//example.com/a.png',
    ])
      expect(httpsUrl(bad), bad).toBeNull();
  });

  it('traduce YouTube, Maps, Loom, Slides y Docs a su dirección de inserción', () => {
    expect(embedSrc('https://www.youtube.com/watch?v=dQw4w9WgXcQ')?.src).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
    expect(embedSrc('https://youtu.be/dQw4w9WgXcQ?t=3')?.provider).toBe('youtube');
    expect(embedSrc('https://www.google.com/maps/embed?pb=!1m18!1m12!1m3')?.src).toBe(
      'https://www.google.com/maps/embed?pb=!1m18!1m12!1m3',
    );
    expect(embedSrc('https://www.loom.com/share/0123456789abcdef0123456789abcdef')?.src).toBe(
      'https://www.loom.com/embed/0123456789abcdef0123456789abcdef',
    );
    const pub = '2PACX-1vT0123456789abcdefghijklmnopqrstuv';
    expect(embedSrc(`https://docs.google.com/presentation/d/e/${pub}/pub?start=false`)?.src).toBe(
      `https://docs.google.com/presentation/d/e/${pub}/embed?start=false&loop=false`,
    );
    expect(embedSrc(`https://docs.google.com/document/d/e/${pub}/pub`)?.provider).toBe('docs');
  });

  it('no inserta nada fuera de la lista ni documentos privados', () => {
    for (const bad of [
      'https://vimeo.com/123456',
      'https://www.google.com/maps/place/Bogota',
      'https://docs.google.com/document/d/1abcdefghijklmnopqrstuvwxyz/edit',
      'https://evil.example.com/youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=<script>',
    ])
      expect(embedSrc(bad), bad).toBeNull();
  });

  it('un botón va a una ruta interna o a https, nunca a otro dominio disfrazado', () => {
    expect(safeHref('/views/cartera')).toEqual({ href: '/views/cartera', external: false });
    expect(safeHref('https://example.com')?.external).toBe(true);
    for (const bad of ['//evil.com', '/\\evil.com', 'javascript:alert(1)', 'http://x.com', ''])
      expect(safeHref(bad), bad).toBeNull();
  });
});

describe('el contrato de los bloques nuevos', () => {
  it('rechaza una inserción fuera de la lista, un avance sin meta y un KPI sin fecha', () => {
    const bad = viewSpecSchema.safeParse({
      version: 1,
      blocks: [
        { id: 'v', type: 'media', kind: 'embed', url: 'https://vimeo.com/1' },
        { id: 'p', type: 'progress', title: 'Avance', tracker: 'citas' },
        { id: 'k', type: 'metric', title: 'K', tracker: 'citas', compare: 'previous_period' },
      ],
    });
    expect(bad.success).toBe(false);
    const paths = bad.error?.issues.map((i) => i.path.join('.')) ?? [];
    expect(paths).toEqual(
      expect.arrayContaining(['blocks.0.url', 'blocks.1.target', 'blocks.2.dateField']),
    );
  });

  it('una imagen sin https no pasa la forma; un botón con javascript tampoco', () => {
    expect(
      viewSpecSchema.safeParse({
        version: 1,
        blocks: [{ id: 'm', type: 'media', url: 'http://x.com/a.png' }],
      }).success,
    ).toBe(false);
    expect(
      viewSpecSchema.safeParse({
        version: 1,
        blocks: [{ id: 'l', type: 'links', links: [{ label: 'X', href: 'javascript:1' }] }],
      }).success,
    ).toBe(false);
  });

  it('páginas que nombran bloques que no existen y filtros repetidos', () => {
    const bad = viewSpecSchema.safeParse({
      version: 1,
      blocks: [{ id: 'a', type: 'text', markdown: 'x' }],
      pages: [{ id: 'p1', title: 'Uno', blockIds: ['a', 'zz'] }],
      filtersBar: [
        { id: 'f', label: 'Sede', source: 'citas', field: 'sede', kind: 'select' },
        { id: 'f', label: 'Sede 2', source: 'citas', field: 'sede', kind: 'select' },
      ],
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues.map((i) => i.path.join('.'))).toEqual(
      expect.arrayContaining(['pages.0.blockIds', 'filtersBar.1.id']),
    );
  });

  it('comprueba los tipos de campo contra el catálogo', () => {
    const s = spec([
      { id: 'g', type: 'gallery', title: 'G', tracker: 'citas', badgeField: 'paciente' },
      { id: 'c', type: 'calendar', title: 'C', tracker: 'citas', dateField: 'sede' },
      {
        id: 'k',
        type: 'metric',
        title: 'K',
        tracker: 'citas',
        compare: 'previous_period',
        dateField: 'valor',
      },
    ]);
    const problems = checkSpecAgainst(s, [citas]);
    expect(problems.join(' ')).toContain('«paciente» no es un campo de opciones');
    expect(problems.join(' ')).toContain('«sede» no es un campo de fecha');
    expect(problems.join(' ')).toContain('«valor» no es un campo de fecha');
  });

  it('la ficha no edita fuentes de sólo lectura, y editar pide `editing`', () => {
    const ventas: CatalogTracker = { slug: 'cortex.ventas', name: 'Ventas', fields: citas.fields };
    const platform = spec([
      { id: 't', type: 'table', title: 'T', tracker: 'cortex.ventas', recordEditable: ['sede'] },
    ]);
    expect(checkSpecAgainst(platform, [ventas]).join(' ')).toContain('sólo lectura');

    const own = spec([
      { id: 'g', type: 'gallery', title: 'G', tracker: 'citas', recordEditable: ['sede'] },
    ]);
    expect(checkSpecAgainst(own, [citas]).join(' ')).toContain('`editing`');
    expect(checkSpecAgainst({ ...own, editing: 'team' }, [citas])).toEqual([]);
  });

  it('la barra de filtros: la fuente tiene que estar en algún bloque y el rango sobre fechas', () => {
    const s = spec([{ id: 'm', type: 'metric', title: 'M', tracker: 'citas' }], {
      filtersBar: [
        { id: 'a', label: 'A', source: 'otra', field: 'x', kind: 'select' },
        { id: 'b', label: 'B', source: 'citas', field: 'sede', kind: 'date_range' },
      ],
    });
    const problems = checkSpecAgainst(s, [citas, { slug: 'otra', name: 'Otra', fields: [] }]);
    expect(problems.join(' ')).toContain('ningún bloque lee');
    expect(problems.join(' ')).toContain('necesita un campo de fecha');
  });

  it('los specs viejos siguen siendo el mismo objeto: nada nuevo aparece por defecto', () => {
    const old = spec([{ id: 't', type: 'table', title: 'T', tracker: 'citas' }]);
    expect(old).not.toHaveProperty('filtersBar');
    expect(old).not.toHaveProperty('pages');
    expect(old).not.toHaveProperty('theme');
    expect(old.blocks[0]).not.toHaveProperty('openRecord');
  });
});

describe('el cálculo de los bloques nuevos', () => {
  it('galería: etiqueta con el tono de su opción e imágenes sólo https', () => {
    const view = computeView(
      spec([
        {
          id: 'g',
          type: 'gallery',
          title: 'Pacientes',
          tracker: 'citas',
          subtitleField: 'sede',
          metaFields: ['valor'],
          badgeField: 'sede',
          imageField: 'foto',
          sort: { field: 'valor', dir: 'desc' },
          limit: 3,
        },
      ]),
      sources(),
      NOW,
    );
    const g = view.blocks[0];
    if (g?.type !== 'gallery') throw new Error(g?.type);
    expect(g.cards.map((c) => c.title)).toEqual(['Beto', 'Ana', 'Dani']);
    expect(g.total).toBe(5);
    expect(g.cards[0]?.image).toBeNull();
    expect(g.cards[1]?.image).toBe('https://cdn.example.com/ana.jpg');
    expect(g.cards[0]?.badge).toEqual({ label: 'Cali', tone: 'amber' });
    expect(g.cards[1]?.badge).toEqual({ label: 'Bogotá', tone: 'sky' });
    expect(g.cards[0]?.meta[0]).toMatchObject({ label: 'Valor' });
  });

  it('calendario: el mes anterior, el actual y el siguiente; la agenda, los próximos días', () => {
    const view = computeView(
      spec([
        {
          id: 'm',
          type: 'calendar',
          title: 'Citas',
          tracker: 'citas',
          dateField: 'fecha',
          colorField: 'sede',
        },
        {
          id: 'a',
          type: 'calendar',
          title: 'Agenda',
          tracker: 'citas',
          dateField: 'fecha',
          mode: 'agenda',
          days: 7,
        },
      ]),
      sources(),
      NOW,
    );
    const [month, agenda] = view.blocks;
    if (month?.type !== 'calendar' || agenda?.type !== 'calendar') throw new Error('tipo');
    expect(month.months).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(month.range).toEqual({ from: '2026-08-01', to: '2026-10-31' });
    expect(month.events.map((e) => e.id)).toEqual(['3', '1', '2', '4']);
    expect(month.events[0]).toMatchObject({ tag: 'Cali', tone: 'amber' });
    expect(month.legend).toHaveLength(3);
    expect(agenda.range).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    expect(agenda.events.map((e) => e.id)).toEqual(['2', '4']);
  });

  it('avance: por grupo contra su meta, o contra la meta común', () => {
    const view = computeView(
      spec([
        {
          id: 'p',
          type: 'progress',
          title: 'Ventas por sede',
          tracker: 'citas',
          groupBy: 'sede',
          aggregate: 'sum',
          field: 'valor',
          target: 100,
          targets: [{ group: 'Cali', target: 700 }],
        },
        { id: 'r', type: 'progress', title: 'Relativo', tracker: 'citas', groupBy: 'sede' },
        { id: 's', type: 'progress', title: 'Total', tracker: 'citas', target: 10 },
      ]),
      sources(),
      NOW,
    );
    const [p, r, s] = view.blocks;
    if (p?.type !== 'progress' || r?.type !== 'progress' || s?.type !== 'progress')
      throw new Error('tipo');
    expect(p.items.map((i) => [i.label, i.value, i.target])).toEqual([
      ['Bogotá', 110, 100],
      ['Cali', 350, 700],
      ['Medellín', 70, 100],
    ]);
    expect(p.items[1]?.ratio).toBe(0.5);
    expect(p.items[0]?.display).toContain('110');
    expect(r.relative).toBe(true);
    expect(r.items.map((i) => i.ratio)).toEqual([1, 1, 0.5]);
    expect(s.items[0]).toMatchObject({ value: 5, target: 10, ratio: 0.5 });
  });

  it('KPI contra el período anterior: valor del mes, delta, color y línea', () => {
    const view = computeView(
      spec([
        {
          id: 'k',
          type: 'metric',
          title: 'Ventas',
          tracker: 'citas',
          aggregate: 'sum',
          field: 'valor',
          compare: 'previous_period',
          period: 'month',
          dateField: 'fecha',
        },
        {
          id: 'd',
          type: 'metric',
          title: 'Devoluciones',
          tracker: 'citas',
          compare: 'previous_period',
          dateField: 'fecha',
          goodWhen: 'down',
        },
      ]),
      sources(),
      NOW,
    );
    const [k, d] = view.blocks;
    if (k?.type !== 'metric' || d?.type !== 'metric') throw new Error('tipo');
    expect(k.value).toBe(400);
    expect(k.rows).toBe(2);
    expect(k.compare).toMatchObject({ previous: 50, delta: 7, direction: 'up', good: true });
    expect(k.compare?.series).toHaveLength(12);
    expect(k.compare?.series.at(-1)).toEqual({ label: 'sep 2026', value: 400 });
    expect(d.compare).toMatchObject({ direction: 'up', good: false });
  });

  it('imagen, video y botones salen ya validados', () => {
    const view = computeView(
      spec([
        { id: 'i', type: 'media', url: 'https://cdn.example.com/plano.png', alt: 'Plano' },
        { id: 'v', type: 'media', kind: 'embed', url: 'https://youtu.be/dQw4w9WgXcQ' },
        { id: 'e', type: 'media' },
        {
          id: 'l',
          type: 'links',
          links: [
            { label: 'Cartera', href: '/views/cartera' },
            { label: 'Sitio', href: 'https://example.com' },
          ],
        },
      ]),
      new Map(),
      NOW,
    );
    expect(view.blocks[0]).toMatchObject({
      type: 'media',
      src: 'https://cdn.example.com/plano.png',
    });
    expect(view.blocks[1]).toMatchObject({
      src: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      provider: 'youtube',
    });
    expect(view.blocks[2]).toMatchObject({ type: 'media', src: null });
    expect(view.blocks[3]).toMatchObject({
      links: [
        { href: '/views/cartera', external: false },
        { href: 'https://example.com/', external: true },
      ],
    });
  });
});

describe('la ficha de una fila', () => {
  const table = (extra: Record<string, unknown> = {}) =>
    spec(
      [
        {
          id: 't',
          type: 'table',
          title: 'Citas',
          tracker: 'citas',
          columns: ['label', 'sede'],
          limit: 2,
          ...extra,
        },
      ],
      { editing: 'team' },
    );

  it('dentro del equipo trae todos los campos de una tabla propia, sólo de las filas mostradas', () => {
    const view = computeView(table(), sources(), NOW, { writable: false });
    const t = view.blocks[0];
    if (t?.type !== 'table') throw new Error('tipo');
    expect(t.record?.fields.map((f) => f.key)).toEqual([
      'paciente',
      'fecha',
      'sede',
      'valor',
      'foto',
      'telefono',
    ]);
    expect(Object.keys(t.record?.rows ?? {})).toHaveLength(2);
    expect(t.record?.fields.some((f) => f.edit)).toBe(false);
  });

  it('afuera, sin detailFields, sólo lo que el bloque ya pinta: el teléfono no sale', () => {
    const view = computeView(table(), sources(), NOW, { audience: 'public' });
    const t = view.blocks[0];
    if (t?.type !== 'table') throw new Error('tipo');
    expect(t.record?.fields.map((f) => f.key)).toEqual(['sede']);
    expect(JSON.stringify(view)).not.toContain('300 111');
  });

  it('detailFields manda, y recordEditable sólo se edita si quien mira puede escribir', () => {
    const s = table({ detailFields: ['valor'], recordEditable: ['telefono'] });
    const read = computeView(s, sources(), NOW, { writable: false, audience: 'public' });
    const write = computeView(s, sources(), NOW, { writable: true });
    const [r, w] = [read.blocks[0], write.blocks[0]];
    if (r?.type !== 'table' || w?.type !== 'table') throw new Error('tipo');
    expect(r.record?.fields.map((f) => f.key)).toEqual(['valor']);
    expect(w.record?.fields.map((f) => [f.key, Boolean(f.edit)])).toEqual([
      ['valor', false],
      ['telefono', true],
    ]);
    const first = Object.values(w.record?.rows ?? {})[0];
    expect(first?.raw[0]).toBeNull();
  });

  it('openRecord false la apaga; la lista de escritura es la misma que acepta el servidor', () => {
    const view = computeView(table({ openRecord: false }), sources(), NOW);
    expect(view.blocks[0]).toMatchObject({ record: null });
    const s = spec([
      {
        id: 'b',
        type: 'board',
        title: 'B',
        tracker: 'citas',
        groupBy: 'sede',
        draggable: true,
        recordEditable: ['valor'],
      },
    ]);
    expect(blockWriteFields(s.blocks[0] as never)).toEqual(['sede', 'valor']);
  });
});

describe('la barra de filtros', () => {
  const s = () =>
    spec(
      [
        { id: 'n', type: 'metric', title: 'Cuántas', tracker: 'citas' },
        { id: 't', type: 'table', title: 'Lista', tracker: 'citas' },
      ],
      {
        filtersBar: [
          { id: 'sede', label: 'Sede', source: 'citas', field: 'sede', kind: 'select' },
          { id: 'fechas', label: 'Fechas', source: 'citas', field: 'fecha', kind: 'date_range' },
          { id: 'q', label: 'Buscar', source: 'citas', field: 'paciente', kind: 'search' },
        ],
        alerts: [{ id: 'nuevo', source: 'citas' }],
      },
    );

  it('valida el parámetro contra el spec y descarta lo que no cuadra', () => {
    const raw = encodeViewFilterState({
      sede: { kind: 'select', value: 'Cali' },
      fechas: { kind: 'date_range', from: '2026-09-30', to: '2026-09-01' },
    });
    expect(parseViewFilterParam(s(), raw)).toEqual({
      sede: { kind: 'select', value: 'Cali' },
      fechas: { kind: 'date_range', from: '2026-09-01', to: '2026-09-30' },
    });
    expect(parseViewFilterParam(s(), 'otro=1&fechas=ayer~hoy&sede=')).toEqual({});
    expect(parseViewFilterParam(s(), `sede=${'x'.repeat(2000)}`)).toEqual({});
  });

  it('se aplica a todos los bloques y avisos de esa fuente, y conserva las opciones', () => {
    const state = parseViewFilterParam(s(), 'sede=cali&fechas=2026-09-01~2026-09-30');
    const view = computeView(s(), sources(), NOW, { filters: state });
    const [n, t] = view.blocks;
    if (n?.type !== 'metric' || t?.type !== 'table') throw new Error('tipo');
    expect(n.value).toBe(1);
    expect(t.rows.map((r) => r.id)).toEqual(['2']);
    expect(view.alerts[0]?.rows.map((r) => r.id)).toEqual(['2']);
    expect(view.filtersBar?.[0]).toMatchObject({
      options: ['Bogotá', 'Cali', 'Medellín'],
      value: { kind: 'select', value: 'cali' },
    });
  });

  it('la búsqueda no distingue tildes ni mayúsculas', () => {
    const view = computeView(s(), sources(), NOW, {
      filters: parseViewFilterParam(s(), 'q=CARÓ'),
    });
    expect(view.blocks[0]).toMatchObject({ value: 1 });
  });
});

describe('páginas y aspecto', () => {
  it('los bloques sin página salen en la primera, en el orden del spec', () => {
    const view = computeView(
      spec(
        [
          { id: 'a', type: 'text', markdown: 'A' },
          { id: 'b', type: 'text', markdown: 'B' },
          { id: 'c', type: 'text', markdown: 'C' },
        ],
        {
          pages: [
            { id: 'uno', title: 'Resumen', blockIds: ['c'] },
            { id: 'dos', title: 'Detalle', blockIds: ['b', 'c'] },
          ],
        },
      ),
      new Map(),
      NOW,
    );
    expect(view.pages).toEqual([
      { id: 'uno', title: 'Resumen', blockIds: ['a', 'c'] },
      { id: 'dos', title: 'Detalle', blockIds: ['b', 'c'] },
    ]);
  });

  it('sin tema, los valores de siempre; la portada sólo si es https', () => {
    const plain = computeView(spec([{ id: 'a', type: 'text', markdown: 'A' }]), new Map(), NOW);
    expect(plain.theme).toEqual({
      accent: 'primary',
      density: 'comfortable',
      header: 'plain',
      cover: null,
    });
    expect(plain.pages).toEqual([]);
    const hero = computeView(
      spec([{ id: 'a', type: 'text', markdown: 'A' }], {
        theme: { header: 'hero', accent: 'emerald', cover: 'https://cdn.example.com/c.jpg' },
      }),
      new Map(),
      NOW,
    );
    expect(hero.theme).toMatchObject({ header: 'hero', accent: 'emerald' });
    expect(hero.theme?.cover).toBe('https://cdn.example.com/c.jpg');
  });
});
