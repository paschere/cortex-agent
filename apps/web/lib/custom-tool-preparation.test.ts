import { expect, it } from 'vitest';
import { validatePreparedTool } from './custom-tool-preparation';
const draft = {
  slug: 'consultar_pedido',
  name: 'Consultar pedido',
  description: 'Consulta el estado de un pedido por su número.',
  urlTemplate: 'https://api.example.com/pedidos/{{id}}',
  fields: [{ name: 'id', type: 'string', required: true, description: 'Número del pedido' }],
};
it('forces generated drafts inactive and gated, and drops credential headers and secrets', () => {
  const result = validatePreparedTool(
    {
      ...draft,
      authType: 'bearer',
      authSecret: 'secret',
      headers: {
        Authorization: 'Bearer secret',
        'X-API-Key': 'secret',
        Accept: 'application/json',
      },
      enabled: true,
      requiresConfirmation: false,
      followRedirects: true,
    },
    'https://api.example.com',
  );
  expect(result).toMatchObject({
    enabled: false,
    requiresConfirmation: true,
    followRedirects: false,
    allowInsecureHttp: false,
    headers: { Accept: 'application/json' },
  });
  expect(result.authSecret).toBeUndefined();
});
it('rejects changed destination and undeclared parameters', () => {
  expect(() =>
    validatePreparedTool(
      { ...draft, urlTemplate: 'https://elsewhere.example.com/orders' },
      'https://api.example.com',
    ),
  ).toThrow();
  expect(() => validatePreparedTool({ ...draft, fields: [] }, 'https://api.example.com')).toThrow();
});
it('rejects credentials in base URLs and internal destinations', () => {
  expect(() => validatePreparedTool(draft, 'https://user:secret@api.example.com')).toThrow();
  expect(() =>
    validatePreparedTool(
      { ...draft, urlTemplate: 'https://127.0.0.1/orders' },
      'https://127.0.0.1',
    ),
  ).toThrow();
});
it('leaves basic-auth identity for the administrator to complete', () => {
  const result = validatePreparedTool(
    { ...draft, authType: 'basic', authUsername: 'copied-user', authSecret: 'copied-password' },
    'https://api.example.com',
  );
  expect(result.authUsername).toBeUndefined();
  expect(result.authSecret).toBeUndefined();
});
