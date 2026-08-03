import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntegrationError, ValidationError } from '@cortex/core';
import { runTool } from '../index';
import { rateEstimate } from './estimate';
import { rateEstimateFromDocument } from './estimate-from-document';
import type { ToolContext } from '../types';

// ---------------------------------------------------------------------------
// Shared test context builder (mirrors runtool.test.ts pattern)
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const insertResult = { data: null, error: null };
  const upsertResult = { data: null, error: null };
  const noRow = { data: null, error: null };

  const fromBuilder = {
    insert: vi.fn().mockResolvedValue(insertResult),
    upsert: vi.fn().mockResolvedValue(upsertResult),
    update: vi.fn().mockReturnValue({ eq: vi.fn().mockResolvedValue({ data: null, error: null }) }),
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(noRow),
        }),
        maybeSingle: vi.fn().mockResolvedValue(noRow),
      }),
    }),
  };

  const db = { from: vi.fn().mockReturnValue(fromBuilder) };

  const integrations = {
    getAccessToken: vi.fn(),
    hasScopes: vi.fn().mockResolvedValue(true),
  };

  const logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };

  return {
    userId: '00000000-0000-0000-0000-000000000001',
    agentId: '00000000-0000-0000-0000-000000000002',
    conversationId: '00000000-0000-0000-0000-000000000003',
    db: db as unknown as ToolContext['db'],
    integrations: integrations as unknown as ToolContext['integrations'],
    logger: logger as unknown as ToolContext['logger'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// rate.estimate tests
// ---------------------------------------------------------------------------

describe('rate.estimate', () => {
  const validInput = {
    role: 'backend' as const,
    seniority: 'senior' as const,
    region: 'mx' as const,
    yearsExperience: 5,
  };

  const mockEstimatorResponse = {
    monthlyRateUsd: { min: 4000, max: 6000 },
    notes: 'Based on 2026-Q1 Zipdev pricing table',
  };

  beforeEach(() => {
    process.env.RATE_ESTIMATOR_URL = 'https://estimator.internal';
    process.env.RATE_ESTIMATOR_SERVICE_TOKEN = 'test-service-token';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RATE_ESTIMATOR_URL;
    delete process.env.RATE_ESTIMATOR_SERVICE_TOKEN;
  });

  it('happy path: calls estimator, returns validated output', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockEstimatorResponse,
    }));

    const ctx = makeCtx();
    const result = await runTool(rateEstimate, validInput, ctx);

    // toMatchObject, not toEqual: rate data is compensation-adjacent, so
    // runTool attaches a `_security` notice alongside the result.
    expect(result).toMatchObject(mockEstimatorResponse);
    expect(fetch).toHaveBeenCalledWith(
      'https://estimator.internal/api/internal/estimate',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-service-token',
        }),
      }),
    );
  });

  it('network error: throws IntegrationError when estimator returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'service unavailable',
    }));

    const ctx = makeCtx();
    await expect(runTool(rateEstimate, validInput, ctx)).rejects.toBeInstanceOf(IntegrationError);
  });

  it('throws ValidationError for invalid role', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(rateEstimate, { ...validInput, role: 'wizard' }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for invalid seniority', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(rateEstimate, { ...validInput, seniority: 'staff' }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError for invalid region', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(rateEstimate, { ...validInput, region: 'us' }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('enforces rateLimit of 20 per minute on the tool definition', () => {
    expect(rateEstimate.rateLimit).toEqual({ perMinute: 20 });
  });

  it('tool id is rate.estimate', () => {
    expect(rateEstimate.id).toBe('rate.estimate');
  });
});

// ---------------------------------------------------------------------------
// rate.estimate_from_document tests
// ---------------------------------------------------------------------------

describe('rate.estimate_from_document', () => {
  const mockEstimatorResponse = {
    monthlyRateUsd: { min: 3500, max: 5000 },
    notes: 'Based on 2026-Q1 Zipdev pricing table',
  };

  beforeEach(() => {
    process.env.RATE_ESTIMATOR_URL = 'https://estimator.internal';
    process.env.RATE_ESTIMATOR_SERVICE_TOKEN = 'test-service-token';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.RATE_ESTIMATOR_URL;
    delete process.env.RATE_ESTIMATOR_SERVICE_TOKEN;
  });

  it('happy path: extracts role/seniority/region from text and calls estimator', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockEstimatorResponse,
    }));

    const ctx = makeCtx();
    const result = await runTool(rateEstimateFromDocument, {
      documentText:
        'We are looking for a senior frontend developer in Mexico (mx) with 4 years of experience.',
    }, ctx);

    expect(result.monthlyRateUsd).toEqual(mockEstimatorResponse.monthlyRateUsd);
    expect(result.extracted.role).toBe('frontend');
    expect(result.extracted.seniority).toBe('senior');
    expect(result.extracted.region).toBe('mx');
    expect(result.extracted.yearsExperience).toBe(4);
  });

  it('uses defaults when extraction fails for role', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockEstimatorResponse,
    }));

    const ctx = makeCtx();
    const result = await runTool(rateEstimateFromDocument, {
      documentText: 'We need a senior engineer in br with 3 years of experience.',
      defaults: { role: 'backend' },
    }, ctx);

    expect(result.extracted.role).toBe('backend');
    expect(result.extracted.seniority).toBe('senior');
    expect(result.extracted.region).toBe('br');
  });

  it('throws ValidationError when role cannot be extracted and no default provided', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(rateEstimateFromDocument, {
        documentText: 'Looking for a senior engineer with 5 years of experience.',
      }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError when seniority cannot be extracted and no default provided', async () => {
    const ctx = makeCtx();
    await expect(
      runTool(rateEstimateFromDocument, {
        documentText: 'Looking for a backend engineer with 5 years of experience.',
      }, ctx),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('defaults region to latam when not found in text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockEstimatorResponse,
    }));

    const ctx = makeCtx();
    const result = await runTool(rateEstimateFromDocument, {
      documentText: 'We need a senior backend engineer with 3 years of experience.',
    }, ctx);

    expect(result.extracted.region).toBe('latam');
  });

  it('network error from estimator surfaces as IntegrationError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    }));

    const ctx = makeCtx();
    await expect(
      runTool(rateEstimateFromDocument, {
        documentText: 'We need a senior backend developer in mx with 5 years of experience.',
      }, ctx),
    ).rejects.toBeInstanceOf(IntegrationError);
  });

  it('tool id is rate.estimate_from_document', () => {
    expect(rateEstimateFromDocument.id).toBe('rate.estimate_from_document');
  });
});
