import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CombinedSourceConfigSchema,
  previewCombinedSource,
  saveCombinedSource,
} from './combined-source';

type Row = Record<string, unknown>;

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER_ACTOR = '22222222-2222-4222-8222-222222222222';
const SOURCE_A = '31111111-1111-4111-8111-111111111111';
const SOURCE_B = '32222222-2222-4222-8222-222222222222';
const SOURCE_C = '32333333-3333-4333-8333-333333333333';
const SOURCE_OTHER_ORG = '33333333-3333-4333-8333-333333333333';
const ATTACHMENT_A = '41111111-1111-4111-8111-111111111111';
const ATTACHMENT_B = '42222222-2222-4222-8222-222222222222';

const state = {
  rows: [] as Row[],
  writes: [] as string[],
};

class Query {
  private filters: Array<(row: Row) => boolean> = [];
  private payload: Row | Row[] | null = null;
  private operation: 'read' | 'insert' | 'update' | 'delete' = 'read';

  constructor(private readonly table: string) {}

  select() {
    return this;
  }

  order() {
    return this;
  }

  limit() {
    return this;
  }

  eq(key: string, value: unknown) {
    this.filters.push((row) => row[key] === value);
    return this;
  }

  neq(key: string, value: unknown) {
    this.filters.push((row) => row[key] !== value);
    return this;
  }

  in(key: string, values: unknown[]) {
    this.filters.push((row) => values.includes(row[key]));
    return this;
  }

  gt(key: string, value: string) {
    this.filters.push((row) => String(row[key]) > value);
    return this;
  }

  not(key: string, _operator: string, value: unknown) {
    this.filters.push((row) => (row[key] ?? null) !== value);
    return this;
  }

  insert(payload: Row | Row[]) {
    this.payload = payload;
    this.operation = 'insert';
    return this;
  }

  update(payload: Row) {
    this.payload = payload;
    this.operation = 'update';
    return this;
  }

  delete() {
    this.operation = 'delete';
    return this;
  }

  private run(single = false) {
    let rows = state.rows.filter(
      (row) => row.table === this.table && this.filters.every((filter) => filter(row)),
    );
    if (this.operation === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload];
      rows = incoming.flatMap((payload) => {
        if (!payload) return [];
        const row = {
          id: payload.id ?? crypto.randomUUID(),
          table: this.table,
          enabled: true,
          status: 'ready',
          organization_id: 'org-a',
          purge_at: '2099-01-01T00:00:00.000Z',
          ...payload,
        };
        state.rows.push(row);
        state.writes.push(this.table);
        return [row];
      });
    } else if (this.operation === 'update') {
      for (const row of rows) Object.assign(row, this.payload);
    } else if (this.operation === 'delete') {
      state.rows = state.rows.filter((row) => !rows.includes(row));
    }
    return { data: single ? (rows[0] ?? null) : rows, count: rows.length, error: null };
  }

  async maybeSingle() {
    return this.run(true);
  }

  async single() {
    return this.run(true);
  }

  // biome-ignore lint/suspicious/noThenProperty: emulates a PostgREST query builder
  then(resolve: (value: ReturnType<Query['run']>) => unknown) {
    return Promise.resolve(this.run()).then(resolve);
  }
}

const db = {
  from: (table: string) => new Query(table),
} as unknown as SupabaseClient;

const tablesA = {
  name: 'Personas',
  rows: [
    ['id', 'Nombre'],
    ['1', 'Ana'],
    ['2', 'Beto'],
  ],
};
const tablesB = {
  name: 'Estados',
  rows: [
    ['id', 'Estado'],
    ['1', 'Activo'],
    ['1', 'Duplicado'],
    ['3', 'Nuevo'],
  ],
};

const config = {
  version: 1 as const,
  sourceIds: [SOURCE_A, SOURCE_B],
  approvedHeaders: [
    { sourceId: SOURCE_A, sheetIndex: 0, headers: ['id', 'Nombre'] },
    { sourceId: SOURCE_B, sheetIndex: 0, headers: ['id', 'Estado'] },
  ],
  mappings: [
    {
      left: { sourceId: SOURCE_A, sheetIndex: 0, column: 0, header: 'id' },
      right: { sourceId: SOURCE_B, sheetIndex: 0, column: 0, header: 'id' },
    },
  ],
  maxRows: 1000,
};

