import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { type Tables, createFakeSupabase } from '../tenancy/__tests__/fake-postgrest';
import { createOrgScopedClient } from '../tenancy/scoped-client';
import { FIELD_KEY_RE, TRACKER_SLUG_RE, trackerFieldsSchema } from '../trackers/schema';
import { computeView } from './compute';
import {
  FEED_EXPIRED_MESSAGE,
  FEED_NO_VIEWER_MESSAGE,
  FEED_PRIVATE_MESSAGE,
  FEED_PUBLIC_MESSAGE,
  dayOfCell,
  feedTable,
  headerKey,
  inferSheetFields,
} from './feed-sources';
import { FEED_SOURCE_SHARE_NAME, PLATFORM_SOURCES, internalSourcesOf } from './sources';
import {
  type CatalogTracker,
  FEED_SOURCE_RE,
  PLATFORM_SOURCE_RE,
  checkSpecAgainst,
  feedSourceId,
  isFeedSourceId,
  isPlatformSourceId,
  isReadOnlySource,
  parseFeedSourceId,
  viewSpecSchema,
} from './spec';
import {
  PERSONAL_SOURCE_BLOCKED,
  PERSONAL_SOURCE_NO_VIEWER,
  loadViewSources,
  setViewAccess,
  validateSpec,
  viewCatalog,
} from './store';

/**
 * Las tablas del Feed y las fuentes de cada persona (activaciones,
 * seguimientos, operaciones, rutinas) dentro de una vista. Lo que importa
 * probar aquí es la regla de privacidad: el Feed es de quien lo subió, y una
 * vista del espacio no puede ser la puerta que el Feed nunca tuvo.
 */

const ACME = 'org-acme';
const GLOBEX = 'org-globex';
const ANA = '11111111-1111-4111-8111-111111111111';
const BETO = '22222222-2222-4222-8222-222222222222';
const T = '2026-09-20T15:00:00Z';
const FUTURE = '2099-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

const CAPTURE = 'aaaa0000-0000-4000-8000-000000000001';
const CAPTURE_OLD = 'aaaa0000-0000-4000-8000-000000000002';
const CAPTURE_BETO = 'aaaa0000-0000-4000-8000-000000000003';
const CAPTURE_EXPIRED = 'aaaa0000-0000-4000-8000-000000000004';
const CAPTURE_SYNC_1 = 'aaaa0000-0000-4000-8000-000000000005';
const CAPTURE_SYNC_2 = 'aaaa0000-0000-4000-8000-000000000006';
const CONNECTION = 'bbbb0000-0000-4000-8000-000000000001';
const PREPARED = 'dddd0000-0000-4000-8000-000000000001';
const VIEW_ID = 'ffff0000-0000-4000-8000-000000000009';

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

