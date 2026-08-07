import {
  APPLYING_METHODS as CANONICAL_APPLYING,
  CLIENT_SERVICES as CANONICAL_SERVICES,
  CLIENT_STATUSES as CANONICAL_STATUSES,
  CUSTOMS_ROLES as CANONICAL_CUSTOMS_ROLES,
  CUSTOMS_ROLE_LABEL as CANONICAL_CUSTOMS_LABEL,
  ENTITY_KIND_LABEL as CANONICAL_ENTITY_LABEL,
  LINK_ENTITY_KINDS as CANONICAL_ENTITY_KINDS,
  LINK_METHODS as CANONICAL_METHODS,
  METHOD_LABEL as CANONICAL_METHOD_LABEL,
  METHOD_SENTENCE as CANONICAL_METHOD_SENTENCE,
  PUBLIC_EMAIL_DOMAINS as CANONICAL_PUBLIC_DOMAINS,
  SERVICE_LABEL as CANONICAL_SERVICE_LABEL,
  STATUS_LABEL as CANONICAL_STATUS_LABEL,
  STATUS_TONE as CANONICAL_STATUS_TONE,
} from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  APPLYING_METHODS,
  CLIENT_SERVICES,
  CLIENT_STATUSES,
  CUSTOMS_ROLES,
  CUSTOMS_ROLE_LABEL,
  ENTITY_KIND_LABEL,
  LINK_ENTITY_KINDS,
  LINK_METHODS,
  METHOD_LABEL,
  METHOD_SENTENCE,
  PUBLIC_EMAIL_DOMAINS,
  SERVICE_LABEL,
  STATUS_LABEL,
  STATUS_TONE,
} from './clients-shape';

/**
 * `clients-shape.ts` restates the client vocabulary for the browser, because
 * importing it from the package drags a Node builtin into the client bundle and
 * breaks the production build without failing typecheck or the tests.
 *
 * This is the other half of that bargain: it runs in Node, so it may import the
 * real module, and it fails the moment the two disagree. Without it the copy is
 * a silent fork — somebody adds a status to the package, the register dialog
 * never offers it, and nothing anywhere goes red.
 *
 * The most load-bearing assertion is the last one. APPLYING_METHODS is the list
 * of signals allowed to attach something to a client with nobody reviewing it;
 * if the package widened that set and this copy did not, the screen would label
 * an automatic link "propuesto" and a person would trust a badge that is lying.
 */
describe('client vocabulary mirrored for the browser', () => {
  it('lists exactly the statuses the package defines, in the same order', () => {
    expect([...CLIENT_STATUSES]).toEqual([...CANONICAL_STATUSES]);
    expect(STATUS_LABEL).toEqual(CANONICAL_STATUS_LABEL);
    expect(STATUS_TONE).toEqual(CANONICAL_STATUS_TONE);
  });

  it('carries the same services and customs roles', () => {
    expect([...CLIENT_SERVICES]).toEqual([...CANONICAL_SERVICES]);
    expect(SERVICE_LABEL).toEqual(CANONICAL_SERVICE_LABEL);
    expect([...CUSTOMS_ROLES]).toEqual([...CANONICAL_CUSTOMS_ROLES]);
    expect(CUSTOMS_ROLE_LABEL).toEqual(CANONICAL_CUSTOMS_LABEL);
  });

  it('carries the same kinds of thing that can hang off a client', () => {
    expect([...LINK_ENTITY_KINDS]).toEqual([...CANONICAL_ENTITY_KINDS]);
    expect(ENTITY_KIND_LABEL).toEqual(CANONICAL_ENTITY_LABEL);
  });

  it('carries the same explanation for every way a link can be made', () => {
    expect([...LINK_METHODS]).toEqual([...CANONICAL_METHODS]);
    expect(METHOD_LABEL).toEqual(CANONICAL_METHOD_LABEL);
    expect(METHOD_SENTENCE).toEqual(CANONICAL_METHOD_SENTENCE);
  });

  it('refuses the same free mail providers', () => {
    expect([...PUBLIC_EMAIL_DOMAINS].sort()).toEqual([...CANONICAL_PUBLIC_DOMAINS].sort());
  });

  // If this fails, do not "fix" it by copying the new value across. Read the
  // note above APPLYING_METHODS in packages/agent-tools/src/clients/shape.ts
  // first: widening that set is how one customer's mail reaches another
  // customer's card.
  it('agrees on which signals are applied without a human reviewing them', () => {
    expect([...APPLYING_METHODS].sort()).toEqual([...CANONICAL_APPLYING].sort());
  });
});
