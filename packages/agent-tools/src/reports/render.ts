import { renderChart } from './charts';
import type {
  Figure,
  ReportDocument,
  ReportSection,
  ReportTable,
  Tone,
} from './document';
import { REPORT_KIND_LABEL, sourceIndex, validateDocument } from './document';
import { longDate, stamp } from './format';
import { escapeHtml, join } from './html';

/**
 * Document → HTML. One renderer, three destinations, zero model involvement.
 *
 * ===========================================================================
 * WHY ONE RENDERER AND NOT A REACT COMPONENT PLUS A STRING RENDERER
 * ===========================================================================
 * The report has to appear in three places: inside the app, behind a shared
 * link that no session reaches, and inside a file somebody downloads. The
 * tempting shape is a React tree for the app and a string renderer for the
 * other two — and that shape guarantees they drift, because nothing fails when
 * they disagree. You find out months later, when a client says the report they
 * were sent does not match the one on screen.
 *
 * So there is exactly one renderer and it emits a string. The app screen mounts
 * that same string. That is a `dangerouslySetInnerHTML`, and it is safe for the
 * one reason that makes it ever safe: EVERY BYTE OF IT WAS PRODUCED HERE. No
 * model text, no database text and no user text reaches the output except
 * through `escapeHtml` in this file or in `charts.ts`. `__tests__/render.test.ts`
 * renders a document whose every string is an attack and asserts the result
 * contains no executable markup — so the claim is checked on every commit
 * rather than asserted in a comment.
 *
 * ===========================================================================
 * THE SIGNATURE: THE SOURCE LEDGER
 * ===========================================================================
 * Every figure is followed by a small superscript marker, and every marker
 * resolves to a numbered line at the foot of the report naming the system, the
 * exact slice that was read, the moment it was read and how many rows came
 * back. Footnotes are used here because the relationship is genuinely a
 * reference — not as decoration, and not as a sequence device.
 *
 * That is the difference between this and a dashboard. A dashboard shows you a
 * number. This shows you a number and where to go to disagree with it.
 *
 * ===========================================================================
 * STYLE
 * ===========================================================================
 * The stylesheet reads the app's own tokens through `var(--token, fallback)`,
 * so inside Cortex the report is drawn in exactly the product's ink, indigo and
 * status trio, and outside Cortex — a shared link, a downloaded file, a mail
 * client — the fallbacks carry the identical values. One appearance, no second
 * theme to maintain.
 */

/** Bumped when the CSS or the markup changes in a way worth recording. */
export const RENDERER_VERSION = 1;

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

/**
 * Scoped to `.rp-doc` in its entirety.
 *
 * Non-negotiable, because this same text is injected into an app page that has
 * its own stylesheet: a bare `table { … }` here would restyle every table in
 * Cortex the moment somebody opened a report. Every selector starts at the
 * document root class.
 */