describe('los ids del Feed', () => {
  it('se desarman y se arman igual, y no chocan con tablas ni con cortex.*', () => {
    const ids = [`feed.${CAPTURE}.0`, `feedsrc.${CONNECTION}.19`, `feedview.${PREPARED}`];
    for (const id of ids) {
      expect(FEED_SOURCE_RE.test(id), id).toBe(true);
      expect(isFeedSourceId(id)).toBe(true);
      expect(isReadOnlySource(id)).toBe(true);
      expect(isPlatformSourceId(id)).toBe(false);
      expect(PLATFORM_SOURCE_RE.test(id)).toBe(false);
      expect(TRACKER_SLUG_RE.test(id)).toBe(false);
      const parsed = parseFeedSourceId(id);
      expect(parsed).not.toBeNull();
      if (parsed) expect(feedSourceId(parsed)).toBe(id);
    }
    expect(parseFeedSourceId(`feed.${CAPTURE}.3`)).toEqual({
      kind: 'entry',
      id: CAPTURE,
      sheet: 3,
    });
    expect(parseFeedSourceId(`feedsrc.${CONNECTION}.1`)).toEqual({
      kind: 'connection',
      id: CONNECTION,
      sheet: 1,
    });
    expect(parseFeedSourceId(`feedview.${PREPARED}`)).toEqual({
      kind: 'prepared',
      id: PREPARED,
      sheet: 0,
    });
    expect(isReadOnlySource('cortex.ventas')).toBe(true);
    expect(isReadOnlySource('remates')).toBe(false);
  });

  it('rechaza lo que se le parece pero no es', () => {
    for (const bad of [
      `feed.${CAPTURE}`,
      `feed.${CAPTURE}.20`,
      `feed.${CAPTURE.toUpperCase()}.0`,
      `feedview.${PREPARED}.0`,
      `feedsrc.${CONNECTION}.-1`,
      'feed.no-es-uuid.0',
      `otro.${CAPTURE}.0`,
    ]) {
      expect(isFeedSourceId(bad), bad).toBe(false);
      expect(parseFeedSourceId(bad)).toBeNull();
      const r = viewSpecSchema.safeParse({
        version: 1,
        blocks: [{ id: 'm', type: 'metric', title: 'M', tracker: bad }],
      });
      expect(r.success, bad).toBe(false);
    }
    const ok = viewSpecSchema.safeParse({
      version: 1,
      blocks: [{ id: 'm', type: 'metric', title: 'M', tracker: `feed.${CAPTURE}.0` }],
    });
    expect(ok.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Encabezados → campos
// ---------------------------------------------------------------------------

describe('los encabezados como campos', () => {
  it('claves estables, sin tildes, sin repetir y nunca una clave propia de toda fila', () => {
    const taken = new Set<string>();
    const keys = [
      'Fecha de envío',
      'Fecha de envío',
      'Label',
      '',
      '2do pago',
      'Número de guía / remesa (código interno del transportador)',
      'created_at',
    ].map((h, i) => headerKey(h, i, taken));
    expect(keys).toEqual([
      'fecha_de_envio',
      'fecha_de_envio_2',
      'label_hoja',
      'columna_4',
      'c_2do_pago',
      'numero_de_guia_remesa_codigo',
      'created_at_hoja',
    ]);
    for (const k of keys) expect(k).toMatch(FIELD_KEY_RE);
  });

  it('infiere con prudencia: número, dinero, fecha, opciones y, ante la duda, texto', () => {
    const header = ['Cliente', 'Estado', 'Valor', 'Kilos', 'Fecha', 'Guía', 'Nota', 'NIT'];
    const rows = [
      ['Alpha', 'Entregado', 1200000, 30, '2026-09-01', '00123', 'ok', 900123],
      ['Beta', 'En ruta', '350000', 12.5, '15/09/2026', '00124', 12, 800456],
      ['Gamma', 'Entregado', 90000, 4, '2026-09-03T00:00:00.000Z', 'A-9', 'x', 700789],
      ['Delta', 'En ruta', 10, 1, '2026-09-04', '00126', 'y', 600111],
    ];
    const { fields } = inferSheetFields(header, rows);
    const byKey = Object.fromEntries(fields.map((f) => [f.key, f]));
    expect(byKey.cliente?.type).toBe('text'); // cuatro valores distintos: no es categoría
    expect(byKey.estado).toMatchObject({ type: 'select', options: ['En ruta', 'Entregado'] });
    expect(byKey.valor?.type).toBe('money');
    expect(byKey.kilos?.type).toBe('number');
    expect(byKey.fecha?.type).toBe('date');
    expect(byKey.guia?.type).toBe('text'); // «00123» es un código, no un número
    expect(byKey.nota?.type).toBe('text'); // mezcla de números y texto
    expect(byKey.nit?.type).toBe('number'); // sin palabra de plata: no es dinero
    expect(trackerFieldsSchema.safeParse(fields).success).toBe(true);
  });

  it('una hoja que declara otra moneda no tiene campos de dinero', () => {
    const { fields } = inferSheetFields(
      ['Factura', 'Total', 'Moneda'],
      [
        ['F1', 100, 'COP'],
        ['F2', 30, 'USD'],
      ],
    );
    expect(fields.find((f) => f.key === 'total')?.type).toBe('number');
    const cop = inferSheetFields(
      ['Factura', 'Total', 'Moneda'],
      [
        ['F1', 100, 'COP'],
        ['F2', 30, 'cop'],
      ],
    );
    expect(cop.fields.find((f) => f.key === 'total')?.type).toBe('money');
    // Y un encabezado en dólares tampoco es dinero en pesos.
    const usd = inferSheetFields(['Total USD'], [[5], [6]]);
    expect(usd.fields[0]?.type).toBe('number');
  });

  it('fechas: AAAA-MM-DD y DD/MM/AAAA (día primero); nada inválido', () => {
    expect(dayOfCell('2026-09-01')).toBe('2026-09-01');
    expect(dayOfCell('2026-09-01T00:00:00.000Z')).toBe('2026-09-01');
    expect(dayOfCell('03/04/2026')).toBe('2026-04-03');
    expect(dayOfCell('31/02/2026')).toBeNull();
    expect(dayOfCell('2026-13-01')).toBeNull();
    expect(dayOfCell(45123)).toBeNull();
  });

  it('las filas: ids por número de fila, etiqueta, vacías fuera, tope parcial', () => {
    const sheet = {
      name: 'Despachos',
      rows: [
        ['Cliente', 'Valor', 'Fecha'],
        ['Alpha', 100, '01/09/2026'],
        [null, '', null],
        ['Beta', '250', '2026-09-02'],
        ['Gamma', 7, '2026-09-03'],
      ],
    };
    const ref = `feed.${CAPTURE}.0`;
    const full = feedTable(sheet, ref, T, 100);
    expect(full.truncated).toBe(false);
    expect(full.rows.map((r) => r.id)).toEqual([`${ref}:2`, `${ref}:4`, `${ref}:5`]);
    expect(full.rows[0]).toMatchObject({
      label: 'Alpha',
      values: { cliente: 'Alpha', valor: 100, fecha: '2026-09-01' },
      created_at: T,
    });
    expect(full.rows[1]?.values.valor).toBe(250);
    const cut = feedTable(sheet, ref, T, 2);
    expect(cut.rows).toHaveLength(2);
    expect(cut.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// El contrato
// ---------------------------------------------------------------------------

describe('el contrato con tablas del Feed', () => {
  const ref = `feed.${CAPTURE}.0`;
  const catalog: CatalogTracker[] = [
    {
      slug: ref,
      name: 'despachos.xlsx',
      fields: [
        { key: 'estado', label: 'Estado', type: 'select', required: false, options: ['A', 'B'] },
        { key: 'valor', label: 'Valor', type: 'money', required: false },
      ],
    },
  ];

  it('acepta cifras, tableros y alertas sobre sus campos', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [
        { id: 'm', type: 'metric', title: 'Total', tracker: ref, aggregate: 'sum', field: 'valor' },
        { id: 'b', type: 'board', title: 'Por estado', tracker: ref, groupBy: 'estado' },
      ],
      alerts: [{ id: 'a', source: ref, filters: [{ field: 'estado', op: 'eq', value: 'A' }] }],
    });
    expect(checkSpecAgainst(spec, catalog)).toEqual([]);
  });

  it('es de sólo lectura: ni formularios, ni celdas editables, ni tableros que se arrastran', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      editing: 'team',
      blocks: [
        { id: 'f', type: 'form', title: 'Nuevo', tracker: ref },
        { id: 't', type: 'table', title: 'T', tracker: ref, editable: ['valor'] },
        { id: 'b', type: 'board', title: 'B', tracker: ref, groupBy: 'estado', draggable: true },
      ],
    });
    const problems = checkSpecAgainst(spec, catalog);
    expect(problems).toHaveLength(3);
    for (const p of problems) expect(p).toContain('una tabla del Feed');
    for (const p of problems) expect(p).toContain('sólo lectura');
  });

  it('una tabla del Feed que no está en el catálogo se explica sin decir de quién es', () => {
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 'm', type: 'metric', title: 'M', tracker: `feed.${CAPTURE_BETO}.0` }],
    });
    expect(checkSpecAgainst(spec, catalog).join(' ')).toContain('no está disponible');
  });

  it('una opaca se conserva sin comprobar campos, pero sigue siendo de sólo lectura', () => {
    const other = `feed.${CAPTURE_BETO}.0`;
    const opaque: CatalogTracker[] = [{ slug: other, name: 'X', fields: [], opaque: true }];
    const kept = viewSpecSchema.parse({
      version: 1,
      blocks: [
        {
          id: 'm',
          type: 'metric',
          title: 'M',
          tracker: other,
          aggregate: 'sum',
          field: 'lo_que_sea',
        },
        { id: 'b', type: 'board', title: 'B', tracker: other, groupBy: 'estado' },
      ],
    });
    expect(checkSpecAgainst(kept, opaque)).toEqual([]);
    const form = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 'f', type: 'form', title: 'F', tracker: other }],
    });
    expect(checkSpecAgainst(form, opaque).join(' ')).toContain('sólo lectura');
  });
});

