import type { SessionUser } from '@cortex/core';
import { describe, expect, it } from 'vitest';
import { CorporateSupervisionError, assertCorporateFounder } from './team-activity';

function user(kind: 'personal' | 'company', role: 'owner' | 'admin' | 'member'): SessionUser {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'persona@example.com',
    name: 'Persona',
    role: role === 'owner' ? 'org_admin' : 'member',
    organization: { id: 'org', name: 'Espacio', slug: null, kind, role },
  };
}

describe('corporate founder supervision', () => {
  it('allows only an owner acting inside a company', () => {
    expect(() => assertCorporateFounder(user('company', 'owner'))).not.toThrow();
    expect(() => assertCorporateFounder(user('company', 'admin'))).toThrow(
      CorporateSupervisionError,
    );
    expect(() => assertCorporateFounder(user('company', 'member'))).toThrow(
      CorporateSupervisionError,
    );
  });

  it('never opens personal activity, even to its owner', () => {
    expect(() => assertCorporateFounder(user('personal', 'owner'))).toThrow(
      CorporateSupervisionError,
    );
  });
});
