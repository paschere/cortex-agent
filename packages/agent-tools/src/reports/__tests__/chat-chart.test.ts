import { describe, expect, it } from 'vitest';
import { getTool } from '../../registry';
import { chatChartDocument, renderChatChartHtml } from '../chat-chart';
import { GENERATED_REPORT_KINDS, REPORT_KINDS, validateDocument } from '../document';

/**
 * THE PROMISES A CHART DRAWN FROM A CONVERSATION MAKES.
 *
 * `reports.chart` is the one place in this module where the FIGURES arrive in
 * the tool call rather than out of a query, so the guarantees it can offer are
 * narrower than `reports.generate`'s and it matters that they are exactly the
 * ones the header claims. Each test below pins one of them.
 */

const XSS = '<script>alert("x")</script>';
const SVG_BREAK = '</text></svg><script>alert(1)</script>';
const ATTR_BREAK = '" onerror="alert(2)" x="';

function input(overrides: Record<string, unknown> = {}) {
  return {
    heading: 'Vencimientos por mes',
    altText: 'Sube de 4 en julio a 19 en octubre.',
    caption: null,
    periodLabel: 'próximos 4 meses',
    source: {
      system: 'Cortex · commitments',
      detail: 'Compromisos confirmados con vencimiento entre agosto y noviembre de 2026.',
      caveat: null,
    },
    method: 'conteo de compromisos confirmados agrupados por mes de vencimiento',
    chart: {
      type: 'timeseries' as const,
      points: [
        { label: 'jul', value: 4 },
        { label: 'ago', value: 11 },
        { label: 'sep', value: 19 },
      ],
    },
    table: {
      columns: [{ label: 'Mes' }, { label: 'Vencen', align: 'right' as const, mono: true }],
      rows: [
        [{ display: 'jul' }, { display: '4' }],
        [{ display: 'ago' }, { display: '11' }],
        [{ display: 'sep' }, { display: '19' }],
      ],
    },
    notes: [],
    ...overrides,
  };
}

describe('a chart drawn in the chat', () => {
  it('is registered, so the agent can actually reach it', () => {
    expect(getTool('reports.chart')).toBeDefined();
  });

  it('stamps the moment itself instead of letting the caller claim one', () => {
    const at = new Date('2026-08-12T15:04:05.000Z');
    const doc = chatChartDocument(input(), at);
    expect(doc.sources[0]?.readAt).toBe(at.toISOString());
    expect(doc.generatedAt).toBe(at.toISOString());
  });

  /**
   * The count is DERIVED from the twin table rather than asserted separately,
   * so a chart cannot claim it summarised more rows than it is willing to show.
   */
  it('derives the row count from the table it shows', () => {
    expect(chatChartDocument(input()).sources[0]?.rowCount).toBe(3);
    const bigger = input({
      table: {
        columns: [{ label: 'Mes' }],
        rows: [[{ display: 'a' }], [{ display: 'b' }]],
      },
    });
    expect(chatChartDocument(bigger).sources[0]?.rowCount).toBe(2);
  });

  /**
   * Every figure resolving to a declared source is the guarantee the whole
   * module rests on, and `validateDocument` is what enforces it. A chat chart
   * goes through the identical check — it is not a relaxed path.
   */
  it('produces a document whose citations all resolve', () => {
    const doc = chatChartDocument(input());
    expect(() => validateDocument(doc)).not.toThrow();

    const section = doc.sections[0];
    expect(section?.type).toBe('chart');
    if (section?.type === 'chart') {
      expect(section.sourceId).toBe(doc.sources[0]?.id);
      // The twin table cites the same source as the picture, so the numbers in
      // the table and the numbers in the chart can never be attributed apart.
      expect(section.table.sourceId).toBe(section.sourceId);
      expect(section.table.method).toBe(section.method);
    }
  });

  it('refuses to build a chart with no table, because that is the accessible copy', () => {
    // `chartSectionSchema` requires it; this proves the requirement survives
    // the path a chat chart takes rather than only the one a report takes.
    expect(() =>
      chatChartDocument(input({ table: { columns: [], rows: [] } })),
    ).toThrow();
  });

  /**
   * Same posture as `render.test.ts`: the content is hostile and none of it may
   * survive as markup. The difference that matters here is that a chat chart's
   * strings came from a MODEL, so this is the boundary between "the model chose
   * the shape" and "the model wrote the page".
   */
  it('escapes hostile content instead of rendering it', () => {
    const doc = chatChartDocument(
      input({
        heading: XSS,
        altText: SVG_BREAK,
        caption: ATTR_BREAK,
        method: XSS,
        source: { system: XSS, detail: SVG_BREAK, caveat: ATTR_BREAK },
        table: {
          columns: [{ label: XSS }, { label: ATTR_BREAK }],
          rows: [[{ display: SVG_BREAK }, { display: XSS }]],
        },
        notes: [XSS],
      }),
    );

    const html = renderChatChartHtml(doc, 'abc-123');

    // No tag may open. `<` is escaped everywhere content lands, so neither the
    // script nor the `</svg>` break can close the chart and start markup.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('</svg><script');
    expect(html).toContain('&lt;script&gt;');

    // The attribute break is the subtler one, and the assertion has to be
    // precise about what is dangerous. The literal text `onerror=` is harmless
    // sitting in a text node — what would be a hole is an unescaped quote
    // letting it BECOME an attribute. So the check is for the quote, not the
    // word: every `"` in content is `&quot;`, so `onerror="` cannot occur.
    expect(html).not.toContain('onerror="');
    expect(html).toContain('&quot; onerror=&quot;');
  });

  it('renders without the document masthead but keeps the source ledger', () => {
    const html = renderChatChartHtml(chatChartDocument(input()), 'abc-123');
    // No 29px title competing with the heading the conversation already gave it…
    expect(html).not.toContain('rp-head');
    expect(html).not.toContain('rp-title');
    // …but the part that makes the figures checkable stays.
    expect(html).toContain('rp-sources');
    expect(html).toContain('Cortex · commitments');
    expect(html).toContain('rp-table');
  });
});

describe('the two lists of report kinds', () => {
  /**
   * `chart` is storable and not buildable, and keeping the lists apart is what
   * stops a "Generar" button appearing for something that has no parameters to
   * re-run. The compiler enforces it at the call sites; this states it in one
   * place so the intent survives a refactor.
   */
  it('keeps the chat chart out of what the builder accepts', () => {
    expect(REPORT_KINDS).toContain('chart');
    expect(GENERATED_REPORT_KINDS as readonly string[]).not.toContain('chart');
    for (const kind of GENERATED_REPORT_KINDS) {
      expect(REPORT_KINDS as readonly string[]).toContain(kind);
    }
  });
});
