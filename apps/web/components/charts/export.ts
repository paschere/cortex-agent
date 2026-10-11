/**
 * Bajar un gráfico: CSV, SVG o PNG. Sólo navegador.
 *
 * El gráfico se pinta con variables del tema (`rgb(var(--ink))`) y clases de
 * Tailwind, que fuera de la página no existen. Antes de serializar se copia a
 * cada elemento el color y la letra ya calculados, y se pone el fondo de la
 * superficie: el archivo se ve igual que en pantalla, en claro o en oscuro.
 */

const PAINT = [
  'fill',
  'stroke',
  'stop-color',
  'opacity',
  'fill-opacity',
  'stroke-opacity',
] as const;

function inlineStyles(src: Element, dst: Element) {
  const cs = getComputedStyle(src);
  const el = dst as SVGElement;
  for (const prop of PAINT) {
    const v = cs.getPropertyValue(prop);
    if (v) el.style.setProperty(prop, v);
  }
  if (src.tagName.toLowerCase() === 'text') {
    el.style.setProperty('font-family', cs.fontFamily);
    el.style.setProperty('font-size', cs.fontSize);
    el.style.setProperty('font-weight', cs.fontWeight);
    el.style.setProperty('font-variant-numeric', cs.fontVariantNumeric);
  }
  for (let i = 0; i < src.children.length; i++) {
    const d = dst.children[i];
    if (d) inlineStyles(src.children[i] as Element, d);
  }
}

export interface SvgExport {
  markup: string;
  width: number;
  height: number;
}

/** El SVG del gráfico, autónomo, con título y fondo. */
export function serializeChartSvg(root: Element, title?: string): SvgExport | null {
  const svg = root.querySelector('svg[data-cx-chart]') as SVGSVGElement | null;
  if (!svg) return null;
  const width = Math.round(svg.getBoundingClientRect().width);
  const height = Math.round(svg.getBoundingClientRect().height);
  if (!width || !height) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  inlineStyles(svg, clone);
  const head = title ? 30 : 0;
  const out = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  out.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  out.setAttribute('width', String(width));
  out.setAttribute('height', String(height + head));
  out.setAttribute('viewBox', `0 0 ${width} ${height + head}`);
  const surface = getComputedStyle(root.ownerDocument.body).backgroundColor || '#ffffff';
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  bg.setAttribute('fill', surface);
  out.appendChild(bg);
  if (title) {
    const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    t.setAttribute('x', '12');
    t.setAttribute('y', '20');
    t.setAttribute('font-size', '14');
    t.setAttribute('font-weight', '600');
    t.setAttribute('font-family', getComputedStyle(svg).fontFamily || 'sans-serif');
    t.setAttribute('fill', getComputedStyle(root).color || '#111');
    t.textContent = title;
    out.appendChild(t);
  }
  clone.setAttribute('y', String(head));
  clone.removeAttribute('class');
  out.appendChild(clone);
  return { markup: new XMLSerializer().serializeToString(out), width, height: height + head };
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(text: string, filename: string, type = 'text/csv;charset=utf-8') {
  // El BOM hace que Excel lea bien las tildes.
  const bom = type.startsWith('text/csv') ? '﻿' : '';
  downloadBlob(new Blob([bom + text], { type }), filename);
}

export function downloadSvg(root: Element, filename: string, title?: string): boolean {
  const s = serializeChartSvg(root, title);
  if (!s) return false;
  downloadBlob(new Blob([s.markup], { type: 'image/svg+xml;charset=utf-8' }), filename);
  return true;
}

export async function downloadPng(
  root: Element,
  filename: string,
  title?: string,
): Promise<boolean> {
  const s = serializeChartSvg(root, title);
  if (!s) return false;
  const scale = 2;
  const url = URL.createObjectURL(new Blob([s.markup], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise<void>((ok, fail) => {
      img.onload = () => ok();
      img.onerror = () => fail(new Error('svg'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = s.width * scale;
    canvas.height = s.height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
    if (!blob) return false;
    downloadBlob(blob, filename);
    return true;
  } catch {
    return false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Un nombre de archivo seguro: «caja-30d-2026-10-10». */
export function fileSlug(...parts: string[]): string {
  return parts
    .join('-')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
