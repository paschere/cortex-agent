import { z } from 'zod';
import { roleKeySchema } from './permissions';

/**
 * GEOCERCAS: LUGARES CON RADIO (migración 0224). LA PARTE PURA.
 *
 * Un lugar («Bodega Norte», «Cliente Éxito Calle 80») es un punto, un radio y
 * qué hacer cuando alguien en turno entra o sale. Sin base ni reloj: el editor,
 * la herramienta del chat, el servidor (`geofence-run.ts`) y las pruebas hablan
 * este mismo idioma.
 *
 * HISTÉRESIS. Un GPS de teléfono salta decenas de metros, y una persona parada
 * en el borde del círculo cruzaría diez veces por minuto. Por eso:
 *   - ENTRAR exige estar dentro del radio;
 *   - SALIR exige pasar un radio mayor (`leaveRadius`: +25 % y al menos +25 m);
 *   - una posición muy imprecisa (peor que `MAX_FIX_ACCURACY_M` o que el propio
 *     radio) NO decide nada: ni entra ni sale.
 * Así, rebotar en el borde no genera avisos; hay que alejarse de verdad.
 */

export const GEOFENCE_MAX = 30;
export const MIN_RADIUS_M = 30;
export const MAX_RADIUS_M = 5000;
export const DEFAULT_RADIUS_M = 150;
/** Una posición peor que esto (metros) no sirve para decidir un cruce. */
export const MAX_FIX_ACCURACY_M = 150;

export const GEOFENCE_ID_RE = /^[a-z][a-z0-9_]{1,31}$/;

export const GEOFENCE_TRIGGERS = ['enter', 'leave', 'both'] as const;
export type GeofenceTrigger = (typeof GEOFENCE_TRIGGERS)[number];

export const geofenceSchema = z.object({
  id: z.string().trim().regex(GEOFENCE_ID_RE, 'Un identificador en minúsculas, sin espacios.'),
  name: z.string().trim().min(1).max(60),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
  radiusM: z.number().int().min(MIN_RADIUS_M).max(MAX_RADIUS_M).default(DEFAULT_RADIUS_M),
  /** Cuándo se avisa y se registra: al llegar, al salir o las dos. */
  on: z.enum(GEOFENCE_TRIGGERS).default('both'),
  /** A quién se le avisa: miembros de Cortex con estos roles de la app y/o admins. */
  notify: z
    .object({
      roles: z.array(roleKeySchema).max(8).default([]),
      admins: z.boolean().default(false),
    })
    .default({ roles: [], admins: false }),
  /** Texto del aviso; admite {{persona}} y {{lugar}}. Vacío = «Ana llegó a Bodega». */
  message: z.string().trim().min(1).max(200).optional(),
  /**
   * POLÍGONO (opcional): los vértices [lat, lng] del lugar (3 a 40). Con él, «dentro»
   * es estar dentro del polígono (o a menos de `marginM` de su borde) y `lat`/`lng`/
   * `radiusM` sólo describen el círculo que lo envuelve (centro y radio para pintarlo).
   * Para terminales, plataformas y bodegas que un círculo no sigue.
   */
  polygon: z
    .array(z.tuple([z.number().finite().min(-90).max(90), z.number().finite().min(-180).max(180)]))
    .min(3)
    .max(40)
    .optional(),
  /** Holgura (m) alrededor del borde del polígono, por el GPS que salta; por omisión 25. */
  marginM: z.number().int().min(0).max(500).optional(),
});
export type Geofence = z.infer<typeof geofenceSchema>;
export type GeofenceInput = z.input<typeof geofenceSchema>;

/** «Bodega Norte» → «bodega_norte» (único frente a `taken`). */
export function geofenceIdFor(name: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  const base =
    name
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 26) || 'lugar';
  let id = /^[a-z]/.test(base) ? base : `l_${base}`;
  for (let n = 2; used.has(id) || !GEOFENCE_ID_RE.test(id); n++)
    id = `${id.replace(/_\d+$/, '').slice(0, 26)}_${n}`;
  return id;
}

/** Los problemas de una lista de lugares (ids repetidos). Vacío = bien. */
export function geofenceProblems(list: Geofence[]): string[] {
  const seen = new Set<string>();
  const problems: string[] = [];
  for (const g of list) {
    if (seen.has(g.id)) problems.push(`El lugar «${g.id}» está repetido.`);
    seen.add(g.id);
  }
  return problems;
}

const EARTH_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Distancia en metros entre dos puntos (haversine). */
export function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const DEFAULT_POLYGON_MARGIN_M = 25;

type Pt = { lat: number; lng: number };

