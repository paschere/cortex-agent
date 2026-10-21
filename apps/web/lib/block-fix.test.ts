import { describe, expect, it } from 'vitest';
import { buildFixPrompt, buildReportNotice, chatHrefWith, quotedNames, whereOf } from './block-fix';

const ctx = {
  appName: 'Control de vuelos de carga',
  appRef: 'control_de_vuelos',
  screenTitle: 'Detalle de vuelo',
  screenSlug: 'detalle',
  blockId: 'detalle',
  blockTitle: 'Vuelo',
  message:
    'Vuelos ya no tiene los campos «estado», «hora_real» y «observaciones». Pídele a Cortex que ajuste este bloque.',
};

describe('block-fix', () => {
  it('nombra app, pantalla y bloque', () => {
    expect(whereOf(ctx)).toBe(
      'la aplicación «Control de vuelos de carga», la pantalla «Detalle de vuelo», el bloque «Vuelo» (id detalle)',
    );
  });
  it('saca los nombres entre comillas del mensaje', () => {
    expect(quotedNames(ctx.message)).toEqual(['estado', 'hora_real', 'observaciones']);
  });
  it('la instrucción lleva el mensaje, pide diagnóstico y prohíbe borrar', () => {
    const p = buildFixPrompt(ctx);
    expect(p).toContain('Vuelos ya no tiene los campos');
    expect(p).toContain('Diagnostícalo primero');
    expect(p).toContain('No borres campos ni datos');
  });
  it('el aviso es corto y estable para no repetirse', () => {
    const n = buildReportNotice(ctx, 'Ana');
    expect(n.title).toContain('Control de vuelos de carga');
    expect(n.body).toContain('Ana avisa');
    expect(n.dedupeKey).toBe('block-problem:control_de_vuelos:detalle:detalle');
  });
  it('la dirección del chat va codificada', () => {
    expect(chatHrefWith('hola ñ?')).toBe('/chat?prompt=hola%20%C3%B1%3F');
  });
});
