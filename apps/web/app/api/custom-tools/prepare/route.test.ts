import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({
  session: vi.fn(),
  db: vi.fn(),
  generate: vi.fn(),
  send: vi.fn(),
  meter: vi.fn(),
  consume: vi.fn(),
}));
vi.mock('@/lib/session', () => ({ requireSession: m.session }));
vi.mock('@/lib/supabase/service', () => ({ getOrgScopedClient: m.db }));
vi.mock('ai', () => ({ generateObject: m.generate }));
vi.mock('@cortex/agent-tools', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  chatModel: vi.fn(),
  checkMeter: m.meter,
  isRefused: () => false,
  consumeToken: m.consume,
  sendRequest: m.send,
}));
import { NextRequest } from 'next/server';
import { POST } from './route';
const input = {
  apiUrl: 'https://api.example.com',
  purpose: 'Consultar el estado de pedidos',
  documentation: 'GET /orders/{id} devuelve el estado actual del pedido.',
};
const request = (body = input) =>
  new NextRequest('https://cortex.example.com/api/custom-tools/prepare', {
    method: 'POST',
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  m.session.mockResolvedValue({ id: 'me', role: 'org_admin', organization: { id: 'my-org' } });
  m.db.mockReturnValue({});
});
it('refuses non-admins before reading docs or calling the model', async () => {
  m.session.mockResolvedValue({ role: 'member' });
  expect((await POST(request())).status).toBe(403);
  expect(m.send).not.toHaveBeenCalled();
  expect(m.generate).not.toHaveBeenCalled();
});
it('uses the current company and returns a disabled draft without executing or saving it', async () => {
  m.generate.mockResolvedValue({
    object: {
      definitionJson: JSON.stringify({
        slug: 'consultar_pedido',
        name: 'Consultar pedido',
        description: 'Consulta el estado de pedidos.',
        urlTemplate: 'https://api.example.com/orders',
      }),
      questions: [],
      explanation: 'Consulta de pedidos',
    },
  });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect((await response.json()).draft.enabled).toBe(false);
  expect(m.db).toHaveBeenCalledWith('my-org');
  expect(m.send).not.toHaveBeenCalled();
});
it('does not analyze blocked or truncated documentation', async () => {
  m.send.mockResolvedValue({ ok: false, cause: 'blocked' });
  const response = await POST(
    request({
      ...input,
      documentationUrl: 'https://docs.example.com/openapi.json',
    } as typeof input),
  );
  expect(response.status).toBe(422);
  expect(m.generate).not.toHaveBeenCalled();
  expect(m.send.mock.calls[0]?.[1]).toMatchObject({
    followRedirects: false,
    allowInsecureHttp: false,
    maxBytes: 60000,
  });
});
it('asks for missing information without inventing a tool', async () => {
  m.generate.mockResolvedValue({
    object: {
      definitionJson: '',
      questions: ['¿Cuál es la ruta para consultar pedidos?'],
      explanation: 'Falta la ruta.',
    },
  });
  const response = await POST(request());
  expect((await response.json()).draft).toBeNull();
});
