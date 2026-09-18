import type { CustomToolResult, CustomToolRow } from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  customToolSnapshot,
  isStaleExecution,
  isUnknownProviderResult,
  isVerificationUnavailable,
  verificationMatches,
} from './activation-execution';

const tool = (overrides: Partial<CustomToolRow> = {}): CustomToolRow => ({
  id: 'tool-id',
  organization_id: 'org',
  slug: 'update_case',
  name: 'Actualizar asunto',
  description: 'Actualiza un registro',
  input_schema: { fields: [] },
  http_method: 'POST',
  url_template: 'https://provider.test/cases/{{caseId}}',
  headers: {},
  body_encoding: 'json',
  body_template: { state: '{{state}}' },
  auth_type: 'bearer',
  auth_header_name: null,
  auth_username: null,
  auth_secret_encrypted: 'secret-never-in-snapshot',
  response_path: null,
  response_max_chars: 10_000,
  timeout_ms: 15_000,
  allow_insecure_http: false,
  follow_redirects: true,
  requires_confirmation: true,
  rate_limit_per_minute: 20,
  enabled: true,
  ...overrides,
});

const ok = (data: unknown, extra: Partial<CustomToolResult> = {}): CustomToolResult => ({
  ok: true,
  status: 200,
  data,
  ...extra,
});

describe('activation operation verification boundary', () => {
  it('requires an explicit own response path and rejects incomplete responses', () => {
    const verifier = { path: 'data.state', match: 'equals' as const, expected: 'done' };
    expect(verificationMatches(ok({ state: 'done' }), verifier)).toBe(true);
    expect(verificationMatches(ok({ state: 'waiting' }), verifier)).toBe(false);
    expect(verificationMatches(ok({}), verifier)).toBe(false);
    expect(verificationMatches(ok({ state: 'done' }, { truncated: true }), verifier)).toBe(false);
    expect(
      verificationMatches(ok({ state: 'done' }), {
        path: 'data.__proto__.state',
        match: 'equals',
        expected: 'done',
      }),
    ).toBe(false);
    expect(
      verificationMatches(ok({ state: 'done' }), {
        path: 'data.state',
        match: 'equals',
        expected: undefined,
      }),
    ).toBe(false);
  });

  it('supports a non-empty contains criterion while refusing empty criteria', () => {
    expect(
      verificationMatches(ok({ message: 'provider says done for case 42' }), {
        path: 'data.message',
        match: 'contains',
        expected: 'done',
      }),
    ).toBe(true);
    expect(
      verificationMatches(ok({ message: 'provider says done' }), {
        path: 'data.message',
        match: 'contains',
        expected: '',
      }),
    ).toBe(false);
    expect(
      verificationMatches(ok({ state: 'done' }), {
        path: 'data',
        match: 'contains',
        expected: {},
      }),
    ).toBe(false);
  });
});

describe('activation provider uncertainty', () => {
  it('marks a write timeout unknown and never treats a known 4xx as a timeout', () => {
    expect(isUnknownProviderResult({ ok: false, status: null, message: 'timeout' }, 'POST')).toBe(
      true,
    );
    expect(isUnknownProviderResult({ ok: false, status: 504, message: 'gateway' }, 'PATCH')).toBe(
      true,
    );
    expect(
      isUnknownProviderResult({ ok: false, status: 400, message: 'invalid state' }, 'POST'),
    ).toBe(false);
  });

  it('keeps a verifier timeout unresolved without allowing a write retry', () => {
    expect(isVerificationUnavailable({ ok: false, status: 504, message: 'timed out' })).toBe(true);
    expect(isVerificationUnavailable({ ok: false, status: 401, message: 'unauthorized' })).toBe(
      false,
    );
    // GET failures are not provider write failures, but this result still
    // cannot prove the requested state and the operation bridge reconciles it
    // with another read only.
    expect(isUnknownProviderResult({ ok: false, status: 504, message: 'timed out' }, 'GET')).toBe(
      false,
    );
  });
});

describe('activation invalidation and recovery', () => {
  it('changes the fingerprint when a provider definition changes and excludes secrets', () => {
    const original = customToolSnapshot(tool());
    expect(customToolSnapshot(tool({ auth_secret_encrypted: 'rotated-secret' }))).not.toBe(
      original,
    );
    expect(
      customToolSnapshot(tool({ url_template: 'https://provider.test/v2/cases/{{caseId}}' })),
    ).not.toBe(original);
    expect(customToolSnapshot(tool({ http_method: 'PUT' }))).not.toBe(original);
  });

  it('only makes a stale in-flight operation eligible for read-only recovery', () => {
    const old = new Date(Date.now() - 120_000).toISOString();
    const fresh = new Date(Date.now() - 1_000).toISOString();
    expect(isStaleExecution({ status: 'executing', started_at: old })).toBe(true);
    expect(isStaleExecution({ status: 'verifying', started_at: old })).toBe(true);
    expect(isStaleExecution({ status: 'executing', started_at: fresh })).toBe(false);
    expect(isStaleExecution({ status: 'outcome_unknown', started_at: old })).toBe(false);
  });
});
