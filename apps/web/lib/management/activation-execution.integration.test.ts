import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  runTool: vi.fn(),
  claimApproval: vi.fn(),
  getManagementCase: vi.fn(),
  deniedToolPatterns: vi.fn(),
}));

vi.mock('@/lib/agent', () => ({ buildToolContext: vi.fn(() => ({})) }));
vi.mock('@/lib/tool-access', () => ({
  deniedToolPatterns: h.deniedToolPatterns,
  isToolDenied: () => false,
}));
vi.mock('@/lib/approvals/claim', () => ({
  claimApproval: h.claimApproval,
  supabaseApprovalStore: vi.fn(() => ({})),
}));
vi.mock('@cortex/agent-tools', () => ({
  EXECUTION_COLUMNS: '*',
  SAFE_COLUMNS: '*',
  customToolDef: (row: ToolRow) => ({
    row,
    inputSchema: { safeParse: () => ({ success: true }) },
  }),
  runTool: h.runTool,
  toolIdAllowed: () => true,
  getManagementCase: h.getManagementCase,
}));

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  type ActivationOperation,
  claimActivationApproval,
  customToolSnapshot,
  reconcileActivationOperation,
} from './activation-execution';

type ToolRow = {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  description: string;
  input_schema: { fields: [] };
  http_method: 'GET' | 'POST';
  url_template: string;
  headers: Record<string, string>;
  body_encoding: 'json';
  body_template: Record<string, unknown>;
  auth_type: 'none';
  auth_header_name: null;
  auth_username: null;
  auth_secret_encrypted: null;
  response_path: null;
  response_max_chars: number;
  timeout_ms: number;
  allow_insecure_http: false;
  follow_redirects: true;
  requires_confirmation: boolean;
  rate_limit_per_minute: number;
  enabled: boolean;
};

const actor = '11111111-1111-4111-8111-111111111111';
const agent = '22222222-2222-4222-8222-222222222222';
const caseId = '33333333-3333-4333-8333-333333333333';
const runId = '44444444-4444-4444-8444-444444444444';
const approvalId = '55555555-5555-4555-8555-555555555555';
const operationId = '66666666-6666-4666-8666-666666666666';

function row(overrides: Partial<ToolRow> = {}): ToolRow {
  return {
    id: 'tool-id',
    organization_id: 'org',
    slug: 'write_case',
    name: 'Write case',
    description: 'Writes a case',
    input_schema: { fields: [] },
    http_method: 'POST',
    url_template: 'https://provider.test/cases/{{caseId}}',
    headers: {},
    body_encoding: 'json',
    body_template: {},
    auth_type: 'none',
    auth_header_name: null,
    auth_username: null,
    auth_secret_encrypted: null,
    response_path: null,
    response_max_chars: 10_000,
    timeout_ms: 15_000,
    allow_insecure_http: false,
    follow_redirects: true,
    requires_confirmation: true,
    rate_limit_per_minute: 20,
    enabled: true,
    ...overrides,
  };
}