export const REPORT_CSS = `
.rp-doc{
  --rp-ink: rgb(var(--ink, 24 26 39));
  --rp-ink-muted: rgb(var(--ink-muted, 99 104 128));
  --rp-ink-faint: rgb(var(--ink-faint, 142 147 170));
  --rp-surface: rgb(var(--surface, 255 255 255));
  --rp-surface-2: rgb(var(--surface-2, 244 245 250));
  --rp-border: rgb(var(--border, 231 233 241));
  --rp-primary: rgb(var(--primary, 88 80 236));
  --rp-primary-soft: rgb(var(--primary-soft, 240 239 254));
  --rp-primary-ink: rgb(var(--primary-ink, 62 53 199));
  --rp-emerald: rgb(var(--emerald, 13 148 111));
  --rp-amber: rgb(var(--amber, 190 128 20));
  --rp-rose: rgb(var(--rose, 219 63 76));
  --rp-sky: rgb(var(--sky, 14 133 200));
  --rp-radius: 14px;
  --rp-radius-sm: 10px;
  --rp-sans: var(--font-sans, "Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif);
  --rp-mono: var(--font-mono, "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace);
  font-family: var(--rp-sans);
  color: var(--rp-ink);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.rp-doc *{box-sizing:border-box}

/* --- Header: the masthead of a constancia, not the hero of a landing page.
   A single indigo hairline across the top, the title, and the three facts that
   make the document citable: what period, computed when, in which timezone. */
.rp-head{border-top:3px solid var(--rp-primary);padding-top:18px;margin-bottom:26px}
.rp-eyebrow{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--rp-primary-ink);margin:0 0 8px}
.rp-title{font-size:29px;line-height:1.15;font-weight:800;letter-spacing:-.022em;margin:0}
.rp-sub{margin:8px 0 0;font-size:14px;color:var(--rp-ink-muted);max-width:62ch}
.rp-stamp-row{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0 0;padding:0}
.rp-stamp{background:var(--rp-surface-2);border:1px solid var(--rp-border);border-radius:999px;padding:5px 12px;display:flex;align-items:baseline;gap:7px;margin:0}
.rp-stamp dt{font-size:10.5px;font-weight:600;letter-spacing:.04em;color:var(--rp-ink-faint);margin:0}
.rp-stamp dd{margin:0;font-family:var(--rp-mono);font-size:12px;font-variant-numeric:tabular-nums slashed-zero;color:var(--rp-ink)}

/* --- Sections ---------------------------------------------------------- */
.rp-section{margin:0 0 30px}
.rp-h{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--rp-ink-muted);margin:0 0 12px;display:flex;align-items:center;gap:12px}
.rp-h::after{content:"";flex:1;height:1px;background:linear-gradient(to right,var(--rp-border),transparent)}
.rp-p{margin:0 0 10px;font-size:14.5px;color:var(--rp-ink);max-width:70ch}
.rp-p:last-child{margin-bottom:0}

/* --- Metrics ----------------------------------------------------------- */
.rp-metrics{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--rp-border);border:1px solid var(--rp-border);border-radius:var(--rp-radius);overflow:hidden}
.rp-metric{background:var(--rp-surface);padding:14px 16px}
.rp-metric-label{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--rp-ink-faint);margin:0}
.rp-metric-value{font-family:var(--rp-mono);font-weight:600;font-size:25px;line-height:1.1;letter-spacing:-.03em;font-variant-numeric:tabular-nums slashed-zero;margin:6px 0 0;color:var(--rp-ink)}
.rp-metric-sub{font-size:11.5px;color:var(--rp-ink-faint);margin:5px 0 0}
.rp-t-emerald .rp-metric-value{color:var(--rp-emerald)}
.rp-t-amber .rp-metric-value{color:var(--rp-amber)}
.rp-t-rose .rp-metric-value{color:var(--rp-rose)}
.rp-t-primary .rp-metric-value{color:var(--rp-primary-ink)}
.rp-t-sky .rp-metric-value{color:var(--rp-sky)}

/* --- The citation marker: the signature device ------------------------- */
.rp-cite{font-family:var(--rp-mono);font-size:.62em;font-weight:600;text-decoration:none;color:var(--rp-primary-ink);background:var(--rp-primary-soft);border-radius:999px;padding:1px 5px;margin-left:4px;vertical-align:super;line-height:1;white-space:nowrap}
.rp-cite:hover{background:var(--rp-primary);color:#fff}
.rp-doc a:focus-visible{outline:2px solid var(--rp-primary);outline-offset:2px;border-radius:4px}

/* --- Charts ------------------------------------------------------------ */
.rp-figure-block{border:1px solid var(--rp-border);border-radius:var(--rp-radius);background:var(--rp-surface);padding:16px;overflow:hidden}
.rp-chart{display:block;max-width:100%;height:auto;overflow:visible}
.rp-chart-empty{margin:0;padding:22px;text-align:center;font-size:13px;color:var(--rp-ink-faint);background:var(--rp-surface-2);border-radius:var(--rp-radius-sm)}
.rp-caption{margin:12px 0 0;font-size:12.5px;color:var(--rp-ink-muted)}
.rp-alt{margin:4px 0 0;font-size:12.5px;color:var(--rp-ink-faint)}

.rp-grid{stroke:var(--rp-border);stroke-width:1}
.rp-axis-line{stroke:var(--rp-border);stroke-width:1.5}
.rp-axis{font-family:var(--rp-mono);font-size:10.5px;fill:var(--rp-ink-faint)}
.rp-line{fill:none;stroke-width:2.25;stroke-linejoin:round;stroke-linecap:round}
.rp-area{opacity:.10}
.rp-dot{stroke:var(--rp-surface);stroke-width:1.5}
.rp-point-value{font-family:var(--rp-mono);font-size:10.5px;fill:var(--rp-ink-muted)}
.rp-bar-track{fill:var(--rp-surface-2)}
.rp-bar-label{font-size:12px;fill:var(--rp-ink)}
.rp-bar-value{font-family:var(--rp-mono);font-size:12px;font-weight:600;fill:var(--rp-ink)}
.rp-today{stroke:var(--rp-primary);stroke-width:1.5;stroke-dasharray:3 3}
.rp-today-label{font-family:var(--rp-mono);font-size:10.5px;font-weight:600;fill:var(--rp-primary-ink)}
.rp-stem{stroke-width:1;opacity:.45}
.rp-mark{stroke:var(--rp-surface);stroke-width:1.5}
.rp-mark-label{font-size:11.5px;fill:var(--rp-ink)}

.rp-fill-emerald{fill:var(--rp-emerald)} .rp-stroke-emerald{stroke:var(--rp-emerald)}
.rp-fill-amber{fill:var(--rp-amber)} .rp-stroke-amber{stroke:var(--rp-amber)}
.rp-fill-rose{fill:var(--rp-rose)} .rp-stroke-rose{stroke:var(--rp-rose)}
.rp-fill-primary{fill:var(--rp-primary)} .rp-stroke-primary{stroke:var(--rp-primary)}
.rp-fill-sky{fill:var(--rp-sky)} .rp-stroke-sky{stroke:var(--rp-sky)}
.rp-fill-ink{fill:var(--rp-ink-faint)} .rp-stroke-ink{stroke:var(--rp-ink-faint)}

.rp-legend{list-style:none;margin:14px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:6px 18px}
.rp-legend-item{display:flex;align-items:baseline;gap:8px;font-size:12.5px}
.rp-legend-label{color:var(--rp-ink-muted);flex:1;min-width:0}
.rp-legend-value{font-family:var(--rp-mono);font-weight:600;font-variant-numeric:tabular-nums slashed-zero;color:var(--rp-ink)}
.rp-swatch{width:10px;height:10px;border-radius:3px;flex:none;transform:translateY(1px)}
.rp-bg-emerald{background:var(--rp-emerald)} .rp-bg-amber{background:var(--rp-amber)}
.rp-bg-rose{background:var(--rp-rose)} .rp-bg-primary{background:var(--rp-primary)}
.rp-bg-sky{background:var(--rp-sky)} .rp-bg-ink{background:var(--rp-ink-faint)}

/* --- Tables ------------------------------------------------------------ */
.rp-details{margin:14px 0 0}
.rp-summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--rp-primary-ink);list-style:none;display:inline-flex;align-items:center;gap:6px;padding:5px 11px;border-radius:999px;background:var(--rp-primary-soft)}
.rp-summary::-webkit-details-marker{display:none}
.rp-summary::before{content:"▸";font-size:10px}
.rp-details[open] .rp-summary::before{content:"▾"}
.rp-table-wrap{overflow-x:auto;margin:12px 0 0;border:1px solid var(--rp-border);border-radius:var(--rp-radius-sm)}
.rp-table{width:100%;border-collapse:collapse;font-size:13px}
.rp-table caption{text-align:left;padding:10px 14px;font-size:12px;color:var(--rp-ink-muted);border-bottom:1px solid var(--rp-border)}
.rp-table th{text-align:left;font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--rp-ink-faint);padding:9px 14px;background:var(--rp-surface-2);white-space:nowrap}
.rp-table td{padding:9px 14px;border-top:1px solid var(--rp-border);vertical-align:top}
.rp-table .rp-right{text-align:right}
.rp-table .rp-mono{font-family:var(--rp-mono);font-variant-numeric:tabular-nums slashed-zero;white-space:nowrap}
.rp-c-emerald{color:var(--rp-emerald);font-weight:600}
.rp-c-amber{color:var(--rp-amber);font-weight:600}
.rp-c-rose{color:var(--rp-rose);font-weight:600}
.rp-c-primary{color:var(--rp-primary-ink);font-weight:600}
.rp-c-sky{color:var(--rp-sky);font-weight:600}
.rp-c-ink{color:var(--rp-ink-muted)}
.rp-empty-row{color:var(--rp-ink-faint);font-style:italic}

/* --- Notes and the source ledger --------------------------------------- */
.rp-notes{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.rp-note{font-size:12.5px;color:var(--rp-ink-muted);background:var(--rp-surface-2);border-left:3px solid var(--rp-border);border-radius:0 var(--rp-radius-sm) var(--rp-radius-sm) 0;padding:9px 13px}
.rp-sources{border-top:1px solid var(--rp-border);margin-top:34px;padding-top:18px}
.rp-sources ol{margin:0;padding:0;list-style:none;display:grid;gap:10px;counter-reset:rp-src}
.rp-source{display:grid;grid-template-columns:22px 1fr;gap:10px;font-size:12.5px;scroll-margin-top:80px}
.rp-source-n{font-family:var(--rp-mono);font-size:11px;font-weight:600;color:var(--rp-primary-ink);background:var(--rp-primary-soft);border-radius:999px;height:20px;display:grid;place-items:center}
.rp-source-system{font-weight:600;color:var(--rp-ink)}
.rp-source-detail{color:var(--rp-ink-muted)}
.rp-source-meta{font-family:var(--rp-mono);font-size:11.5px;color:var(--rp-ink-faint);margin-top:2px}
.rp-source-caveat{color:var(--rp-amber);margin-top:3px}
.rp-source:target .rp-source-n{background:var(--rp-primary);color:#fff}

@media (max-width:640px){
  .rp-title{font-size:23px}
  .rp-metric-value{font-size:21px}
}

/* A report does not move. Nothing in here animates, so there is nothing for a
   reduced-motion rule to switch off — the setting is honoured by construction.
   The one transition is the citation hover, flattened here for completeness. */
@media (prefers-reduced-motion: reduce){
  .rp-doc *{animation:none !important;transition:none !important}
}

@media print{
  .rp-doc{color:#000}
  .rp-figure-block,.rp-table-wrap{break-inside:avoid}
  .rp-section{break-inside:avoid-page}
  .rp-doc{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`.trim();

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function toneClass(prefix: string, tone: Tone | null): string {
  return tone ? `${prefix}-${tone}` : '';
}

