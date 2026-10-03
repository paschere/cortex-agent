/**
 * EL PLANEADOR DE RUTAS: la distancia de una lista de paradas en orden.
 *
 * Sólo si la empresa configuró un proveedor (`GOOGLE_MAPS_API_KEY`, la API de
 * Directions de Google). Sin él, los km se escriben a mano — y se dice así:
 * nunca se inventa una distancia «aproximada» que nadie midió.
 *
 * NUNCA LANZA. Un proveedor caído, una dirección que no encuentra o una llave
 * vencida son condiciones normales: se devuelve `{ ok: false, reason }` y la
 * pantalla o la herramienta piden los km a mano.
 */

export type RouteEstimate =
  | { ok: true; km: number; minutes: number | null; provider: 'google' }
  | { ok: false; configured: boolean; reason: string };

export function routeProviderConfigured(): boolean {
  return !!process.env.GOOGLE_MAPS_API_KEY;
}

const TIMEOUT_MS = 12_000;

export async function estimateRouteKm(
  stops: readonly string[],
  signal?: AbortSignal,
): Promise<RouteEstimate> {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key)
    return {
      ok: false,
      configured: false,
      reason: 'No hay un proveedor de rutas configurado: escribe los km a mano.',
    };
  const places = stops.map((s) => s.trim()).filter(Boolean);
  if (places.length < 2)
    return { ok: false, configured: true, reason: 'Hacen falta al menos un origen y un destino.' };
  const [origin, ...rest] = places;
  const destination = rest.pop() as string;
  const params = new URLSearchParams({
    origin: origin as string,
    destination,
    region: 'co',
    language: 'es',
    key,
  });
  if (rest.length) params.set('waypoints', rest.slice(0, 23).join('|'));
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined =
    signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`, {
      signal: combined,
    });
    if (!res.ok)
      return {
        ok: false,
        configured: true,
        reason: `El proveedor de rutas no respondió (${res.status}).`,
      };
    const body = (await res.json()) as {
      status?: string;
      routes?: Array<{
        legs?: Array<{ distance?: { value?: number }; duration?: { value?: number } }>;
      }>;
    };
    const legs = body.routes?.[0]?.legs ?? [];
    if (body.status !== 'OK' || !legs.length)
      return {
        ok: false,
        configured: true,
        reason:
          body.status === 'NOT_FOUND' || body.status === 'ZERO_RESULTS'
            ? 'El proveedor no encontró una ruta entre esas paradas: revisa las direcciones o escribe los km.'
            : 'El proveedor de rutas no dio una distancia: escribe los km a mano.',
      };
    const meters = legs.reduce((s, l) => s + (l.distance?.value ?? 0), 0);
    const seconds = legs.reduce((s, l) => s + (l.duration?.value ?? 0), 0);
    return {
      ok: true,
      km: Math.round(meters / 100) / 10,
      minutes: seconds ? Math.round(seconds / 60) : null,
      provider: 'google',
    };
  } catch {
    return {
      ok: false,
      configured: true,
      reason: 'No pude consultar el proveedor de rutas ahora: escribe los km a mano.',
    };
  }
}