/** ¿El punto cae dentro del polígono? (rayos; vértices [lat, lng]). */
export function pointInPolygon(p: Pt, polygon: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i] as readonly [number, number];
    const [yj, xj] = polygon[j] as readonly [number, number];
    if (yi > p.lat !== yj > p.lat && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/** Distancia (m) del punto al borde del polígono (plano local; sirve a escala de un aeropuerto). */
export function distanceToPolygonEdgeM(
  p: Pt,
  polygon: ReadonlyArray<readonly [number, number]>,
): number {
  const k = 111_320;
  const c = Math.cos(rad(p.lat));
  const px = p.lng * k * c;
  const py = p.lat * k;
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i] as readonly [number, number];
    const b = polygon[(i + 1) % polygon.length] as readonly [number, number];
    const ax = a[1] * k * c;
    const ay = a[0] * k;
    const bx = b[1] * k * c;
    const by = b[0] * k;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

/** Distancia con signo al borde: negativa si está dentro del polígono. */
function polygonOffsetM(place: Pick<Geofence, 'polygon'>, fix: Pt): number {
  const poly = place.polygon as ReadonlyArray<readonly [number, number]>;
  const edge = distanceToPolygonEdgeM(fix, poly);
  return pointInPolygon(fix, poly) ? -edge : edge;
}

/**
 * ¿La posición está en el lugar? Círculo: dentro del radio. Polígono: dentro, o a
 * menos de `marginM` del borde. `leaving` usa la holgura de salida (histéresis).
 */
export function insidePlace(
  place: Pick<Geofence, 'lat' | 'lng' | 'radiusM'> & Partial<Pick<Geofence, 'polygon' | 'marginM'>>,
  fix: Pt,
  leaving = false,
): boolean {
  if (place.polygon?.length) {
    const margin = place.marginM ?? DEFAULT_POLYGON_MARGIN_M;
    return polygonOffsetM(place, fix) <= (leaving ? Math.max(margin * 1.25, margin + 25) : margin);
  }
  return distanceM(place, fix) <= (leaving ? leaveRadiusM(place.radiusM) : place.radiusM);
}

/** El radio que hay que pasar para SALIR (mayor que el de entrar: histéresis). */
export function leaveRadiusM(radiusM: number): number {
  return Math.round(Math.max(radiusM * 1.25, radiusM + 25));
}

export type Transition = 'enter' | 'leave';

export interface FixLike {
  lat: number;
  lng: number;
  accuracyM?: number | null;
}

/**
 * El siguiente estado respecto de UN lugar. `wasInside` null = nunca se había
 * visto: la primera posición ya dentro cuenta como «llegó» (la persona
 * acaba de iniciar turno ahí); la primera posición afuera no es un cruce.
 */
export function stepPlace(
  place: Pick<Geofence, 'lat' | 'lng' | 'radiusM'> & Partial<Pick<Geofence, 'polygon' | 'marginM'>>,
  wasInside: boolean | null,
  fix: FixLike,
): { inside: boolean; transition: Transition | null; distanceM: number } {
  const d = distanceM(place, fix);
  const known = wasInside ?? false;
  const acc = fix.accuracyM ?? 0;
  // Una posición borrosa no decide nada: se queda como estaba.
  if (acc > Math.max(MAX_FIX_ACCURACY_M, place.radiusM) && wasInside !== null)
    return { inside: known, transition: null, distanceM: d };
  if (!known) {
    if (insidePlace(place, fix) && acc <= Math.max(MAX_FIX_ACCURACY_M, place.radiusM))
      return { inside: true, transition: 'enter', distanceM: d };
    return { inside: false, transition: null, distanceM: d };
  }
  if (!insidePlace(place, fix, true)) return { inside: false, transition: 'leave', distanceM: d };
  return { inside: true, transition: null, distanceM: d };
}

export interface GeofenceHit {
  place: Geofence;
  transition: Transition;
}

/**
 * Todos los lugares frente a una posición. `states`: id del lugar → estaba
 * adentro (lo que falta se toma como «nunca visto»). Devuelve los estados nuevos
 * de TODOS los lugares (para guardarlos) y los cruces, ya filtrados por lo que
 * cada lugar quiere registrar (`on`) en `hits`; `crossings` trae todos.
 */
export function evaluateGeofences(
  places: readonly Geofence[],
  states: ReadonlyMap<string, boolean>,
  fix: FixLike,
): {
  next: Map<string, boolean>;
  crossings: GeofenceHit[];
  hits: GeofenceHit[];
} {
  const next = new Map<string, boolean>();
  const crossings: GeofenceHit[] = [];
  for (const place of places) {
    const prev = states.has(place.id) ? (states.get(place.id) as boolean) : null;
    const step = stepPlace(place, prev, fix);
    next.set(place.id, step.inside);
    if (step.transition) crossings.push({ place, transition: step.transition });
  }
  return {
    next,
    crossings,
    hits: crossings.filter((c) => c.place.on === 'both' || c.place.on === c.transition),
  };
}

/** El texto del aviso: el del lugar con {{persona}} y {{lugar}}, o el de siempre. */
export function geofenceMessage(
  place: Pick<Geofence, 'name' | 'message'>,
  transition: Transition,
  person: string,
): string {
  const fallback =
    transition === 'enter' ? `${person} llegó a ${place.name}` : `${person} salió de ${place.name}`;
  if (!place.message) return fallback;
  return (
    place.message
      .replace(/\{\{\s*persona\s*\}\}/gi, person)
      .replace(/\{\{\s*lugar\s*\}\}/gi, place.name)
      .trim() || fallback
  );
}

export interface ZoneVerdict {
  /** El lugar donde está (el más adentro si cae en varios); null = fuera de todos. */
  place: Geofence | null;
  inside: Geofence[];
  /** Con una posición demasiado borrosa y fuera de todo no se decide. */
  uncertain: boolean;
}

/**
 * ¿En qué lugar está esta posición? Sin histéresis (es una foto, no un cruce): sirve
 * para marcar un registro con la zona de quien lo hizo. `restrictTo` limita a esos ids.
 */
export function zoneOf(
  places: readonly Geofence[],
  fix: FixLike,
  restrictTo?: readonly string[],
): ZoneVerdict {
  const pool = restrictTo?.length ? places.filter((p) => restrictTo.includes(p.id)) : places;
  const acc = fix.accuracyM ?? 0;
  const inside = pool.filter((p) => insidePlace(p, fix));
  if (!inside.length && acc > MAX_FIX_ACCURACY_M) return { place: null, inside: [], uncertain: true };
  const depth = (g: Geofence) =>
    g.polygon?.length ? polygonOffsetM(g, fix) : distanceM(g, fix) - g.radiusM;
  const best = [...inside].sort((a, b) => depth(a) - depth(b))[0];
  return { place: best ?? null, inside, uncertain: false };
}