function operation(overrides: Partial<ActivationOperation> = {}): ActivationOperation {
  const action = row();
  const verifier = row({
    id: 'verify-id',
    slug: 'read_case',
    name: 'Read case',
    description: 'Reads a case',
    http_method: 'GET',
    requires_confirmation: false,
  });
  return {
    id: operationId,
    organization_id: 'org',
    actor_id: actor,
    agent_id: agent,
    case_id: caseId,
    activation_run_id: runId,
    action_tool_id: 'custom.write_case',
    action_input: { caseId, state: 'done' },
    action_tool_snapshot: customToolSnapshot(action),
    verifier_tool_id: 'custom.read_case',
    verifier_input: { caseId },
    verifier_path: 'data.state',
    verifier_match: 'equals',
    verifier_expected: 'done',
    verifier_tool_snapshot: customToolSnapshot(verifier),
    source_evidence: { runId, sourceId: 'source', rows: [] },
    intent_hash: 'a'.repeat(64),
    idempotency_key: 'activation:key',
    approval_id: approvalId,
    approval_expires_at: new Date(Date.now() + 60_000).toISOString(),
    status: 'awaiting_approval',
    attempt: 0,
    before_observation: null,
    action_result: null,
    verification_result: null,
    evidence: null,
    provider_ref: null,
    error: null,
    revision: 2,
    started_at: null,
    completed_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private inFilters: Array<[string, unknown[]]> = [];
  private mode: 'many' | 'one' | 'maybe' = 'many';
  private updatePatch: Record<string, unknown> | null = null;
  private insertValue: Record<string, unknown> | null = null;
  constructor(
    private readonly db: FakeDb,
    private readonly table: string,
  ) {}
  select() {
    return this;
  }
  eq(key: string, value: unknown) {
    this.filters.push([key, value]);
    return this;
  }
  in(key: string, values: unknown[]) {
    this.inFilters.push([key, values]);
    return this;
  }
  is(key: string, value: unknown) {
    this.filters.push([key, value]);
    return this;
  }
  gt() {
    return this;
  }
  order() {
    return this;
  }
  limit() {
    return this;
  }
  update(value: Record<string, unknown>) {
    this.updatePatch = value;
    return this;
  }
  insert(value: Record<string, unknown>) {
    this.insertValue = value;
    return this;
  }
  maybeSingle() {
    this.mode = 'maybe';
    return this;
  }
  single() {
    this.mode = 'one';
    return this;
  }
  // biome-ignore lint/suspicious/noThenProperty: Supabase query builders are thenable.
  then(resolve: (value: { data: unknown; error: null }) => unknown) {
    const result = this.db.execute(this);
    return Promise.resolve(resolve(result));
  }
  get state() {
    return {
      table: this.table,
      filters: this.filters,
      inFilters: this.inFilters,
      mode: this.mode,
      updatePatch: this.updatePatch,
      insertValue: this.insertValue,
    };
  }
}

class FakeDb {
  constructor(
    readonly tables: Record<string, unknown[]>,
    private caseState = 'open',
  ) {}
  from(table: string) {
    return new FakeQuery(this, table);
  }
  execute(query: FakeQuery): { data: unknown; error: null } {
    const state = query.state;
    if (state.table === 'management_cases') return { data: null, error: null };
    let rows = [...(this.tables[state.table] ?? [])] as Array<Record<string, unknown>>;
    rows = rows.filter((item) => state.filters.every(([key, value]) => item[key] === value));
    rows = rows.filter((item) =>
      state.inFilters.every(([key, values]) => values.includes(item[key])),
    );
    if (state.updatePatch) {
      const item = rows[0];
      if (!item) return { data: null, error: null };
      Object.assign(item, state.updatePatch);
      return { data: item, error: null };
    }
    if (state.insertValue) {
      const item = { ...state.insertValue, id: state.insertValue.id ?? approvalId };
      const table = this.tables[state.table] ?? [];
      table.push(item);
      this.tables[state.table] = table;
      return { data: item, error: null };
    }
    const data = state.mode === 'many' ? rows : (rows[0] ?? null);
    return { data, error: null };
  }
  setCaseState(value: string) {
    this.caseState = value;
  }
  get state() {
    return this.caseState;
  }
}

function fakeDb(
  initial: ActivationOperation,
  action = row(),
  verifier = row({
    id: 'verify-id',
    slug: 'read_case',
    name: 'Read case',
    description: 'Reads a case',
    http_method: 'GET',
    requires_confirmation: false,
  }),
) {
  h.getManagementCase.mockImplementation(async () => ({
    data: { state: dbRef.state, activationEvidence: initial.source_evidence },
  }));
  const dbRef = new FakeDb({
    activation_operations: [initial],
    custom_tools: [action, verifier],
    agents: [{ id: agent, slug: 'cortex', allowed_tool_ids: ['*'], archived: false }],
    activation_runs: [
      {
        id: runId,
        actor_id: actor,
        status: 'committed',
        case_ids: [caseId],
        source_id: 'source',
      },
    ],
    chat_attachments: [{ id: 'source', created_by: actor, purge_at: '2099-01-01T00:00:00.000Z' }],
    mcp_pending_actions: [
      {
        id: approvalId,
        user_id: actor,
        agent_id: agent,
        tool_id: 'custom.write_case',
        input: initial.action_input,
        decision: 'approved',
      },
    ],
  });
  return dbRef;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.deniedToolPatterns.mockResolvedValue([]);
  h.claimApproval.mockResolvedValue({
    status: 'claimed',
    action: {
      id: approvalId,
      organizationId: 'org',
      userId: actor,
      agentId: agent,
      toolId: 'custom.write_case',
      input: { caseId, state: 'done' },
    },
  });
});

