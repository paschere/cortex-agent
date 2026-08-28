import type { ChartBody, Tone } from './document';
import { clip, count as fmtCount, shortDate } from './format';
import { escapeHtml, num } from './html';

/**
 * The charts, drawn as SVG on the server.
 *
 * ===========================================================================
 * WHY SERVER-SIDE SVG AND NOT A CHARTING LIBRARY
 * ===========================================================================
 * A chart in this product has to look the same in four places: on screen in the
 * app, inside the saved report reopened in November, in the page a shared link
 * serves to somebody outside the company, and in the file somebody archived. A
 * client-side library gives you one of those, and a promise about the other
 * three that depends on a CDN still being up, JavaScript being enabled, and the
 * library not having changed its defaults between versions.
 *
 * Markup that is already the picture has none of those dependencies. It is
 * text, so it goes in the same HTML document as everything else; it prints; it
 * survives being emailed; it renders in a mail client; and it is byte-identical
 * for the same input, which is what makes the snapshot test able to compare
 * strings instead of screenshots.
 *
 * The cost is real and accepted: no tooltips, no zoom, no pan. A report is a
 * document, not a dashboard — the numbers behind every chart are one keystroke
 * away in the table that the schema forces to accompany it.
 *
 * ===========================================================================
 * COLOUR
 * ===========================================================================
 * Tones are applied through CLASS NAMES, never through a colour baked into an
 * attribute. Two reasons: the stylesheet is then the single place the emerald/
 * amber/rose meanings are defined (design-system.md rule 4), and a presentation
 * attribute carrying `var(--x)` is a portability gamble across renderers while a
 * CSS rule is not.
 *
 * ===========================================================================
 * ACCESSIBILITY
 * ===========================================================================
 * Every chart is `role="img"` with a `<title>` and a `<desc>` taken from the
 * section's `altText`, and every chart section carries a real `<table>` beside
 * it (enforced in `document.ts`, not by convention). Nothing here animates: a
 * report that moves reads as a dashboard, and a dashboard is not a thing you
 * can put in a folder and defend two years later.
 */

const W = 720;

const DAY_MS = 86_400_000;

function dayNumber(iso: string): number {
  const t = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? 0 : Math.round(t / DAY_MS);
}

function fillClass(tone: Tone): string {
  return `rp-fill-${tone}`;
}
function strokeClass(tone: Tone): string {
  return `rp-stroke-${tone}`;
}

export interface ChartRenderOptions {
  /** Unique within the page. Ties `aria-labelledby` to the title and desc. */
  idPrefix: string;
  /** The sentence a screen reader hears instead of the picture. */
  altText: string;
}

/**
 * Wrap a body in the accessible `<svg>` shell.
 *
 * `width="100%"` plus a `viewBox` is the whole responsive story: the chart
 * scales with its column on a phone without a media query, a resize listener,
 * or a second rendering path.
 */
function svg(body: string, height: number, opts: ChartRenderOptions): string {
  const titleId = `${opts.idPrefix}-t`;
  const descId = `${opts.idPrefix}-d`;
  return [
    `<svg class="rp-chart" viewBox="0 0 ${W} ${height}" width="100%" height="${num(height)}"`,
    ` role="img" aria-labelledby="${escapeHtml(titleId)} ${escapeHtml(descId)}"`,
    ` preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">`,
    `<title id="${escapeHtml(titleId)}">${escapeHtml(opts.altText)}</title>`,
    `<desc id="${escapeHtml(descId)}">${escapeHtml(opts.altText)}</desc>`,
    body,
    '</svg>',
  ].join('');
}

function emptyState(message: string): string {
  return `<p class="rp-chart-empty">${escapeHtml(message)}</p>`;
}

// ---------------------------------------------------------------------------
// 1. Time series — "¿esto va subiendo o bajando?"
// ---------------------------------------------------------------------------

/**
 * A value per bucket, drawn as a line over a soft area.
 *
 * The y axis starts at zero and always will. Truncating it makes a 3 % move
 * look like a collapse, which is the single most common way an honest chart
 * tells a lie — and this report exists to be defensible.
 */
