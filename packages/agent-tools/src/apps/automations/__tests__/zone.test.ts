import { describe, expect, it } from 'vitest';
import { geofenceSchema } from '../../geofence';
import { renderRaw, renderText } from '../engine';
import { automationInputSchema, structuralProblems } from '../spec';
import { decideZone } from '../zone-run';

const d = 0.001;
const plataforma = geofenceSchema.parse({
  id: 'plataforma_carga',
  name: 'Plataforma de carga',
  lat: 4.69,
  lng: -74.137,
  radiusM: 200,
  marginM: 10,
  polygon: [
    [4.69 - d, -74.137 - d],
    [4.69 - d, -74.137 + d],
    [4.69 + d, -74.137 + d],
    [4.69 + d, -74.137 - d],
  ],
});
const action = (over: Record<string, unknown> = {}) => {
  const parsed = automationInputSchema.parse({
    name: 'x',
    trigger: { type: 'row_created', tracker: 'equipos_usados' },
    actions: [
      { type: 'check_zone', zoneField: 'zona', outsideField: 'fuera_de_zona', locationField: 'ubicacion', ...over },
    ],
  });
  return parsed.actions[0] as Extract<(typeof parsed.actions)[number], { type: 'check_zone' }>;
};

describe('check_zone', () => {
  it('dentro: deja la zona y «No»', () => {
    const out = decideZone(action(), [plataforma], { lat: 4.69, lng: -74.137, accuracyM: 10 });
    expect(out).toMatchObject({ status: 'inside', zoneName: 'Plataforma de carga' });
    expect(out.patch).toMatchObject({ zona: 'Plataforma de carga', fuera_de_zona: 'No' });
    expect(out.patch.ubicacion).toBe('4.69,-74.137');
  });
  it('fuera: marca «Sí» y deja trabajar (sólo marca)', () => {
    const out = decideZone(action(), [plataforma], { lat: 4.75, lng: -74.1, accuracyM: 8 });
    expect(out.status).toBe('outside');
    expect(out.patch).toMatchObject({ zona: 'Fuera de zona', fuera_de_zona: 'Sí' });
  });
  it('sin posición reciente o muy borrosa: «Sin señal», no «fuera»', () => {
    expect(decideZone(action(), [plataforma], null).patch.fuera_de_zona).toBe('Sin señal');
    expect(decideZone(action(), [plataforma], { lat: 4.8, lng: -74.0, accuracyM: 900 }).status).toBe('unknown');
  });
  it('valores propios y zonas acotadas', () => {
    const a = action({ outsideValue: 'FUERA', zones: ['otra'] });
    expect(decideZone(a, [plataforma], { lat: 4.69, lng: -74.137, accuracyM: 5 }).patch.fuera_de_zona).toBe('FUERA');
  });
});

describe('forma y problemas', () => {
  it('onShift en los avisos y check_zone pasan el esquema', () => {
    const r = automationInputSchema.safeParse({
      name: 'a',
      trigger: { type: 'row_updated', tracker: 'vuelos', field: 'estado', to: 'Aterrizó' },
      actions: [
        { type: 'notify_member', roles: ['operario'], onShift: true, title: 'Llegó {{numero_vuelo}}' },
        { type: 'notify_app_user', to: { role: 'operario' }, onShift: true, title: 'Llegó' },
      ],
    });
    expect(r.success).toBe(true);
  });
  it('check_zone sin dónde escribir o sin fila se rechaza', () => {
    const none = automationInputSchema.parse({
      name: 'x',
      trigger: { type: 'row_created', tracker: 'tabla_x' },
      actions: [{ type: 'check_zone' }],
    });
    expect(structuralProblems(none).join(' ')).toMatch(/al menos un campo/);
    const sched = automationInputSchema.parse({
      name: 'x',
      trigger: { type: 'schedule', cadence: 'daily', hour: 8 },
      actions: [{ type: 'check_zone', zoneField: 'z' }],
    });
    expect(structuralProblems(sched).join(' ')).toMatch(/necesita una fila|no hay fila/);
  });
  it('{{fila}} da la relación a la fila y {{hora}} la hora de Bogotá', () => {
    const ctx = { after: { numero: 'AV1' }, label: 'AV1', rowId: 'abc' };
    expect(JSON.parse(renderRaw('{{fila}}', ctx))).toEqual({ id: 'abc', label: 'AV1' });
    expect(renderText('{{hora}}', ctx)).toMatch(/^\d{2}:\d{2}$/);
    // un campo propio llamado «fila» o «hora» manda
    expect(renderRaw('{{hora}}', { after: { hora: '07:15' } })).toBe('07:15');
  });
});
