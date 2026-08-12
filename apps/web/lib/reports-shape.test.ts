import {
  GENERATED_REPORT_KINDS as CANONICAL_GENERATED,
  REPORT_KINDS as CANONICAL_KINDS,
  REPORT_KIND_LABEL as CANONICAL_LABEL,
} from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  GENERATED_REPORT_KINDS,
  REPORT_KINDS,
  REPORT_KIND_ICON,
  REPORT_KIND_LABEL,
  REPORT_KIND_PITCH,
} from './reports-shape';

/**
 * `reports-shape.ts` restates the report vocabulary the browser needs, because
 * importing it from the package drags `node:dns` into the client bundle and
 * fails the production build while typecheck and test stay green.
 *
 * This test is the other half of that bargain: it runs in Node, so it may import
 * the real module, and it fails the moment the two disagree. Without it the copy
 * is a silent fork — somebody adds a fourth report, the picker never offers it,
 * and nothing anywhere goes red.
 */
describe('report vocabulary mirrored for the client', () => {
  it('lists exactly the kinds the package defines, in the same order', () => {
    expect([...REPORT_KINDS]).toEqual([...CANONICAL_KINDS]);
  });

  it('carries the same Spanish label for every kind', () => {
    expect(REPORT_KIND_LABEL).toEqual(CANONICAL_LABEL);
  });

  it('has a pitch and an icon for every kind, so the picker can never render a blank card', () => {
    for (const kind of REPORT_KINDS) {
      expect(REPORT_KIND_PITCH[kind]?.length ?? 0).toBeGreaterThan(10);
      expect(REPORT_KIND_ICON[kind]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  /**
   * The two lists are not the same list, and the difference is load-bearing:
   * the picker iterates the generated ones, so a kind that leaked into it would
   * render a "Generar" button for something `buildReport` cannot build.
   */
  it('mirrors the generated kinds too, and keeps them a strict subset', () => {
    expect([...GENERATED_REPORT_KINDS]).toEqual([...CANONICAL_GENERATED]);
    for (const kind of GENERATED_REPORT_KINDS) {
      expect(REPORT_KINDS as readonly string[]).toContain(kind);
    }
  });

  it('keeps the chat chart out of the generated list', () => {
    expect(GENERATED_REPORT_KINDS as readonly string[]).not.toContain('chart');
    expect(REPORT_KINDS as readonly string[]).toContain('chart');
  });
});