function timeSeries(
  chart: Extract<ChartBody, { type: 'timeseries' }>,
  opts: ChartRenderOptions,
): string {
  const pts = chart.points;
  if (pts.length === 0) return emptyState('Sin datos en el periodo.');

  const H = 230;
  const padL = 54;
  const padR = 16;
  const padT = 16;
  const padB = 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  const max = Math.max(1, ...pts.map((p) => p.value));
  // Round the ceiling up to something a person would choose, so the gridline
  // labels read as 0 / 5 / 10 rather than 0 / 3,67 / 7,33.
  const step = niceStep(max / 3);
  const ceiling = Math.max(step, Math.ceil(max / step) * step);

  const x = (i: number) =>
    pts.length === 1 ? padL + plotW / 2 : padL + (i * plotW) / (pts.length - 1);
  const y = (v: number) => padT + plotH - (v / ceiling) * plotH;

  const grid: string[] = [];
  for (let g = 0; g <= 3; g++) {
    const value = (ceiling / 3) * g;
    const gy = y(value);
    grid.push(
      `<line class="rp-grid" x1="${num(padL)}" y1="${num(gy)}" x2="${num(W - padR)}" y2="${num(gy)}" />`,
      `<text class="rp-axis rp-axis-y" x="${num(padL - 10)}" y="${num(gy + 4)}" text-anchor="end">${escapeHtml(fmtCount(value))}</text>`,
    );
  }

  const line = pts.map((p, i) => `${num(x(i))},${num(y(p.value))}`).join(' ');
  const area = `${num(padL)},${num(padT + plotH)} ${line} ${num(x(pts.length - 1))},${num(padT + plotH)}`;

  const marks = pts
    .map((p, i) => {
      const cx = x(i);
      const cy = y(p.value);
      return [
        `<circle class="rp-dot ${fillClass(chart.tone)}" cx="${num(cx)}" cy="${num(cy)}" r="3.5" />`,
        `<text class="rp-point-value" x="${num(cx)}" y="${num(cy - 10)}" text-anchor="middle">${escapeHtml(fmtCount(p.value))}</text>`,
      ].join('');
    })
    .join('');

  // On a narrow bucket count every label fits; past ~9 they collide, so every
  // other one is dropped rather than rotated — rotated axis labels are the
  // first thing that makes a report look like a spreadsheet export.
  const everyOther = pts.length > 9;
  const ticks = pts
    .map((p, i) =>
      everyOther && i % 2 === 1
        ? ''
        : `<text class="rp-axis" x="${num(x(i))}" y="${num(H - 12)}" text-anchor="middle">${escapeHtml(clip(p.label, 9))}</text>`,
    )
    .join('');

  return svg(
    [
      grid.join(''),
      `<polygon class="rp-area ${fillClass(chart.tone)}" points="${area}" />`,
      `<polyline class="rp-line ${strokeClass(chart.tone)}" points="${line}" />`,
      marks,
      ticks,
    ].join(''),
    H,
    opts,
  );
}

/** 1, 2, 5, 10, 20, 50 … — the intervals people actually put on an axis. */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return nice * magnitude;
}

// ---------------------------------------------------------------------------
// 2. Bars — "¿quién pesa más?"
// ---------------------------------------------------------------------------

/**
 * Horizontal, and that is a decision rather than a style.
 *
 * The comparison this business makes is between CLIENTS, and a Colombian
 * company name is thirty characters long ("Servientrega S.A.", "Almacenes
 * Éxito S.A."). Vertical bars force those labels to be rotated, truncated, or
 * both. Horizontal bars give the label a whole line at reading angle and let
 * the value sit at the end of its own bar where the eye already is.
 */