beforeEach(() => {
  state.rows = [
    {
      table: 'feed_sources',
      id: SOURCE_A,
      organization_id: 'org-a',
      actor_id: ACTOR,
      kind: 'file',
      name: 'Personas',
      latest_attachment_id: ATTACHMENT_A,
      enabled: true,
      status: 'ok',
      updated_at: '2026-09-18T10:00:00.000Z',
      last_changed_at: '2026-09-18T10:00:00.000Z',
      config: {},
    },
    {
      table: 'feed_sources',
      id: SOURCE_B,
      organization_id: 'org-a',
      actor_id: ACTOR,
      kind: 'google_sheet',
      name: 'Estados',
      latest_attachment_id: ATTACHMENT_B,
      enabled: true,
      status: 'ok',
      updated_at: '2026-09-18T10:00:00.000Z',
      last_changed_at: '2026-09-18T10:00:00.000Z',
      config: {},
    },
    {
      table: 'feed_sources',
      id: SOURCE_OTHER_ORG,
      organization_id: 'org-b',
      actor_id: OTHER_ACTOR,
      kind: 'file',
      name: 'Privada de otra empresa',
      latest_attachment_id: ATTACHMENT_A,
      enabled: true,
      status: 'ok',
      updated_at: '2026-09-18T10:00:00.000Z',
      last_changed_at: '2026-09-18T10:00:00.000Z',
      config: {},
    },
    {
      table: 'chat_attachments',
      id: ATTACHMENT_A,
      organization_id: 'org-a',
      created_by: ACTOR,
      feed_source_id: SOURCE_A,
      feed_kind: 'file',
      filename: 'personas.csv',
      feed_content_hash: 'a'.repeat(64),
      feed_tables: [tablesA],
      extracted_text: 'Personas',
      feed_truncated: false,
      purge_at: '2099-01-01T00:00:00.000Z',
    },
    {
      table: 'chat_attachments',
      id: ATTACHMENT_B,
      organization_id: 'org-a',
      created_by: ACTOR,
      feed_source_id: SOURCE_B,
      feed_kind: 'url',
      filename: 'estados.csv',
      feed_content_hash: 'b'.repeat(64),
      feed_tables: [tablesB],
      extracted_text: 'Estados',
      feed_truncated: false,
      purge_at: '2099-01-01T00:00:00.000Z',
    },
  ];
  state.writes = [];
});

