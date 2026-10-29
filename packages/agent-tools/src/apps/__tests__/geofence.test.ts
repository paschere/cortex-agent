import { describe, expect, it } from 'vitest';
import {
  type Geofence,
  distanceM,
  evaluateGeofences,
  geofenceIdFor,
  geofenceMessage,
  geofenceProblems,
  geofenceSchema,
  leaveRadiusM,
  pointInPolygon,
  stepPlace,
  zoneOf,
} from '../geofence';
import { parseLocationSettings } from '../location-shape';

// ~111 m por 0.001° de latitud.
const BODEGA = { lat: 4.7, lng: -74.05 };
const at = (metersNorth: number) => ({ lat: BODEGA.lat + metersNorth / 111_195, lng: BODEGA.lng });

const place = (over: Partial<Geofence> = {}): Geofence =>
  geofenceSchema.parse({ id: 'bodega', name: 'Bodega Norte', ...BODEGA, radiusM: 100, ...over });

describe('distancia y radios', () => {
  it('mide metros reales', () => {
    expect(distanceM(BODEGA, at(0))).toBeCloseTo(0, 3);
    expect(distanceM(BODEGA, at(500))).toBeGreaterThan(495);
    expect(distanceM(BODEGA, at(500))).toBeLessThan(505);
  });
  it('para salir hay que pasar un radio mayor', () => {
    expect(leaveRadiusM(100)).toBe(125);
    expect(leaveRadiusM(40)).toBe(65); // al menos +25 m
  });
});

describe('entrar y salir con histéresis', () => {
  const p = place();
  it('llega al cruzar el radio', () => {
    expect(stepPlace(p, false, at(150)).transition).toBeNull();
    expect(stepPlace(p, false, at(90))).toMatchObject({ inside: true, transition: 'enter' });
  });
  it('en el borde no rebota: adentro sigue adentro hasta pasar el radio de salida', () => {
    // 110 m: afuera del radio de entrada (100) pero adentro del de salida (125).
    expect(stepPlace(p, true, at(110))).toMatchObject({ inside: true, transition: null });
    expect(stepPlace(p, true, at(124)).transition).toBeNull();
    expect(stepPlace(p, true, at(130))).toMatchObject({ inside: false, transition: 'leave' });
  });
  it('una vez afuera no vuelve a «llegar» hasta estar dentro del radio de entrada', () => {
    expect(stepPlace(p, false, at(110)).transition).toBeNull();
    expect(stepPlace(p, false, at(95)).transition).toBe('enter');
  });
  it('una posición borrosa no decide nada', () => {
    expect(stepPlace(p, true, { ...at(500), accuracyM: 800 })).toMatchObject({
      inside: true,
      transition: null,
    });
    expect(stepPlace(p, false, { ...at(10), accuracyM: 800 })).toMatchObject({
      inside: false,
      transition: null,
    });
  });
  it('la primera posición ya adentro cuenta como llegada; afuera no es un cruce', () => {
    expect(stepPlace(p, null, at(20)).transition).toBe('enter');
    expect(stepPlace(p, null, at(900)).transition).toBeNull();
  });
});

describe('varios lugares', () => {
  const a = place({ id: 'aa', name: 'A', on: 'enter' });
  const b = place({ id: 'bb', name: 'B', lat: 4.8, lng: -74.0, on: 'both' });
  it('devuelve los estados nuevos y sólo registra lo que cada lugar pide', () => {
    const first = evaluateGeofences([a, b], new Map(), at(10));
    expect(first.next.get('aa')).toBe(true);
    expect(first.next.get('bb')).toBe(false);
    expect(first.hits.map((h) => `${h.place.id}:${h.transition}`)).toEqual(['aa:enter']);
    const second = evaluateGeofences([a, b], first.next, at(400));
    expect(second.crossings.map((c) => `${c.place.id}:${c.transition}`)).toEqual(['aa:leave']);
    // `a` sólo registra al llegar: la salida se detecta pero no se registra.
    expect(second.hits).toHaveLength(0);
    expect(second.next.get('aa')).toBe(false);
  });
});

