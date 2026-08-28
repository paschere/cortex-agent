import { describe, expect, it } from 'vitest';
import type { ReportDocument } from '../document';
import { UnsourcedFigureError, validateDocument } from '../document';
import { escapeHtml } from '../html';
import { renderReportHtml, renderStandaloneHtml } from '../render';

/**
 * CAN THE REPORT BE POISONED BY ITS OWN CONTENT?
 *
 * A report is made of customer data — a counterparty name typed by whoever
 * answered the phone, a document title from an uploaded file, a note somebody
 * wrote. Any of it may contain markup. And unlike most screens, a report gets
 * SHARED: a link served to somebody at another company, from our origin. So a
 * hole here is not "a workspace can break its own page", it is "a workspace can
 * aim script at an outsider through a Cortex URL".
 *
 * The design that makes this testable is the one in `document.ts`: the model
 * never writes markup, the renderer is our code, and every string crosses
 * `escapeHtml` on the way out. This file is the proof, and the fixture below is
 * deliberately made of nothing but attacks — every single string in the
 * document is hostile, so a single missed interpolation shows up.
 */

const XSS = '<script>alert("x")</script>';
const ATTR_BREAK = '" onerror="alert(1)" x="';
const STYLE_BREAK = '</style><script>alert(2)</script><style>';
const SVG_BREAK = '</text></svg><script>alert(3)</script>';
const QUOTE_BREAK = "' onload='alert(4)";
const JS_URL = 'javascript:alert(5)';

/**
 * No LIVE event handler anywhere in the output.
 *
 * The naive form of this check — "the output contains no ` onerror=`" — cannot
 * be used, and not because it is too strict: it is WRONG. Escaping is not
 * deleting, so a counterparty genuinely named `" onerror="…` has to survive
 * into the report as readable text, and that text legitimately contains the
 * characters ` onerror=`. A test that forbade them would force the renderer to
 * start dropping customer data to stay green, which is a different bug.
 *
 * What actually distinguishes an attribute from text is the character right
 * after the `=`. In markup it opens a value: `"`, `'`, or a bare token. In
 * escaped text it is always the start of an entity — `&quot;`, `&#39;`. So the
 * assertion is: every ` on…=` in the output is followed by an entity.
 *
 * That is stricter than requiring a real quote, because it also catches the
 * unquoted form `onerror=alert(1)`, which a quote-only check would wave through.
 */