// ---------------------------------------------------------------------------
// Contra la base de mentira: dos personas, dos espacios
// ---------------------------------------------------------------------------

const SHEET = {
  name: 'Despachos',
  rows: [
    ['Cliente', 'Estado', 'Valor'],
    ['Alpha', 'Entregado', 100],
    ['Beta', 'En ruta', 250],
  ],
};

function attachment(id: string, extra: Record<string, unknown>) {
  return {
    id,
    organization_id: ACME,
    created_by: ANA,
    filename: 'despachos.xlsx',
    feed_kind: 'file',
    feed_tables: [SHEET],
    feed_truncated: false,
    feed_source_id: null,
    created_at: T,
    purge_at: FUTURE,
    ...extra,
  };
}

function candidate(status: string) {
  return { status, rowIndex: 1, sourceKey: 'k', values: [], reasons: [], groupKey: null };
}

function world(): Tables {
  return {
    users: [
      { id: ANA, organization_id: ACME, email: 'ana@acme.com', name: 'Ana' },
      { id: BETO, organization_id: ACME, email: 'beto@acme.com', name: 'Beto' },
    ],
    chat_attachments: [
      attachment(CAPTURE, {}),
      attachment(CAPTURE_OLD, { filename: 'viejo.csv', created_at: '2026-09-01T00:00:00Z' }),
      attachment(CAPTURE_BETO, {
        created_by: BETO,
        filename: 'nomina-beto.xlsx',
        feed_tables: [{ name: 'Secreto', rows: [['Sueldo'], [9_000_000]] }],
      }),
      attachment(CAPTURE_EXPIRED, { purge_at: PAST, filename: 'vencido.xlsx' }),
      attachment(CAPTURE_SYNC_1, {
        feed_source_id: CONNECTION,
        filename: 'hoja-conectada',
        feed_tables: [
          {
            name: 'Hoja 1',
            rows: [
              ['Pedido', 'Valor'],
              ['P1', 10],
            ],
          },
        ],
      }),
      attachment(CAPTURE_SYNC_2, {
        feed_source_id: CONNECTION,
        filename: 'hoja-conectada',
        feed_kind: 'api',
        feed_tables: [
          {
            name: 'Hoja 1',
            rows: [
              ['Pedido', 'Valor'],
              ['P1', 10],
              ['P2', 20],
            ],
          },
        ],
      }),
      // Otro espacio, mismo dueño por id: jamás se ve desde Acme.
      { ...attachment('aaaa0000-0000-4000-8000-00000000000f', {}), organization_id: GLOBEX },
    ],
    feed_sources: [
      {
        id: CONNECTION,
        organization_id: ACME,
        actor_id: ANA,
        kind: 'google_sheet',
        name: 'Pedidos (Google Sheets)',
        latest_attachment_id: CAPTURE_SYNC_1,
        enabled: true,
        updated_at: T,
      },
    ],
    feed_prepared_views: [
      {
        id: PREPARED,
        organization_id: ACME,
        actor_id: ANA,
        source_id: CAPTURE,
        name: 'Facturas del correo',
        table_data: {
          name: 'Facturas',
          rows: [
            ['Factura', 'Total'],
            ['F-1', 500],
          ],
        },
        created_at: T,
      },
    ],
    activation_runs: [
      {
        id: 'run-ana-1',
        organization_id: ACME,
        actor_id: ANA,
        source_name: 'despachos.xlsx',
        sheet_name: 'Despachos',
        definition: {
          version: 1,
          name: 'Entregas sin factura',
          kind: 'table_rule',
          rule: 'conditions',
        },
        candidates: [
          candidate('matched'),
          candidate('matched'),
          candidate('unmatched'),
          candidate('invalid'),
        ],
        status: 'committed',
        case_ids: ['case-1', 'case-2'],
        identity_namespace: 'automation:auto-1',
        created_at: T,
        committed_at: T,
      },
      {
        id: 'run-beto-1',
        organization_id: ACME,
        actor_id: BETO,
        source_name: 'nomina-beto.xlsx',
        sheet_name: 'Secreto',
        definition: { version: 1, name: 'De Beto', kind: 'invoice_duplicates' },
        candidates: [],
        status: 'simulated',
        case_ids: [],
        identity_namespace: null,
        created_at: T,
        committed_at: null,
      },
    ],
    activation_automations: [
      {
        id: 'auto-1',
        organization_id: ACME,
        actor_id: ANA,
        name: 'Revisar pedidos',
        source_connection_id: CONNECTION,
        trigger: 'on_change',
        interval_minutes: 60,
        status: 'active',
        next_run_at: '2026-09-21T15:00:00Z',
        last_checked_at: T,
        last_result: {
          outcome: 'checked',
          matched: 2,
          created: 1,
          message: 'Revisión completada.',
        },
        created_at: T,
        updated_at: T,
      },
    ],
    activation_operations: [
      {
        id: 'op-1',
        organization_id: ACME,
        actor_id: ANA,
        case_id: 'case-1',
        action_tool_id: 'custom.crear_nota_credito',
        verifier_tool_id: 'custom.leer_nota',
        status: 'succeeded',
        attempt: 1,
        error: null,
        started_at: '2026-09-20T15:00:00Z',
        completed_at: '2026-09-20T15:00:42Z',
        created_at: T,
        updated_at: T,
      },
      {
        id: 'op-beto',
        organization_id: ACME,
        actor_id: BETO,
        case_id: 'case-1',
        action_tool_id: 'custom.pagar',
        verifier_tool_id: 'custom.leer',
        status: 'outcome_unknown',
        attempt: 1,
        error: null,
        started_at: null,
        completed_at: null,
        created_at: T,
        updated_at: T,
      },
    ],
    management_cases: [
      {
        id: 'case-1',
        organization_id: ACME,
        data: { title: 'Nota crédito Alpha' },
        created_at: T,
        updated_at: T,
      },
    ],
    scheduled_jobs: [
      {
        id: 'job-ana',
        organization_id: ACME,
        user_id: ANA,
        name: 'Resumen diario',
        kind: 'agent',
        status: 'active',
        is_global: false,
      },
      {
        id: 'job-team',
        organization_id: ACME,
        user_id: BETO,
        name: 'Cartera del lunes',
        kind: 'tool',
        status: 'active',
        is_global: true,
      },
      {
        id: 'job-beto',
        organization_id: ACME,
        user_id: BETO,
        name: 'Privada de Beto',
        kind: 'agent',
        status: 'active',
        is_global: false,
      },
    ],
    scheduled_job_runs: [
      {
        id: 'r1',
        organization_id: ACME,
        job_id: 'job-ana',
        status: 'ok',
        started_at: '2026-09-20T12:00:00Z',
        finished_at: '2026-09-20T12:00:30Z',
        error: null,
      },
      {
        id: 'r2',
        organization_id: ACME,
        job_id: 'job-team',
        status: 'error',
        started_at: '2026-09-19T12:00:00Z',
        finished_at: '2026-09-19T12:00:05Z',
        error: 'Sin conexión',
      },
      {
        id: 'r3',
        organization_id: ACME,
        job_id: 'job-beto',
        status: 'ok',
        started_at: '2026-09-18T12:00:00Z',
        finished_at: null,
        error: null,
      },
    ],
    trackers: [],
    tracker_rows: [],
    custom_views: [],
    custom_view_versions: [],
  };
}

