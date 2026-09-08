import { describe, expect, it } from 'vitest';
import { canClassifyFinanceSource, classifySourceError } from './source-policy';

describe('finance source policy', () => {
  it('only lets current workspace owners and admins classify', () => {
    expect(canClassifyFinanceSource('owner')).toBe(true);
    expect(canClassifyFinanceSource('admin')).toBe(true);
    expect(canClassifyFinanceSource('member')).toBe(false);
    expect(canClassifyFinanceSource('org_admin')).toBe(false);
  });

  it('keeps stale writes and semantic failures distinct', () => {
    expect(classifySourceError('40001').status).toBe(409);
    expect(classifySourceError('22023').status).toBe(422);
    expect(classifySourceError('42501').status).toBe(403);
    expect(classifySourceError('P0002').status).toBe(404);
  });
});