/**
 * A figure and its citation marker.
 *
 * The marker is a link into the source ledger and carries the method in its
 * `title` and its `aria-label`, so hovering it or reaching it with a screen
 * reader answers "how was this worked out" without leaving the number.
 */
function figure(doc: ReportDocument, fig: Figure, idPrefix: string): string {
  const n = sourceIndex(doc, fig.sourceId);
  const source = doc.sources[n - 1];
  const label = source
    ? `Fuente ${n}: ${source.system}. ${fig.method}`
    : `Sin fuente declarada. ${fig.method}`;
  const marker = n > 0
    ? `<a class="rp-cite" href="#${escapeHtml(idPrefix)}-src-${n}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${n}</a>`
    : '';
  return `${escapeHtml(fig.display)}${marker}`;
}

function renderTable(doc: ReportDocument, table: ReportTable, idPrefix: string): string {
  const head = table.columns
    .map(
      (c) =>
        `<th scope="col" class="${c.align === 'right' ? 'rp-right' : ''}">${escapeHtml(c.label)}</th>`,
    )
    .join('');

  const body =
    table.rows.length === 0
      ? `<tr><td class="rp-empty-row" colspan="${table.columns.length}">Sin filas en este corte.</td></tr>`
      : table.rows
          .map((row) => {
            const cells = table.columns
              .map((col, i) => {
                const cell = row[i];
                const classes = [
                  col.align === 'right' ? 'rp-right' : '',
                  col.mono ? 'rp-mono' : '',
                  toneClass('rp-c', cell?.tone ?? null),
                ]
                  .filter(Boolean)
                  .join(' ');
                return `<td${classes ? ` class="${classes}"` : ''}>${escapeHtml(cell?.display ?? '')}</td>`;
              })
              .join('');
            return `<tr>${cells}</tr>`;
          })
          .join('');

  const n = sourceIndex(doc, table.sourceId);
  const caption = table.caption
    ? `<caption>${escapeHtml(table.caption)}${n > 0 ? `<a class="rp-cite" href="#${escapeHtml(idPrefix)}-src-${n}" title="${escapeHtml(table.method)}" aria-label="${escapeHtml(`Fuente ${n}. ${table.method}`)}">${n}</a>` : ''}</caption>`
    : '';

  return `<div class="rp-table-wrap"><table class="rp-table">${caption}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function renderSection(
  doc: ReportDocument,
  section: ReportSection,
  index: number,
  idPrefix: string,
): string {
  switch (section.type) {
    case 'prose':
      return join([
        '<section class="rp-section">',
        section.heading ? `<h2 class="rp-h">${escapeHtml(section.heading)}</h2>` : '',
        section.paragraphs.map((p) => `<p class="rp-p">${escapeHtml(p)}</p>`).join(''),
        '</section>',
      ]);

    case 'metrics':
      return join([
        '<section class="rp-section">',
        section.heading ? `<h2 class="rp-h">${escapeHtml(section.heading)}</h2>` : '',
        '<div class="rp-metrics">',
        section.items
          .map((m) =>
            join([
              `<div class="rp-metric ${toneClass('rp-t', m.tone)}">`,
              `<p class="rp-metric-label">${escapeHtml(m.label)}</p>`,
              `<p class="rp-metric-value">${figure(doc, m.figure, idPrefix)}</p>`,
              m.sub ? `<p class="rp-metric-sub">${escapeHtml(m.sub)}</p>` : '',
              '</div>',
            ]),
          )
          .join(''),
        '</div>',
        '</section>',
      ]);

    case 'chart': {
      const chartId = `${idPrefix}-c${index}`;
      return join([
        '<section class="rp-section">',
        `<h2 class="rp-h">${escapeHtml(section.heading)}</h2>`,
        '<div class="rp-figure-block">',
        renderChart(section.chart, { idPrefix: chartId, altText: section.altText }),
        section.caption ? `<p class="rp-caption">${escapeHtml(section.caption)}</p>` : '',
        `<p class="rp-alt">${escapeHtml(section.altText)}</p>`,
        // The chart's twin. Closed by default because it repeats the picture,
        // but it is in the document, it is a real table, and it is one keystroke
        // away — which is what "the data can also be read as a table" has to
        // mean for it to be true for everybody.
        '<details class="rp-details">',
        `<summary class="rp-summary">Ver los datos como tabla (${section.table.rows.length})</summary>`,
        renderTable(doc, section.table, idPrefix),
        '</details>',
        '</div>',
        '</section>',
      ]);
    }

    case 'table':
      return join([
        '<section class="rp-section">',
        `<h2 class="rp-h">${escapeHtml(section.heading)}</h2>`,
        renderTable(doc, section.table, idPrefix),
        '</section>',
      ]);
  }
}

function renderSources(doc: ReportDocument, idPrefix: string): string {
  const items = doc.sources
    .map((s, i) =>
      join([
        `<li class="rp-source" id="${escapeHtml(idPrefix)}-src-${i + 1}">`,
        `<span class="rp-source-n" aria-hidden="true">${i + 1}</span>`,
        '<div>',
        `<span class="rp-source-system">${escapeHtml(s.system)}</span> — <span class="rp-source-detail">${escapeHtml(s.detail)}</span>`,
        `<div class="rp-source-meta">leído ${escapeHtml(stamp(s.readAt, doc.timezone))} · ${escapeHtml(String(s.rowCount))} ${s.rowCount === 1 ? 'fila' : 'filas'}</div>`,
        s.caveat ? `<div class="rp-source-caveat">${escapeHtml(s.caveat)}</div>` : '',
        '</div>',
        '</li>',
      ]),
    )
    .join('');

  return join([
    '<footer class="rp-sources">',
    '<h2 class="rp-h">De dónde salió cada cifra</h2>',
    `<ol>${items}</ol>`,
    '</footer>',
  ]);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface RenderOptions {
  /**
   * Namespaces the ids this document mints, so two reports on one page cannot
   * fight over `#src-1`. Reduced to `[a-z0-9-]` because it lands in a fragment
   * href and an id.
   */
  idPrefix?: string;
  /**
   * Drop the masthead — the eyebrow, the 29px title and the three stamps —
   * and render only the sections, the notes and the source ledger.
   *
   * WHAT THIS IS FOR, AND WHAT IT IS NOT. A chart drawn inside a chat message
   * already sits under a heading the conversation gave it, in a bubble a few
   * hundred pixels wide; a document masthead there is a second title competing
   * with the first and a type size that fights the transcript. So the chat asks
   * for the body only.
   *
   * It is NOT a "small" or "summary" mode. The source ledger stays — that is
   * the part that makes the figures citable, and a chart worth showing is worth
   * showing where its numbers came from. Nothing is omitted that a reader would
   * need in order to check a value. The full page (`/reports/:id`) renders the
   * same document without this flag and shows the masthead, which is the only
   * difference between the two.
   */
  compact?: boolean;
}

