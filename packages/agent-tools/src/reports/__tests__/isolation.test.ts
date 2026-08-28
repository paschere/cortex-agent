import { describe, expect, it } from 'vitest';
import { buildReport } from '../build';
import { figuresOf } from '../document';
import { renderReportHtml, renderStandaloneHtml } from '../render';
import { getReport, listReports, saveReport } from '../store';
import { ACME, ANA, CARLA, GLOBEX, NOW, TODAY, world } from './fixture';

/**
 * TWO COMPANIES, ONE DATABASE — AND A MODULE THAT ADDS THINGS UP.
 *
 * A reporting surface is the worst place in a product to lose a workspace
 * filter, and the reason is specific: everywhere else a stray row appears as a
 * ROW, which somebody eventually notices. Here it disappears into a total. A
 * count that should say 3 says 5, a peso figure is off by an order of
 * magnitude, and the report still looks entirely correct.
 *
 * So none of these tests assert that a filter was applied. Every one of them
 * asserts on the OUTPUT: the totals, the tables, and the rendered HTML that a
 * shared link would serve. The fixture is built so a lost filter produces a
 * plausible report — both companies have a truck, a SOAT, a contract with a
 * counterparty spelled the same way, and a person with the same display name.
 *
 * Globex's amounts are deliberately absurd (999.999.999) so a leak is visible
 * in a peso figure at a glance, and Acme's are ordinary.
 */

describe('a report contains no row from another workspace', () => {
  it('expiries: Acme counts Acme, and its money is Acme money', async () => {
    const w = world();
    const doc = await buildReport('expiries', { db: w.db(ACME), today: TODAY, now: NOW });
    const html = renderReportHtml(doc);

    expect(html).toContain('SOAT WGY123');
    expect(html).not.toContain('SOAT ZZZ999');
    expect(html).not.toContain('999.999.999');
    expect(html).not.toContain('777.777.777');

    // The source ledger's row count is the honest statement of how many rows
    // were read; if it counts Globex's, everything downstream is wrong too.
    const commitments = doc.sources.find((s) => s.id === 'commitments');
    expect(commitments?.rowCount).toBe(3);

    const overdue = figuresOf(doc).find((f) => f.label === 'Vencidos');
    expect(overdue?.figure.raw).toBe(1); // c-acme-2 only, not c-globex-2
  });

  it('expiries: Globex sees its own, and never Acme’s', async () => {
    const w = world();
    const doc = await buildReport('expiries', { db: w.db(GLOBEX), today: TODAY, now: NOW });
    const html = renderReportHtml(doc);

    expect(html).toContain('SOAT ZZZ999');
    expect(html).not.toContain('SOAT WGY123');
    expect(html).not.toContain('Póliza almacén');
    expect(doc.sources.find((s) => s.id === 'commitments')?.rowCount).toBe(2);
  });

  it('fleet: one plate each, and no other company’s fines in the total', async () => {
    const w = world();
    const acme = await buildReport('fleet', { db: w.db(ACME), today: TODAY, now: NOW });
    const globex = await buildReport('fleet', { db: w.db(GLOBEX), today: TODAY, now: NOW });

    const acmeHtml = renderReportHtml(acme);
    expect(acmeHtml).toContain('WGY123');
    expect(acmeHtml).not.toContain('ZZZ999');

    const acmeFines = figuresOf(acme).find((f) => f.label === 'Multas pendientes');
    expect(acmeFines?.figure.raw).toBe(480_000);

    const globexFines = figuresOf(globex).find((f) => f.label === 'Multas pendientes');
    expect(globexFines?.figure.raw).toBe(999_000_000);

    expect(figuresOf(acme).find((f) => f.label === 'Placas activas')?.figure.raw).toBe(1);
    expect(figuresOf(globex).find((f) => f.label === 'Placas activas')?.figure.raw).toBe(1);
  });

  it('client_activity: the same counterparty name in both companies stays two separate reports', async () => {
    // The nastiest case in the fixture. "Servientrega" exists in both, so a
    // report that lost its filter would show one plausible client row with the
    // two companies' money added together — and nothing about it would look
    // wrong.
    const w = world();
    const acme = await buildReport('client_activity', { db: w.db(ACME), today: TODAY, now: NOW });
    const globex = await buildReport('client_activity', {
      db: w.db(GLOBEX),
      today: TODAY,
      now: NOW,
    });

    const acmeTotal = figuresOf(acme).find((f) => f.label === 'Comprometido');
    expect(acmeTotal?.figure.raw).toBe(1_200_000 + 8_000_000 + 3_000_000);

    const globexTotal = figuresOf(globex).find((f) => f.label === 'Comprometido');
    expect(globexTotal?.figure.raw).toBe(999_999_999 + 777_777_777);

    // Brain Knowledge is a second source in this report and leaks just as easily.
    expect(figuresOf(acme).find((f) => f.label === 'Documentos nuevos')?.figure.raw).toBe(1);
    expect(figuresOf(globex).find((f) => f.label === 'Documentos nuevos')?.figure.raw).toBe(2);

    expect(renderReportHtml(acme)).not.toContain('999.999.999');
  });

  it('the shared link would serve nothing from the other workspace either', async () => {
    // The rendered standalone page is what a link hands to somebody outside the
    // company. Asserting on the built document is not enough: the leak that
    // matters is the one that leaves the building.
    const w = world();
    const doc = await buildReport('expiries', { db: w.db(ACME), today: TODAY, now: NOW });
    const page = renderStandaloneHtml(doc);
    expect(page).not.toContain('ZZZ999');
    expect(page).not.toContain('999.999.999');
  });
});

describe('a saved report belongs to exactly one workspace', () => {
  it('is invisible to the other company, by id and in the list', async () => {
    const w = world();
    const acmeRow = await saveReport(w.ctx(ACME, ANA), {
      kind: 'expiries',
      document: await buildReport('expiries', { db: w.db(ACME), today: TODAY, now: NOW }),
      params: {},
    });
    await saveReport(w.ctx(GLOBEX, CARLA), {
      kind: 'expiries',
      document: await buildReport('expiries', { db: w.db(GLOBEX), today: TODAY, now: NOW }),
      params: {},
    });

    // Globex holds Acme's id — the exact shape of a leak somebody would find by
    // pasting a URL — and gets nothing.
    expect(await getReport(w.db(GLOBEX), acmeRow.id)).toBeNull();
    expect(await getReport(w.db(ACME), acmeRow.id)).not.toBeNull();

    const acmeList = await listReports(w.db(ACME));
    const globexList = await listReports(w.db(GLOBEX));
    expect(acmeList).toHaveLength(1);
    expect(globexList).toHaveLength(1);
    expect(globexList[0]?.id).not.toBe(acmeRow.id);
  });

  it('is stamped with the workspace that generated it, without anybody passing it', async () => {
    const w = world();
    const row = await saveReport(w.ctx(ACME, ANA), {
      kind: 'fleet',
      document: await buildReport('fleet', { db: w.db(ACME), today: TODAY, now: NOW }),
      params: {},
    });
    const stored = (w.tables.reports as Array<Record<string, unknown>>).find(
      (r) => r.id === row.id,
    );
    expect(stored?.organization_id).toBe(ACME);
  });
});
