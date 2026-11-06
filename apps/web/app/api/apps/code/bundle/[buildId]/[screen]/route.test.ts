import { beforeEach, describe, expect, it, vi } from 'vitest';

const getBuildBundle = vi.fn();
vi.mock('@cortex/agent-tools', () => ({
  getBuildBundle: (...a: unknown[]) => getBuildBundle(...a),
}));
vi.mock('@/lib/supabase/service', () => ({ getSupabaseServiceClient: () => ({}) }));

import { GET } from './route';

const ID = '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b';
const call = (buildId: string, screen: string) =>
  GET(new Request('http://x') as never, { params: Promise.resolve({ buildId, screen }) });

describe('ruta pública de bundles', () => {
  beforeEach(() => getBuildBundle.mockReset());

  it('uuid inválido o nombre mal formado: 404 sin tocar la base', async () => {
    expect((await call('no-es-uuid', 'tablero.js')).status).toBe(404);
    expect((await call(ID, 'tablero')).status).toBe(404);
    expect((await call(ID, '../x.js')).status).toBe(404);
    expect((await call(ID, 'a b.js')).status).toBe(404);
    expect((await call(ID, 'tablero.map')).status).toBe(404);
    expect(getBuildBundle).not.toHaveBeenCalled();
  });

  it('compilación que no está ok (o sin esa pantalla, p. ej. una función): 404 sin caché', async () => {
    getBuildBundle.mockResolvedValue(null);
    const res = await call(ID, 'enviar_correo.js');
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    // Pide solo bundles de pantallas por slug, sin codeId (el uuid es la llave).
    expect(getBuildBundle).toHaveBeenCalledWith({}, { buildId: ID, slug: 'enviar_correo' });
  });

  it('sirve js inmutable', async () => {
    getBuildBundle.mockResolvedValue({ buildId: ID, js: 'console.log(1)', css: 'a{}' });
    const res = await call(ID, 'tablero.js');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('console.log(1)');
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('sirve css inmutable', async () => {
    getBuildBundle.mockResolvedValue({ buildId: ID, js: 'x', css: 'a{}' });
    const res = await call(ID.toUpperCase(), 'tablero.css');
    expect(await res.text()).toBe('a{}');
    expect(res.headers.get('content-type')).toContain('text/css');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(getBuildBundle).toHaveBeenCalledWith({}, { buildId: ID, slug: 'tablero' });
  });
});
