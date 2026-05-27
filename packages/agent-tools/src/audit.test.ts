import { describe, it, expect } from 'vitest';
import { hashInput } from './audit';

describe('hashInput', () => {
  it('is stable for equal inputs', () => {
    expect(hashInput({ a: 1, b: 2 })).toEqual(hashInput({ a: 1, b: 2 }));
  });
  it('differs for different inputs', () => {
    expect(hashInput({ a: 1 })).not.toEqual(hashInput({ a: 2 }));
  });
  it('handles null/undefined', () => {
    expect(hashInput(null)).toEqual(hashInput(undefined));
  });
});
