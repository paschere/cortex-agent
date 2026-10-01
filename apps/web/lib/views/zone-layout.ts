/**
 * LAS REGLAS DE DIBUJAR UN PLANO A MANO.
 *
 * El plano de una vista (bloque `zones`) es una rejilla de 12 columnas y hasta
 * 12 filas; cada zona es un rectángulo {x, y, w, h} en celdas enteras. Estas
 * funciones son lo único que decide dónde puede quedar una zona: no se sale
 * de la rejilla, no mide menos de una celda, y una zona nueva cae en el primer
 * hueco libre. Puras, sin React, para probarlas sin pantalla
 * (zone-layout.test.ts) y para que el arrastre con ratón, con el dedo y con el
 * teclado den exactamente el mismo resultado.
 *
 * Los topes son los del contrato del servidor (packages/agent-tools/src/views/
 * spec.ts, `zoneLayoutSchema`): x, y en 0–11; w en 1–12; h en 1–6.
 */

export const GRID_COLS = 12;
export const GRID_ROWS = 12;
export const MAX_H = 6;

export interface ZoneRect {
  zone: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const clampInt = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(v)));

/** Lleva un rectángulo a la rejilla: enteros, dentro de los bordes, tamaños válidos. */
export function clampRect(r: ZoneRect): ZoneRect {
  const w = clampInt(r.w, 1, GRID_COLS);
  const h = clampInt(r.h, 1, MAX_H);
  return {
    zone: r.zone,
    w,
    h,
    x: clampInt(r.x, 0, GRID_COLS - w),
    y: clampInt(r.y, 0, GRID_ROWS - h),
  };
}

export function overlaps(a: ZoneRect, b: ZoneRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Las zonas que se pisan con otra: se dibujan en rojo, no se impiden. */
export function overlapping(layout: readonly ZoneRect[]): Set<string> {
  const out = new Set<string>();
  layout.forEach((a, i) => {
    for (const b of layout.slice(i + 1))
      if (overlaps(a, b)) {
        out.add(a.zone);
        out.add(b.zone);
      }
  });
  return out;
}

/** Mueve una zona a (x, y), sin salirse. */
export function moveZone(
  layout: readonly ZoneRect[],
  zone: string,
  x: number,
  y: number,
): ZoneRect[] {
  return layout.map((r) => (r.zone === zone ? clampRect({ ...r, x, y }) : r));
}

/** Cambia el tamaño de una zona desde su esquina inferior derecha. */
export function resizeZone(
  layout: readonly ZoneRect[],
  zone: string,
  w: number,
  h: number,
): ZoneRect[] {
  return layout.map((r) => {
    if (r.zone !== zone) return r;
    return clampRect({ ...r, w: Math.min(w, GRID_COLS - r.x), h: Math.min(h, GRID_ROWS - r.y) });
  });
}

/** El primer hueco libre de w×h, leyendo de arriba abajo y de izquierda a derecha. */
export function freeSpot(layout: readonly ZoneRect[], w = 4, h = 2): { x: number; y: number } {
  for (let y = 0; y <= GRID_ROWS - h; y++)
    for (let x = 0; x <= GRID_COLS - w; x++) {
      const probe = { zone: '', x, y, w, h };
      if (!layout.some((r) => overlaps(r, probe))) return { x, y };
    }
  return { x: 0, y: 0 };
}

/** Ubica una zona que todavía no estaba en el plano. */
export function placeZone(layout: readonly ZoneRect[], zone: string): ZoneRect[] {
  if (layout.some((r) => r.zone === zone)) return [...layout];
  const spot = freeSpot(layout);
  return [...layout, clampRect({ zone, x: spot.x, y: spot.y, w: 4, h: 2 })];
}

export function removeZone(layout: readonly ZoneRect[], zone: string): ZoneRect[] {
  return layout.filter((r) => r.zone !== zone);
}

/** Cuántas filas mostrar al dibujar: lo ocupado más dos de aire, mínimo seis. */
export function visibleRows(layout: readonly ZoneRect[]): number {
  const used = layout.reduce((max, r) => Math.max(max, r.y + r.h), 0);
  return Math.min(GRID_ROWS, Math.max(6, used + 2));
}

/** Del spec (lo que haya) a rectángulos válidos; descarta zonas que ya no son opciones. */
export function normalizeLayout(raw: unknown, zones: readonly string[]): ZoneRect[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ZoneRect[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Partial<ZoneRect>;
    if (typeof r.zone !== 'string' || !zones.includes(r.zone) || seen.has(r.zone)) continue;
    seen.add(r.zone);
    out.push(
      clampRect({
        zone: r.zone,
        x: Number(r.x) || 0,
        y: Number(r.y) || 0,
        w: Number(r.w) || 4,
        h: Number(r.h) || 2,
      }),
    );
  }
  return out;
}