function bars(chart: Extract<ChartBody, { type: 'bars' }>, opts: ChartRenderOptions): string {
  if (chart.bars.length === 0) return emptyState('Sin datos para comparar.');

  const rowH = 30;
  const padT = 8;
  const padB = 8;
  const labelW = 190;
  const valueW = 120;
  const trackX = labelW + 12;
  const trackW = W - trackX - valueW;
  const H = padT + padB + chart.bars.length * rowH;

  const max = Math.max(1, ...chart.bars.map((b) => Math.abs(b.value)));

  const rows = chart.bars
    .map((b, i) => {
      const top = padT + i * rowH;
      const cy = top + rowH / 2;
      const w = Math.max(2, (Math.abs(b.value) / max) * trackW);
      return [
        `<text class="rp-bar-label" x="${num(labelW)}" y="${num(cy + 4)}" text-anchor="end">${escapeHtml(clip(b.label, 28))}</text>`,
        `<rect class="rp-bar-track" x="${num(trackX)}" y="${num(top + 7)}" width="${num(trackW)}" height="${num(rowH - 14)}" rx="4" />`,
        `<rect class="rp-bar ${fillClass(b.tone)}" x="${num(trackX)}" y="${num(top + 7)}" width="${num(w)}" height="${num(rowH - 14)}" rx="4" />`,
        `<text class="rp-bar-value" x="${num(W - 4)}" y="${num(cy + 4)}" text-anchor="end">${escapeHtml(b.display)}</text>`,
      ].join('');
    })
    .join('');

  return svg(rows, H, opts);
}

// ---------------------------------------------------------------------------
// 3. Composition — "¿de qué está hecho?"
// ---------------------------------------------------------------------------

/**
 * One stacked bar plus a legend that carries the numbers.
 *
 * Deliberately not a donut. Estimating an angle is something people are bad at,
 * so a donut is only readable when its labels are, at which point the ring is
 * decoration around a list. A stacked bar shows the proportions honestly, the
 * legend shows the values exactly, and both fit in a document column.
 *
 * The legend is HTML rather than SVG so long Spanish labels wrap instead of
 * overflowing the viewBox.
 */
function composition(
  chart: Extract<ChartBody, { type: 'composition' }>,
  opts: ChartRenderOptions,
): string {
  const slices = chart.slices.filter((s) => s.value > 0);
  if (slices.length === 0) return emptyState('Sin datos para descomponer.');

  const total = slices.reduce((sum, s) => sum + s.value, 0);
  const H = 44;
  const barH = 26;
  const y = (H - barH) / 2;

  let cursor = 0;
  const segments = slices
    .map((s) => {
      const w = (s.value / total) * W;
      const x = cursor;
      cursor += w;
      return `<rect class="rp-slice ${fillClass(s.tone)}" x="${num(x)}" y="${num(y)}" width="${num(Math.max(w - 2, 1))}" height="${num(barH)}" rx="4" />`;
    })
    .join('');

  const legend = slices
    .map(
      (s) =>
        `<li class="rp-legend-item"><span class="rp-swatch rp-bg-${escapeHtml(s.tone)}" aria-hidden="true"></span><span class="rp-legend-label">${escapeHtml(s.label)}</span><span class="rp-legend-value">${escapeHtml(s.display)}</span></li>`,
    )
    .join('');

  return `${svg(segments, H, opts)}<ul class="rp-legend">${legend}</ul>`;
}

// ---------------------------------------------------------------------------
// 4. Timeline — "¿qué se me viene encima?"
// ---------------------------------------------------------------------------

/**
 * The chart this company opens the report for.
 *
 * Every deadline placed on a real day axis, with today drawn as a rule through
 * the whole picture. What it buys over a table of dates is DISTANCE: three
 * deadlines bunched in the same week are a visible cluster rather than three
 * adjacent rows, and the gap between the rule and the nearest marker is how
 * much room you have, at a glance, without subtracting anything.
 *
 * Items are packed into lanes greedily, left to right, so nothing overlaps and
 * the vertical position carries no meaning of its own — a reader must never be
 * able to infer importance from height.
 */