describe('combined Feed source contract', () => {
  it('rejects inferred or incomplete mappings before reading any rows', () => {
    expect(
      CombinedSourceConfigSchema.safeParse({
        ...config,
        sourceIds: [SOURCE_A, SOURCE_B, SOURCE_OTHER_ORG],
      }).success,
    ).toBe(false);
    expect(
      CombinedSourceConfigSchema.safeParse({
        ...config,
        mappings: [
          {
            ...config.mappings[0],
            left: { ...config.mappings[0]?.left, header: 'Nombre parecido' },
          },
        ],
      }).success,
    ).toBe(false);

    const threeSources = {
      ...config,
      sourceIds: [SOURCE_A, SOURCE_B, SOURCE_C],
      approvedHeaders: [
        ...config.approvedHeaders,
        { sourceId: SOURCE_C, sheetIndex: 0, headers: ['id', 'Estado'] },
      ],
      mappings: [
        config.mappings[0],
        {
          left: { sourceId: SOURCE_A, sheetIndex: 0, column: 0, header: 'id' },
          right: { sourceId: SOURCE_C, sheetIndex: 0, column: 0, header: 'id' },
        },
      ],
    };
    expect(CombinedSourceConfigSchema.safeParse(threeSources).success).toBe(true);
    expect(
      CombinedSourceConfigSchema.safeParse({
        ...threeSources,
        mappings: [
          config.mappings[0],
          {
            left: { sourceId: SOURCE_B, sheetIndex: 0, column: 0, header: 'id' },
            right: { sourceId: SOURCE_C, sheetIndex: 0, column: 0, header: 'id' },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('keeps tenant isolation and marks duplicate keys ambiguous', async () => {
    const preview = await previewCombinedSource(db, ACTOR, 'org-a', config);
    expect(preview.status).toBe('ready');
    expect(preview.summary).toMatchObject({ matched: 0, unmatched: 2, ambiguous: 1 });
    expect(preview.rows.find((row) => row.key === '1')?.status).toBe('ambiguous');
    expect(preview.rows.find((row) => row.key === '1')?.provenance).toHaveLength(3);

    const privatePreview = await previewCombinedSource(db, ACTOR, 'org-a', {
      ...config,
      sourceIds: [SOURCE_A, SOURCE_OTHER_ORG],
      approvedHeaders: [
        config.approvedHeaders[0],
        { sourceId: SOURCE_OTHER_ORG, sheetIndex: 0, headers: ['id', 'Privado'] },
      ],
      mappings: [
        {
          left: config.mappings[0]?.left,
          right: { sourceId: SOURCE_OTHER_ORG, sheetIndex: 0, column: 0, header: 'id' },
        },
      ],
    });
    expect(privatePreview.status).toBe('blocked');
    expect(privatePreview.errors.join(' ')).toContain('no existe');
  });

  it('does not fuzzy-match names or case variants when the explicit key differs', async () => {
    const exactNameConfig = {
      ...config,
      approvedHeaders: [
        { sourceId: SOURCE_A, sheetIndex: 0, headers: ['id', 'Nombre'] },
        { sourceId: SOURCE_B, sheetIndex: 0, headers: ['id', 'Estado'] },
      ],
      mappings: [
        {
          left: { sourceId: SOURCE_A, sheetIndex: 0, column: 1, header: 'Nombre' },
          right: { sourceId: SOURCE_B, sheetIndex: 0, column: 1, header: 'Estado' },
        },
      ],
    };
    expect(CombinedSourceConfigSchema.safeParse(exactNameConfig).success).toBe(true);
    const sourceB = state.rows.find((row) => row.id === ATTACHMENT_B);
    if (!sourceB) throw new Error('fixture attachment missing');
    sourceB.feed_tables = [
      {
        name: 'Estados',
        rows: [
          ['Nombre', 'Estado'],
          ['ana', 'Activo'],
          ['Beto Jr.', 'Nuevo'],
        ],
      },
    ];
    const nameConfig = {
      ...exactNameConfig,
      mappings: [
        {
          left: { sourceId: SOURCE_A, sheetIndex: 0, column: 1, header: 'Nombre' },
          right: { sourceId: SOURCE_B, sheetIndex: 0, column: 0, header: 'Nombre' },
        },
      ],
      approvedHeaders: [
        { sourceId: SOURCE_A, sheetIndex: 0, headers: ['id', 'Nombre'] },
        { sourceId: SOURCE_B, sheetIndex: 0, headers: ['Nombre', 'Estado'] },
      ],
    };
    const preview = await previewCombinedSource(db, ACTOR, 'org-a', nameConfig);
    expect(preview.rows.some((row) => row.status === 'matched')).toBe(false);
  });

  it('marks shortened cells incomplete rather than authorizing a partial combined source', async () => {
    const attachment = state.rows.find((row) => row.id === ATTACHMENT_B);
    if (!attachment) throw new Error('fixture attachment missing');
    attachment.feed_tables = [
      {
        name: 'Estados',
        rows: [
          ['id', 'Estado'],
          ['1', 'x'.repeat(1001)],
        ],
      },
    ];
    const preview = await previewCombinedSource(db, ACTOR, 'org-a', config);
    expect(preview.status).toBe('blocked');
    expect(preview.summary.truncated).toBe(true);
    await expect(saveCombinedSource(db, ACTOR, 'org-a', 'No guardar', config)).rejects.toThrow(
      'supera los límites',
    );
  });

  it('blocks a newly appended header instead of silently remapping the approved schema', async () => {
    const attachment = state.rows.find((row) => row.id === ATTACHMENT_A);
    if (!attachment) throw new Error('fixture attachment missing');
    attachment.feed_tables = [
      {
        name: 'Personas',
        rows: [
          ['id', 'Nombre', 'Nota privada nueva'],
          ['1', 'Ana', 'no debe entrar'],
        ],
      },
    ];
    const preview = await previewCombinedSource(db, ACTOR, 'org-a', config);
    expect(preview.status).toBe('blocked');
    expect(preview.errors.join(' ')).toContain('Cambió el esquema');
    attachment.feed_tables = [tablesA];
  });

  it('treats header whitespace changes as schema drift', async () => {
    const attachment = state.rows.find((row) => row.id === ATTACHMENT_B);
    if (!attachment) throw new Error('fixture attachment missing');
    attachment.feed_tables = [
      {
        name: 'Estados',
        rows: [
          [' id', 'Estado'],
          ['1', 'Activo'],
        ],
      },
    ];
    const preview = await previewCombinedSource(db, ACTOR, 'org-a', config);
    expect(preview.status).toBe('blocked');
    expect(preview.errors.join(' ')).toContain('Cambió el esquema');
  });

  it('deduplicates identical captures while retaining the dependency ledger write', async () => {
    const first = await saveCombinedSource(db, ACTOR, 'org-a', 'Personas + estados', config);
    const second = await saveCombinedSource(db, ACTOR, 'org-a', 'Personas + estados', config);
    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(
      state.rows.filter((row) => row.table === 'chat_attachments' && row.feed_kind === 'combined'),
    ).toHaveLength(1);
    expect(state.rows.filter((row) => row.table === 'feed_combined_dependencies')).toHaveLength(2);
  });
});