/**
 * El cliente del espacio, con un registro de qué columnas se pidieron a qué
 * tabla: así se prueba que el CONTENIDO de un Feed ajeno ni se pide.
 */
function acme(tables: Tables = world()) {
  const fake = createFakeSupabase(tables);
  const selects: Array<{ table: string; columns: string }> = [];
  const from = fake.client.from.bind(fake.client);
  (fake.client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
    const q = from(table) as unknown as { select: (c?: string, o?: unknown) => unknown };
    const select = q.select.bind(q);
    q.select = (columns?: string, opts?: unknown) => {
      selects.push({ table, columns: columns ?? '*' });
      return select(columns, opts);
    };
    return q;
  };
  return {
    db: createOrgScopedClient(fake.client as SupabaseClient, ACME),
    tables: fake.tables,
    selects,
  };
}

const specOver = (...refs: string[]) =>
  viewSpecSchema.parse({
    version: 1,
    blocks: refs.map((tracker, i) => ({ id: `b${i}`, type: 'table', title: `T${i}`, tracker })),
  });

describe('quién ve una tabla del Feed', () => {
  const mine = `feed.${CAPTURE}.0`;

  it('su dueño la ve entera, con campos de los encabezados', async () => {
    const { db } = acme();
    const sources = await loadViewSources(db, specOver(mine), { viewerId: ANA });
    const src = sources.get(mine);
    expect(src?.blocked).toBeUndefined();
    expect(src?.tracker.name).toBe('despachos.xlsx');
    expect(src?.tracker.fields.map((f) => f.key)).toEqual(['cliente', 'estado', 'valor']);
    expect(src?.rows.map((r) => r.values)).toEqual([
      { cliente: 'Alpha', estado: 'Entregado', valor: 100 },
      { cliente: 'Beta', estado: 'En ruta', valor: 250 },
    ]);
  });

  it('un compañero ve el aviso, y el contenido ajeno ni se pide a la base', async () => {
    const { db, selects } = acme();
    const theirs = `feed.${CAPTURE_BETO}.0`;
    const sources = await loadViewSources(db, specOver(theirs), { viewerId: ANA });
    expect(sources.get(theirs)).toMatchObject({ rows: [], blocked: FEED_PRIVATE_MESSAGE });
    const contentReads = selects.filter(
      (s) => s.table === 'chat_attachments' && s.columns.includes('feed_tables'),
    );
    expect(contentReads).toEqual([]);
    const [block] = computeView(specOver(theirs), sources).blocks;
    expect(block).toMatchObject({ type: 'problem', message: FEED_PRIVATE_MESSAGE });
    // Y el nombre del archivo ajeno tampoco viaja.
    expect(JSON.stringify(block)).not.toContain('nomina-beto');
  });

  it('afuera, o sin saber quién mira, no se lee', async () => {
    const { db } = acme();
    const pub = await loadViewSources(db, specOver(mine), { audience: 'public', viewerId: ANA });
    expect(pub.get(mine)).toMatchObject({ rows: [], blocked: FEED_PUBLIC_MESSAGE });
    const nobody = await loadViewSources(db, specOver(mine));
    expect(nobody.get(mine)).toMatchObject({ rows: [], blocked: FEED_NO_VIEWER_MESSAGE });
  });

  it('lo vencido está vencido, aunque la fila siga en la base', async () => {
    const { db } = acme();
    const expired = `feed.${CAPTURE_EXPIRED}.0`;
    const missing = `feed.${'aaaa0000-0000-4000-8000-0000000000ee'}.0`;
    const otherOrg = `feed.${'aaaa0000-0000-4000-8000-00000000000f'}.0`;
    const sources = await loadViewSources(db, specOver(expired, missing, otherOrg), {
      viewerId: ANA,
    });
    for (const ref of [expired, missing, otherOrg])
      expect(sources.get(ref), ref).toMatchObject({ rows: [], blocked: FEED_EXPIRED_MESSAGE });
    const noSheet = `feed.${CAPTURE}.4`;
    const s2 = await loadViewSources(db, specOver(noSheet), { viewerId: ANA });
    expect(s2.get(noSheet)?.blocked).toContain('La hoja 5 ya no está');
  });

  it('una fuente conectada sigue su última lectura', async () => {
    const { db, tables } = acme();
    const ref = `feedsrc.${CONNECTION}.0`;
    const first = await loadViewSources(db, specOver(ref), { viewerId: ANA });
    expect(first.get(ref)?.rows).toHaveLength(1);
    expect(first.get(ref)?.tracker.name).toBe('Pedidos (Google Sheets)');
    // La fuente se sincroniza: el puntero pasa a la captura nueva.
    const conn = tables.feed_sources?.[0] as Record<string, unknown>;
    conn.latest_attachment_id = CAPTURE_SYNC_2;
    const second = await loadViewSources(db, specOver(ref), { viewerId: ANA });
    expect(second.get(ref)?.rows.map((r) => r.values.pedido)).toEqual(['P1', 'P2']);
    // Beto no la ve; y si la última lectura vence, se dice.
    const beto = await loadViewSources(db, specOver(ref), { viewerId: BETO });
    expect(beto.get(ref)?.blocked).toBe(FEED_PRIVATE_MESSAGE);
    const sync2 = tables.chat_attachments?.find((a) => a.id === CAPTURE_SYNC_2) as Record<
      string,
      unknown
    >;
    sync2.purge_at = PAST;
    const stale = await loadViewSources(db, specOver(ref), { viewerId: ANA });
    expect(stale.get(ref)?.blocked).toContain('no tiene una lectura vigente');
  });

  it('una vista preparada es de su dueño y se va con su captura', async () => {
    const { db, tables } = acme();
    const ref = `feedview.${PREPARED}`;
    const ana = await loadViewSources(db, specOver(ref), { viewerId: ANA });
    expect(ana.get(ref)?.rows[0]?.values).toEqual({ factura: 'F-1', total: 500 });
    const beto = await loadViewSources(db, specOver(ref), { viewerId: BETO });
    expect(beto.get(ref)?.blocked).toBe(FEED_PRIVATE_MESSAGE);
    const src = tables.chat_attachments?.find((a) => a.id === CAPTURE) as Record<string, unknown>;
    src.purge_at = PAST;
    const gone = await loadViewSources(db, specOver(ref), { viewerId: ANA });
    expect(gone.get(ref)?.blocked).toBe(FEED_EXPIRED_MESSAGE);
  });

  it('una vista con una tabla del Feed no sale por enlace ni con contraseña', async () => {
    const spec = specOver(mine, 'cortex.ventas');
    expect(internalSourcesOf(spec).map((s) => s.name)).toEqual([FEED_SOURCE_SHARE_NAME]);
    const tables = world();
    tables.custom_views = [
      {
        id: VIEW_ID,
        organization_id: ACME,
        slug: 'despachos',
        name: 'Despachos',
        description: '',
        spec,
        version: 1,
        visibility: 'workspace',
        share_token: null,
        share_expires_at: null,
        share_views: 0,
        pinned: false,
        created_by: ANA,
        updated_by: ANA,
        created_at: T,
        updated_at: T,
        archived_at: null,
      },
    ];
    const { db } = acme(tables);
    for (const visibility of ['link', 'password'] as const)
      await expect(
        setViewAccess(db, VIEW_ID, { visibility, password: 'secreta-123', userId: ANA }),
      ).rejects.toThrow(ValidationError);
    await expect(setViewAccess(db, VIEW_ID, { visibility: 'link', userId: ANA })).rejects.toThrow(
      /Feed privado/,
    );
  });
});