/**
 * The report itself: an `<article>`, styled by REPORT_CSS, safe to inject.
 *
 * Re-validates on the way out. A stored document is data, and data can be
 * older than the code, hand-edited, or restored from a backup — so the same
 * check that refused an unsourced figure on the way in refuses it on the way
 * out, and a report can never render a number with a citation that points
 * nowhere.
 */
export function renderReportHtml(doc: ReportDocument, opts: RenderOptions = {}): string {
  const validated = validateDocument(doc);
  const idPrefix = (opts.idPrefix ?? 'rp').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40) || 'rp';

  const notes =
    validated.notes.length > 0
      ? join([
          '<section class="rp-section">',
          '<h2 class="rp-h">Qué no incluye este informe</h2>',
          '<ul class="rp-notes">',
          validated.notes.map((n) => `<li class="rp-note">${escapeHtml(n)}</li>`).join(''),
          '</ul>',
          '</section>',
        ])
      : '';

  const head = opts.compact
    ? ''
    : join([
        '<header class="rp-head">',
        `<p class="rp-eyebrow">Informe · ${escapeHtml(REPORT_KIND_LABEL[validated.kind])}</p>`,
        `<h1 class="rp-title">${escapeHtml(validated.title)}</h1>`,
        validated.subtitle ? `<p class="rp-sub">${escapeHtml(validated.subtitle)}</p>` : '',
        '<dl class="rp-stamp-row">',
        `<div class="rp-stamp"><dt>Periodo</dt><dd>${escapeHtml(validated.periodLabel)}</dd></div>`,
        `<div class="rp-stamp"><dt>Calculado</dt><dd>${escapeHtml(stamp(validated.generatedAt, validated.timezone))}</dd></div>`,
        `<div class="rp-stamp"><dt>Zona horaria</dt><dd>${escapeHtml(validated.timezone)}</dd></div>`,
        '</dl>',
        '</header>',
      ]);

  return join([
    `<article class="rp-doc" lang="es-CO">`,
    head,
    validated.sections.map((s, i) => renderSection(validated, s, i, idPrefix)).join('\n'),
    notes,
    renderSources(validated, idPrefix),
    '</article>',
  ]);
}

