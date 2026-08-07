import { describe, expect, it } from 'vitest';
import { buildReport } from '../build';
import { figuresOf, sourceById } from '../document';
import { renderReportHtml } from '../render';
import { documentHash, getReport, saveReport } from '../store';
import { ACME, ANA, NOW, TODAY, world } from './fixture';

/**
 * DOES A SAVED REPORT STAY THE REPORT IT WAS?
 *
 * This is the property the whole storage design exists for, and it is the one
 * that is easy to believe and never verify. The test does the only thing that
 * actually proves it: generate a report, then CHANGE THE UNDERLYING DATA
 * underneath it, then open the saved one and check that not one number moved —
 * while separately checking that a freshly built report DOES move, so the test
 * cannot pass by measuring nothing.
 *
 * If this fails, the July report has started reporting on September, and every
 * decision anybody made from an old report becomes unauditable.
 */

describe('a saved report is a photograph', () => {
  it('shows the same figures after the data changes underneath it', async () => {
    const w = world();
    const db = w.db(ACME);
    const ctx = w.ctx(ACME, ANA);

    const original = await buildReport('expiries', { db, today: TODAY, now: NOW });
    const row = await saveReport(ctx, { kind: 'expiries', document: original, params: {} });

    const before = renderReportHtml(original, { idPrefix: 'x' });
    const figuresBefore = figuresOf(original).map((f) => `${f.label}=${f.figure.display}`);

    // The world moves on: a commitment is met, another is added, an amount is
    // corrected. Exactly the kind of ordinary week that happens between
    // generating a report and somebody reopening it.
    const commitments = w.tables.commitments as Array<Record<string, unknown>>;
    const met = commitments.find((c) => c.id === 'c-acme-2');
    if (met) met.state = 'met';
    const soat = commitments.find((c) => c.id === 'c-acme-1');
    if (soat) soat.amount_cop = 99_000_000;
    commitments.push({
      ...(commitments[0] as Record<string, unknown>),
      id: 'c-acme-4',
      title: 'Plazo de aduana DIAN',
      kind: 'customs',
      due_on: '2026-08-10',
      amount_cop: 4_000_000,
      series_id: 's-acme-4',
    });

    const reopened = await getReport(db, row.id);
    expect(reopened).not.toBeNull();
    if (!reopened) return;

    const figuresAfter = figuresOf(reopened.document).map((f) => `${f.label}=${f.figure.display}`);
    expect(figuresAfter).toEqual(figuresBefore);

    // Byte-identical HTML, not merely equal numbers: the rendering is a pure
    // function of the document, so anything that changed would show up here.
    expect(renderReportHtml(reopened.document, { idPrefix: 'x' })).toBe(before);

    // And the freeze is checkable, not just true.
    expect(reopened.intact).toBe(true);

    // The control: rebuilding now must NOT match, or the assertion above is
    // measuring a world that never moved.
    const rebuilt = await buildReport('expiries', { db, today: TODAY, now: NOW });
    const figuresRebuilt = figuresOf(rebuilt).map((f) => `${f.label}=${f.figure.display}`);
    expect(figuresRebuilt).not.toEqual(figuresBefore);
  });

  it('notices when the stored document is edited behind its back', async () => {
    const w = world();
    const db = w.db(ACME);
    const ctx = w.ctx(ACME, ANA);

    const doc = await buildReport('fleet', { db, today: TODAY, now: NOW });
    const row = await saveReport(ctx, { kind: 'fleet', document: doc, params: {} });

    // The failure this guards against is not an attacker — it is a migration,
    // a backfill, or a well-meant manual fix in production.
    const stored = (w.tables.reports as Array<Record<string, unknown>>).find(
      (r) => r.id === row.id,
    );
    expect(stored).toBeDefined();
    (stored as Record<string, unknown>).document = {
      ...(stored as { document: Record<string, unknown> }).document,
      title: 'Un título que nadie generó',
    };

    const reopened = await getReport(db, row.id);
    expect(reopened?.intact).toBe(false);
  });

  it('stores the same hash for the same content, whatever order the keys arrive in', () => {
    // The snapshot check would be worthless if the hash depended on key order:
    // a document that round-trips through a JSON column would report itself
    // tampered with on every read, and the warning would be ignored within a
    // week.
    const a = { version: 1, title: 'x', sections: [{ type: 'prose', heading: null }] };
    const b = { sections: [{ heading: null, type: 'prose' }], title: 'x', version: 1 };
    expect(documentHash(a as never)).toBe(documentHash(b as never));
  });
});

/**
 * ARE THE NUMBERS TRACEABLE?
 *
 * A report with a figure nobody can trace back is exactly what this product
 * exists to eliminate. The schema makes an unsourced figure unconstructable;
 * this checks the builders actually produce sources that RESOLVE, name a real
 * system, carry the moment they were read, and say how the arithmetic was done.
 */
describe('every figure carries its provenance', () => {
  for (const kind of ['expiries', 'fleet', 'client_activity'] as const) {
    it(`${kind}: every figure resolves to a declared source with a method`, async () => {
      const w = world();
      const doc = await buildReport(kind, { db: w.db(ACME), today: TODAY, now: NOW });

      const figures = figuresOf(doc);
      expect(figures.length).toBeGreaterThan(0);

      for (const { label, figure } of figures) {
        const src = sourceById(doc, figure.sourceId);
        expect(src, `${label} cites an undeclared source`).toBeDefined();
        // The method has to be a sentence somebody can act on, not a table name.
        expect(figure.method.length, `${label} has no method`).toBeGreaterThan(20);
        expect(src?.system.length ?? 0).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(src?.readAt ?? ''))).toBe(false);
      }
    });

    it(`${kind}: every chart and table cites a source too`, async () => {
      const w = world();
      const doc = await buildReport(kind, { db: w.db(ACME), today: TODAY, now: NOW });
      for (const section of doc.sections) {
        if (section.type === 'chart') {
          expect(sourceById(doc, section.sourceId)).toBeDefined();
          expect(sourceById(doc, section.table.sourceId)).toBeDefined();
        }
        if (section.type === 'table') {
          expect(sourceById(doc, section.table.sourceId)).toBeDefined();
        }
      }
    });

    it(`${kind}: the source ledger is printed on the page`, async () => {
      const w = world();
      const doc = await buildReport(kind, { db: w.db(ACME), today: TODAY, now: NOW });
      const html = renderReportHtml(doc);
      expect(html).toContain('De dónde salió cada cifra');
      for (const src of doc.sources) {
        expect(html).toContain(src.system.replace(/&/g, '&amp;'));
      }
      // Every metric shows a citation marker; a number without one would mean
      // the ledger is decoration.
      const markers = html.match(/class="rp-cite"/g)?.length ?? 0;
      expect(markers).toBeGreaterThanOrEqual(figuresOf(doc).length);
    });
  }
});