describe('el catálogo del Feed', () => {
  it('lista sólo lo de quien pregunta: conexiones por su última lectura, capturas sueltas y vistas preparadas', async () => {
    const { db } = acme();
    const catalog = await viewCatalog(db, { viewerId: ANA });
    const feed = catalog.filter((c) => c.kind === 'feed');
    expect(feed.map((f) => f.slug).sort()).toEqual(
      [
        `feedsrc.${CONNECTION}.0`,
        `feed.${CAPTURE}.0`,
        `feed.${CAPTURE_OLD}.0`,
        `feedview.${PREPARED}`,
      ].sort(),
    );
    for (const f of feed) {
      expect(f.sensitivity).toBe('personal');
      expect(trackerFieldsSchema.safeParse(f.fields).success, f.slug).toBe(true);
    }
    expect(feed.find((f) => f.slug === `feed.${CAPTURE}.0`)?.sample?.[0]?.label).toBe('Alpha');
    // Sin quién pregunta, no hay Feed.
    expect((await viewCatalog(db)).some((c) => c.kind === 'feed')).toBe(false);
    // Beto no ve nada de Ana, sólo lo suyo.
    const beto = (await viewCatalog(db, { viewerId: BETO })).filter((c) => c.kind === 'feed');
    expect(beto.map((f) => f.slug)).toEqual([`feed.${CAPTURE_BETO}.0`]);
  });

  it('guardar: el dueño comprueba campos; un compañero conserva sin abrir, pero no agrega', async () => {
    const { db } = acme();
    const mine = `feed.${CAPTURE}.0`;
    const good = {
      version: 1,
      blocks: [
        {
          id: 'm',
          type: 'metric',
          title: 'Total',
          tracker: mine,
          aggregate: 'sum',
          field: 'valor',
        },
      ],
    };
    await expect(validateSpec(db, good, { viewerId: ANA })).resolves.toBeTruthy();
    const bad = {
      version: 1,
      blocks: [
        {
          id: 'm',
          type: 'metric',
          title: 'Total',
          tracker: mine,
          aggregate: 'sum',
          field: 'kilos',
        },
      ],
    };
    await expect(validateSpec(db, bad, { viewerId: ANA })).rejects.toThrow(/kilos/);
    // Beto edita la vista de Ana: la tabla de Ana se conserva tal cual...
    await expect(validateSpec(db, good, { viewerId: BETO, keep: [mine] })).resolves.toBeTruthy();
    // ...pero no puede meterla en una vista que no la tenía.
    await expect(validateSpec(db, good, { viewerId: BETO })).rejects.toThrow(/no está disponible/);
  });
});