describe('esquema y texto', () => {
  it('pone valores por defecto y rechaza radios locos', () => {
    const g = geofenceSchema.parse({ id: 'x1', name: 'X', lat: 1, lng: 2 });
    expect(g).toMatchObject({ radiusM: 150, on: 'both', notify: { roles: [], admins: false } });
    expect(
      geofenceSchema.safeParse({ id: 'x1', name: 'X', lat: 1, lng: 2, radiusM: 5 }).success,
    ).toBe(false);
    expect(geofenceSchema.safeParse({ id: 'x1', name: 'X', lat: 91, lng: 2 }).success).toBe(false);
  });
  it('arma ids únicos desde el nombre', () => {
    expect(geofenceIdFor('Bodega Norte')).toBe('bodega_norte');
    expect(geofenceIdFor('Bodega Norte', ['bodega_norte'])).toBe('bodega_norte_2');
    expect(geofenceIdFor('Ñandú 1')).toBe('nandu_1');
    expect(geofenceIdFor('123')).toMatch(/^[a-z]/);
  });
  it('detecta ids repetidos', () => {
    expect(geofenceProblems([place(), place()])).toHaveLength(1);
  });
  it('el mensaje usa {{persona}} y {{lugar}} o el de siempre', () => {
    expect(geofenceMessage(place(), 'enter', 'Ana')).toBe('Ana llegó a Bodega Norte');
    expect(geofenceMessage(place(), 'leave', 'Ana')).toBe('Ana salió de Bodega Norte');
    expect(
      geofenceMessage(place({ message: '{{lugar}}: ya está {{persona}}' }), 'enter', 'Ana'),
    ).toBe('Bodega Norte: ya está Ana');
  });
  it('los ajustes viejos (sin lugares) se leen con lista vacía y un lugar roto no apaga la función', () => {
    expect(parseLocationSettings({ enabled: true, retentionDays: 10 })).toEqual({
      enabled: true,
      retentionDays: 10,
      geofences: [],
    });
    expect(
      parseLocationSettings({ enabled: true, retentionDays: 10, geofences: [{ id: 'MAL' }] }),
    ).toEqual({ enabled: true, retentionDays: 10, geofences: [] });
  });
});

describe('polígonos y zonas', () => {
  // Rectángulo ~200 m x 100 m alrededor de BODEGA.
  const d = 0.0009;
  const rect = (): Geofence =>
    geofenceSchema.parse({
      id: 'plataforma',
      name: 'Plataforma',
      ...BODEGA,
      radiusM: 150,
      polygon: [
        [BODEGA.lat - d / 2, BODEGA.lng - d],
        [BODEGA.lat - d / 2, BODEGA.lng + d],
        [BODEGA.lat + d / 2, BODEGA.lng + d],
        [BODEGA.lat + d / 2, BODEGA.lng - d],
      ],
      marginM: 10,
    });
  it('el punto en rayos', () => {
    const poly = rect().polygon as Array<[number, number]>;
    expect(pointInPolygon(BODEGA, poly)).toBe(true);
    expect(pointInPolygon({ lat: BODEGA.lat + 0.01, lng: BODEGA.lng }, poly)).toBe(false);
  });
  it('dentro, en la holgura y fuera', () => {
    const p = rect();
    expect(zoneOf([p], BODEGA).place?.id).toBe('plataforma');
    // ~5 m al norte del borde: dentro por la holgura de 10 m.
    expect(zoneOf([p], { lat: BODEGA.lat + d / 2 + 5 / 111_195, lng: BODEGA.lng }).place?.id).toBe('plataforma');
    // ~80 m al norte del borde: fuera.
    expect(zoneOf([p], { lat: BODEGA.lat + d / 2 + 80 / 111_195, lng: BODEGA.lng }).place).toBeNull();
  });
  it('una posición borrosa y fuera no decide', () => {
    const v = zoneOf([rect()], { lat: 4.8, lng: -74.0, accuracyM: 900 });
    expect(v).toMatchObject({ place: null, uncertain: true });
  });
  it('restrictTo limita las zonas y el cruce de un polígono respeta la histéresis', () => {
    const p = rect();
    expect(zoneOf([p], BODEGA, ['otra']).place).toBeNull();
    expect(stepPlace(p, false, BODEGA)).toMatchObject({ inside: true, transition: 'enter' });
    const edge = { lat: BODEGA.lat + d / 2 + 20 / 111_195, lng: BODEGA.lng };
    expect(stepPlace(p, true, edge).transition).toBeNull(); // 20 m < salida (35 m)
    const far = { lat: BODEGA.lat + d / 2 + 60 / 111_195, lng: BODEGA.lng };
    expect(stepPlace(p, true, far).transition).toBe('leave');
  });
});