export interface StandaloneOptions extends RenderOptions {
  /** Shown under the report; use it to say how this copy was obtained. */
  footerNote?: string;
}

/**
 * A whole HTML file: one document, no requests, no scripts.
 *
 * This is what a shared link serves and what an export downloads, and they are
 * the same bytes on purpose — "the page I sent you" and "the file I archived"
 * being different documents is exactly the confusion a report has to not
 * create. `<meta name="robots" content="noindex">` because a shared link is
 * unlisted, not public.
 */
export function renderStandaloneHtml(doc: ReportDocument, opts: StandaloneOptions = {}): string {
  const validated = validateDocument(doc);
  const body = renderReportHtml(validated, opts);
  const generated = stamp(validated.generatedAt, validated.timezone);
  const footer = opts.footerNote
    ? `<p class="rp-standalone-note">${escapeHtml(opts.footerNote)}</p>`
    : '';

  return [
    '<!doctype html>',
    '<html lang="es-CO">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex, nofollow">',
    `<meta name="generator" content="Cortex — informe generado ${escapeHtml(generated)}">`,
    `<title>${escapeHtml(validated.title)} · Cortex</title>`,
    `<style>${REPORT_CSS}
:root{color-scheme:light}
body{margin:0;background:#f9fafd;padding:34px 20px 60px}
.rp-page{max-width:840px;margin:0 auto;background:#fff;border:1px solid rgb(231 233 241);border-radius:16px;box-shadow:0 1px 2px rgb(24 26 39 / .04), 0 4px 12px -4px rgb(24 26 39 / .06);padding:34px}
.rp-standalone-note{max-width:840px;margin:16px auto 0;font-size:11.5px;color:rgb(142 147 170);text-align:center;font-family:var(--font-sans, ui-sans-serif, system-ui, sans-serif)}
@media (max-width:640px){body{padding:14px 10px 40px}.rp-page{padding:20px;border-radius:12px}}
@media print{body{background:#fff;padding:0}.rp-page{border:0;box-shadow:none;padding:0;max-width:none}}
</style>`,
    '</head>',
    '<body>',
    `<main class="rp-page">${body}</main>`,
    footer,
    '</body>',
    '</html>',
  ].join('\n');
}

/** One line naming the report, for a chat reply or a list row. */
export function describeDocument(doc: ReportDocument): string {
  return `${doc.title} — ${doc.periodLabel}, calculado el ${longDate(doc.generatedAt.slice(0, 10))}.`;
}