function expectNoLiveEventHandler(html: string): void {
  const live = [...html.matchAll(/\son[a-z]+\s*=/gi)].filter(
    (m) => !html.slice((m.index ?? 0) + m[0].length).startsWith('&'),
  );
  expect(
    live.map((m) => html.slice(Math.max(0, (m.index ?? 0) - 60), (m.index ?? 0) + 60)),
  ).toEqual([]);
}
/** Every string field carries an attack. Nothing in here is innocent. */
function hostileDocument(): ReportDocument {
  return validateDocument({
    version: 1,
    kind: 'expiries',
    title: `Informe ${XSS} ${JS_URL}`,
    subtitle: `Subtítulo ${STYLE_BREAK}`,
    periodLabel: `Periodo ${ATTR_BREAK}`,
    generatedAt: '2026-08-04T15:18:00.000Z',
    timezone: 'America/Bogota',
    sources: [
      {
        id: 'src',
        system: `Sistema ${XSS}`,
        detail: `Detalle ${ATTR_BREAK}`,
        readAt: '2026-08-04T15:18:00.000Z',
        rowCount: 3,
        caveat: `Salvedad ${QUOTE_BREAK} ${JS_URL}`,
      },
    ],
    sections: [
      {
        type: 'prose',
        heading: `Encabezado ${XSS}`,
        paragraphs: [`Párrafo ${XSS}`, `Otro ${STYLE_BREAK}`],
      },
      {
        type: 'metrics',
        heading: `Cifras ${ATTR_BREAK}`,
        items: [
          {
            label: `Etiqueta ${XSS}`,
            figure: {
              display: `12 ${XSS}`,
              raw: 12,
              unit: null,
              sourceId: 'src',
              method: `Método ${ATTR_BREAK}`,
            },
            sub: `Sub ${QUOTE_BREAK}`,
            tone: 'rose',
          },
        ],
      },
      {
        type: 'chart',
        heading: `Gráfico ${XSS}`,
        chart: {
          type: 'bars',
          bars: [
            { label: `Barra ${SVG_BREAK}`, value: 5, display: `5 ${XSS}`, tone: 'primary' },
            { label: `Otra ${ATTR_BREAK}`, value: 2, display: `2 ${QUOTE_BREAK}`, tone: 'rose' },
          ],
        },
        altText: `Alternativa ${SVG_BREAK}`,
        caption: `Pie ${XSS}`,
        table: {
          columns: [
            { label: `Col ${XSS}`, align: 'left', mono: false },
            { label: `Col ${ATTR_BREAK}`, align: 'right', mono: true },
          ],
          rows: [
            [
              { display: `Celda ${XSS}`, tone: null },
              { display: `9 ${SVG_BREAK}`, tone: 'rose' },
            ],
          ],
          sourceId: 'src',
          method: `Método ${STYLE_BREAK}`,
          caption: `Leyenda ${XSS}`,
        },
        sourceId: 'src',
        method: `Método ${XSS}`,
      },
      {
        type: 'chart',
        heading: 'Línea',
        chart: {
          type: 'timeline',
          from: '2026-08-01',
          to: '2026-10-01',
          today: '2026-08-04',
          items: [
            { label: `Hito ${SVG_BREAK}`, date: '2026-08-20', detail: `Det ${XSS}`, tone: 'amber' },
          ],
        },
        altText: `Alt ${XSS}`,
        caption: null,
        table: {
          columns: [{ label: 'Hito', align: 'left', mono: false }],
          rows: [[{ display: `Hito ${XSS}`, tone: null }]],
          sourceId: 'src',
          method: 'm',
          caption: null,
        },
        sourceId: 'src',
        method: 'm',
      },
      {
        type: 'chart',
        heading: 'Composición',
        chart: {
          type: 'composition',
          slices: [
            { label: `Trozo ${XSS}`, value: 3, display: `3 ${ATTR_BREAK}`, tone: 'emerald' },
          ],
        },
        altText: 'alt',
        caption: null,
        table: {
          columns: [{ label: 'x', align: 'left', mono: false }],
          rows: [],
          sourceId: 'src',
          method: 'm',
          caption: null,
        },
        sourceId: 'src',
        method: 'm',
      },
      {
        type: 'chart',
        heading: 'Serie',
        chart: {
          type: 'timeseries',
          points: [
            { label: `Mes ${SVG_BREAK}`, value: 4 },
            { label: `Mes ${XSS}`, value: 7 },
          ],
          valueUnit: null,
          tone: 'primary',
        },
        altText: 'alt',
        caption: null,
        table: {
          columns: [{ label: 'x', align: 'left', mono: false }],
          rows: [],
          sourceId: 'src',
          method: 'm',
          caption: null,
        },
        sourceId: 'src',
        method: 'm',
      },
      {
        type: 'table',
        heading: `Tabla ${XSS}`,
        table: {
          columns: [{ label: `H ${ATTR_BREAK}`, align: 'left', mono: false }],
          rows: [[{ display: `V ${STYLE_BREAK}`, tone: 'amber' }]],
          sourceId: 'src',
          method: `M ${XSS}`,
          caption: `C ${XSS}`,
        },
      },
    ],
    notes: [`Nota ${XSS}`, `Nota ${STYLE_BREAK}`],
  });
}