function timeline(
  chart: Extract<ChartBody, { type: 'timeline' }>,
  opts: ChartRenderOptions,
): string {
  if (chart.items.length === 0) return emptyState('No hay vencimientos en la ventana.');

  const from = dayNumber(chart.from);
  const to = dayNumber(chart.to);
  const span = Math.max(1, to - from);
  const padL = 12;
  const padR = 12;
  const plotW = W - padL - padR;
  const axisPad = 44;

  const x = (iso: string) => {
    const d = dayNumber(iso);
    const clamped = Math.min(Math.max(d, from), to);
    return padL + ((clamped - from) / span) * plotW;
  };

  // Greedy lane packing. `reserve` is the width a label needs before the next
  // marker in the same lane may start; anything closer goes one lane up.
  const laneEnd: number[] = [];
  const placed = [...chart.items]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((item) => {
      const ix = x(item.date);
      const reserve = 24 + Math.min(item.label.length, 22) * 5.6;
      let lane = laneEnd.findIndex((end) => end <= ix);
      if (lane === -1) {
        lane = laneEnd.length;
        laneEnd.push(0);
      }
      laneEnd[lane] = ix + reserve;
      return { ...item, x: ix, lane };
    });

  const lanes = Math.max(1, laneEnd.length);
  const laneH = 24;
  const H = axisPad + lanes * laneH + 26;
  const axisY = H - 34;

  const marks = placed
    .map((p) => {
      const cy = axisY - 14 - (lanes - 1 - p.lane) * laneH;
      const title = p.detail ? `${p.label} · ${p.detail}` : p.label;
      return [
        `<line class="rp-stem ${strokeClass(p.tone)}" x1="${num(p.x)}" y1="${num(cy + 5)}" x2="${num(p.x)}" y2="${num(axisY)}" />`,
        `<circle class="rp-mark ${fillClass(p.tone)}" cx="${num(p.x)}" cy="${num(cy)}" r="4" />`,
        `<text class="rp-mark-label" x="${num(p.x + 8)}" y="${num(cy + 4)}"><title>${escapeHtml(title)}</title>${escapeHtml(clip(p.label, 22))}</text>`,
      ].join('');
    })
    .join('');

  // Month gridlines, so the distance has a unit rather than being relative.
  const ticks: string[] = [];
  const first = new Date(Date.parse(`${chart.from.slice(0, 7)}-01T00:00:00Z`));
  for (let i = 0; i < 24; i++) {
    const d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + i, 1));
    const iso = d.toISOString().slice(0, 10);
    if (dayNumber(iso) > to) break;
    if (dayNumber(iso) < from) continue;
    const tx = x(iso);
    ticks.push(
      `<line class="rp-grid" x1="${num(tx)}" y1="${num(axisPad - 24)}" x2="${num(tx)}" y2="${num(axisY)}" />`,
      `<text class="rp-axis" x="${num(tx)}" y="${num(axisY + 18)}" text-anchor="middle">${escapeHtml(shortDate(iso).slice(3))}</text>`,
    );
  }

  const todayX = x(chart.today);
  const todayRule = [
    `<line class="rp-today" x1="${num(todayX)}" y1="${num(8)}" x2="${num(todayX)}" y2="${num(axisY + 4)}" />`,
    `<text class="rp-today-label" x="${num(todayX + 6)}" y="${num(16)}">hoy</text>`,
  ].join('');

  return svg(
    [
      ticks.join(''),
      `<line class="rp-axis-line" x1="${num(padL)}" y1="${num(axisY)}" x2="${num(W - padR)}" y2="${num(axisY)}" />`,
      todayRule,
      marks,
    ].join(''),
    H,
    opts,
  );
}

// ---------------------------------------------------------------------------

/** Render any chart body. The only entry point; `render.ts` calls nothing else. */
export function renderChart(chart: ChartBody, opts: ChartRenderOptions): string {
  switch (chart.type) {
    case 'timeseries':
      return timeSeries(chart, opts);
    case 'bars':
      return bars(chart, opts);
    case 'composition':
      return composition(chart, opts);
    case 'timeline':
      return timeline(chart, opts);
  }
}