describe('activation execution transitions', () => {
  it('claims twice but reaches the provider once', async () => {
    let state = 'waiting';
    let writes = 0;
    h.runTool.mockImplementation(async (definition: { row: ToolRow }) => {
      if (definition.row.http_method === 'POST') {
        writes += 1;
        state = 'done';
        return { ok: true, status: 200, data: { id: 'provider-1' } };
      }
      return { ok: true, status: 200, data: { state } };
    });
    const initial = operation();
    const db = fakeDb(initial);
    const first = await claimActivationApproval(
      db as unknown as SupabaseClient,
      actor,
      operationId,
      'approve',
    );
    const second = await claimActivationApproval(
      db as unknown as SupabaseClient,
      actor,
      operationId,
      'approve',
    );
    expect(first.status).toBe('succeeded');
    expect(second.status).toBe('succeeded');
    expect(writes).toBe(1);
  });

  it('does not write when the tool changes or the case closes', async () => {
    let writes = 0;
    h.runTool.mockImplementation(async (definition: { row: ToolRow }) => {
      if (definition.row.http_method === 'POST') writes += 1;
      return { ok: true, status: 200, data: { state: 'waiting' } };
    });
    const changed = operation();
    const changedDb = fakeDb(changed);
    const changedRow = (changedDb.tables.custom_tools as ToolRow[])[0];
    if (!changedRow) throw new Error('missing synthetic action tool');
    changedRow.url_template = 'https://provider.test/v2/cases/{{caseId}}';
    const changedResult = await claimActivationApproval(
      changedDb as unknown as SupabaseClient,
      actor,
      operationId,
      'approve',
    );
    expect(changedResult.status).toBe('blocked');
    const closed = operation();
    const closedDb = fakeDb(closed);
    closedDb.setCaseState('verified');
    const closedResult = await claimActivationApproval(
      closedDb as unknown as SupabaseClient,
      actor,
      operationId,
      'approve',
    );
    expect(closedResult.status).toBe('blocked');
    const expired = operation();
    const expiredDb = fakeDb(expired);
    const source = (expiredDb.tables.chat_attachments as Array<{ purge_at: string }>)[0];
    if (!source) throw new Error('missing synthetic source');
    source.purge_at = '2000-01-01T00:00:00.000Z';
    const expiredResult = await claimActivationApproval(
      expiredDb as unknown as SupabaseClient,
      actor,
      operationId,
      'approve',
    );
    expect(expiredResult.status).toBe('blocked');
    expect(writes).toBe(0);
  });

  it('turns a post-write throw into unknown and reconciles with GET only', async () => {
    let writes = 0;
    let state = 'waiting';
    h.runTool.mockImplementation(async (definition: { row: ToolRow }) => {
      if (definition.row.http_method === 'POST') {
        writes += 1;
        state = 'done';
        throw new Error('transport timeout after provider commit');
      }
      return { ok: true, status: 200, data: { state } };
    });
    const initial = operation();
    const db = fakeDb(initial);
    const unknown = await claimActivationApproval(
      db as unknown as SupabaseClient,
      actor,
      operationId,
      'approve',
    );
    expect(unknown.status).toBe('outcome_unknown');
    const reconciled = await reconcileActivationOperation(
      db as unknown as SupabaseClient,
      actor,
      operationId,
    );
    expect(reconciled.status).toBe('succeeded');
    expect(writes).toBe(1);
    expect(
      h.runTool.mock.calls.filter(
        ([definition]) => (definition as { row: ToolRow }).row.http_method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('recovers a stale execution with a read and never calls the action', async () => {
    const initial = operation({
      status: 'executing',
      started_at: new Date(Date.now() - 120_000).toISOString(),
    });
    const db = fakeDb(initial);
    db.tables.activation_runs = [];
    db.setCaseState('verified');
    h.runTool.mockResolvedValue({ ok: true, status: 200, data: { state: 'done' } });
    const result = await reconcileActivationOperation(
      db as unknown as SupabaseClient,
      actor,
      operationId,
    );
    expect(result.status).toBe('succeeded');
    expect(h.runTool).toHaveBeenCalled();
    expect(
      h.runTool.mock.calls.every(
        ([definition]) => (definition as { row: ToolRow }).row.http_method === 'GET',
      ),
    ).toBe(true);
  });
});