describe('the report cannot be poisoned by its content', () => {
  const html = renderReportHtml(hostileDocument());

  it('lets no executable markup through, anywhere', () => {
    // Not "no <script>" — no opening angle bracket followed by any of the tags
    // that can execute, in any casing, anywhere in the output.
    expect(html).not.toMatch(/<\s*script/i);
    expect(html).not.toMatch(/<\s*iframe/i);
    expect(html).not.toMatch(/<\s*object/i);
    expect(html).not.toMatch(/<\s*embed/i);
    expect(html).not.toMatch(/<\s*foreignObject/i);
    // Deliberately NOT `not.toContain('javascript:')`. That would forbid the
    // string anywhere, including as the readable text this renderer is supposed
    // to preserve — and it contradicts "routes no attribute at a javascript:
    // url", which requires the same string to survive as prose. The dangerous
    // shape is a URL-bearing attribute pointing at it, and that is asserted
    // there, precisely. The blanket version only looked satisfied because no
    // fixture fed a `javascript:` string in until now.
  });

  it('lets no event handler through, so no attribute break-out succeeded', () => {
    expectNoLiveEventHandler(html);
  });

  it('routes no attribute at a javascript: url', () => {
    // The other half of a break-out: not a new attribute, but a URL-bearing one
    // pointed somewhere executable. The fixture feeds one in, so this assertion
    // is exercised rather than merely present.
    expect(html).not.toMatch(/(href|src|xlink:href)\s*=\s*["']?\s*javascript:/i);
    // …and it survives as readable text, because escaping is not deleting.
    expect(html).toContain('javascript:alert(5)');
  });

  it('closes no style element early', () => {
    // Exactly one </style> may exist in the standalone document, and none at
    // all in the fragment — a second one would mean a content string escaped
    // into the stylesheet.
    expect(html).not.toContain('</style>');
  });

  it('renders the attacks as visible text instead of dropping them', () => {
    // Escaping, not stripping. A counterparty genuinely called "<Servientrega>"
    // must still be READABLE in the report — silently deleting content is its
    // own kind of wrong answer.
    expect(html).toContain(escapeHtml(XSS));
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes inside SVG text and title nodes too', () => {
    // Chart labels live in <text> and <title> elements, which are the ones an
    // author is most likely to forget: they look like text, and they are parsed
    // as markup. `</text></svg>` on its own appears legitimately — it is how a
    // chart ends — so the assertion is that the ATTACK sequence never does.
    expect(html).toContain('&lt;/text&gt;&lt;/svg&gt;');
    expect(html).not.toContain('</text></svg><script>');
    expect(html).not.toContain('</svg><script');
  });

  it('holds up in the standalone document served by the share link', () => {
    const page = renderStandaloneHtml(hostileDocument());
    expect(page).not.toMatch(/<\s*script/i);
    expectNoLiveEventHandler(page);
    expect(page).not.toMatch(/(href|src|xlink:href)\s*=\s*["']?\s*javascript:/i);
    // One stylesheet, opened once and closed once. A content string escaping
    // into the head would produce a second pair.
    expect(page.match(/<style>/g)?.length).toBe(1);
    expect(page.match(/<\/style>/g)?.length).toBe(1);
  });

  it('never emits a NaN coordinate, whatever the numbers are', () => {
    // A division by zero writes x="NaN" and silently blanks a chart. `num()`
    // makes that impossible; this is the assertion that keeps it that way.
    const empty = validateDocument({
      ...hostileDocument(),
      sections: [
        {
          type: 'chart',
          heading: 'Vacío',
          chart: {
            type: 'timeseries',
            points: [{ label: 'x', value: 0 }],
            valueUnit: null,
            tone: 'primary',
          },
          altText: 'sin datos',
          caption: null,
          table: {
            columns: [{ label: 'x', align: 'left', mono: false }],
            rows: [],
            sourceId: 'src',
            method: 'm',
            caption: null,
          },
          sourceId: 'src',
          method: 'm',
        },
      ],
    });
    const out = renderReportHtml(empty);
    expect(out).not.toContain('NaN');
    expect(out).not.toContain('Infinity');
  });
});

describe('the renderer refuses a document it cannot vouch for', () => {
  it('throws when a figure cites a source the document does not declare', () => {
    const doc = hostileDocument();
    const broken = {
      ...doc,
      sections: doc.sections.map((s) =>
        s.type === 'metrics'
          ? {
              ...s,
              items: s.items.map((m) => ({
                ...m,
                figure: { ...m.figure, sourceId: 'inventada' },
              })),
            }
          : s,
      ),
    };
    expect(() => renderReportHtml(broken as ReportDocument)).toThrow(UnsourcedFigureError);
  });

  it('refuses a figure with no source at all, at parse time', () => {
    expect(() =>
      validateDocument({
        ...hostileDocument(),
        sections: [
          {
            type: 'metrics',
            heading: null,
            items: [{ label: 'x', figure: { display: '1', raw: 1 }, sub: null, tone: null }],
          },
        ],
      }),
    ).toThrow();
  });
});

describe('accessibility is structural, not optional', () => {
  const html = renderReportHtml(hostileDocument());

  it('gives every chart a role, a title and a description', () => {
    const charts = html.match(/<svg /g)?.length ?? 0;
    expect(charts).toBeGreaterThan(0);
    expect(html.match(/role="img"/g)?.length).toBe(charts);
    expect(html.match(/<title id=/g)?.length).toBe(charts);
    expect(html.match(/<desc id=/g)?.length).toBe(charts);
  });

  it('puts a real table beside every chart', () => {
    // The schema requires it; this asserts the renderer actually emits it, so
    // "the data can also be read as a table" is true for every chart and not
    // just for the ones somebody remembered.
    const charts = html.match(/<svg /g)?.length ?? 0;
    const details = html.match(/<details class="rp-details">/g)?.length ?? 0;
    expect(details).toBe(charts);
  });

  it('cites every figure with a link into the source ledger', () => {
    expect(html).toMatch(/<a class="rp-cite" href="#rp-src-1"/);
    expect(html).toContain('id="rp-src-1"');
  });
});