// ---------------------------------------------------------------------------
// Activaciones, seguimientos, operaciones y rutinas: de cada persona
// ---------------------------------------------------------------------------

describe('las fuentes de cada persona', () => {
  it('son personales, de sólo lectura y con campos válidos', () => {
    const personal = [...PLATFORM_SOURCES.values()]
      .filter((s) => s.sensitivity === 'personal')
      .map((s) => s.id)
      .sort();
    expect(personal).toEqual([
      'cortex.activaciones',
      'cortex.operaciones',
      'cortex.rutinas',
      'cortex.seguimientos',
    ]);
    const spec = viewSpecSchema.parse({
      version: 1,
      blocks: [{ id: 'f', type: 'form', title: 'F', tracker: 'cortex.operaciones' }],
    });
    const catalog = [...PLATFORM_SOURCES.values()].map((s) => ({
      slug: s.id,
      name: s.name,
      fields: s.fields,
    }));
    expect(checkSpecAgainst(spec, catalog).join(' ')).toContain('sólo lectura');
  });

  it('cada quien ve sus activaciones, con coincidencias, inválidas y asuntos', async () => {
    const { db } = acme();
    const spec = specOver('cortex.activaciones', 'cortex.seguimientos', 'cortex.operaciones');
    const ana = await loadViewSources(db, spec, { viewerId: ANA });
    const runs = ana.get('cortex.activaciones')?.rows ?? [];
    expect(runs.map((r) => r.label)).toEqual(['Entregas sin factura']);
    expect(runs[0]?.values).toMatchObject({
      estado: 'Publicada',
      regla: 'Condiciones',
      origen: 'Seguimiento',
      filas: 4,
      coincidencias: 2,
      invalidas: 1,
      asuntos: 2,
      fecha: '2026-09-20',
    });
    expect(ana.get('cortex.seguimientos')?.rows[0]?.values).toMatchObject({
      estado: 'Activa',
      disparador: 'Al cambiar la fuente',
      frecuencia: 'Cada hora',
      fuente: 'Pedidos (Google Sheets)',
      resultado: 'Revisada',
      coincidencias: 2,
      asuntos_nuevos: 1,
    });
    const ops = ana.get('cortex.operaciones')?.rows ?? [];
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      label: 'Nota crédito Alpha',
      values: {
        estado: 'Verificado',
        verificacion: 'Comprobada',
        accion: 'crear_nota_credito',
        duracion_s: 42,
      },
    });

    const beto = await loadViewSources(db, spec, { viewerId: BETO });
    expect(beto.get('cortex.activaciones')?.rows.map((r) => r.label)).toEqual(['De Beto']);
    expect(beto.get('cortex.seguimientos')?.rows).toEqual([]);
    expect(beto.get('cortex.operaciones')?.rows[0]?.values.verificacion).toBe('Incierta');
  });

  it('rutinas: las propias y las globales, nunca las privadas de otro', async () => {
    const { db } = acme();
    const sources = await loadViewSources(db, specOver('cortex.rutinas'), { viewerId: ANA });
    const rows = sources.get('cortex.rutinas')?.rows ?? [];
    expect(rows.map((r) => r.label)).toEqual(['Resumen diario', 'Cartera del lunes']);
    expect(rows[0]?.values).toMatchObject({ estado: 'Correcta', alcance: 'Mía', duracion_s: 30 });
    expect(rows[1]?.values).toMatchObject({
      estado: 'Con error',
      alcance: 'De todo el equipo',
      error: 'Sin conexión',
    });
  });

  it('afuera no se leen, y sin quién mira tampoco', async () => {
    const { db } = acme();
    const spec = specOver('cortex.activaciones');
    const pub = await loadViewSources(db, spec, { audience: 'public', viewerId: ANA });
    expect(pub.get('cortex.activaciones')).toMatchObject({
      rows: [],
      blocked: PERSONAL_SOURCE_BLOCKED,
    });
    const nobody = await loadViewSources(db, spec);
    expect(nobody.get('cortex.activaciones')).toMatchObject({
      rows: [],
      blocked: PERSONAL_SOURCE_NO_VIEWER,
    });
    expect(internalSourcesOf(spec).map((s) => s.id)).toEqual(['cortex.activaciones']);
  });
});
