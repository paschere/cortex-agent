import { describe, expect, it } from 'vitest';
import {
  chatHref,
  detectPagination,
  detectRecords,
  friendlyTestError,
  listCandidates,
  parseTestBody,
  previewTable,
  suggestIdentity,
  urlProblem,
  withCursorParam,
} from './api-wizard';

const SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;

describe('urlProblem', () => {
  it('accepts a plain https address', () => {
    expect(urlProblem('https://api.example.com/v1/orders?status=open')).toBeNull();
  });

  it('explains what is wrong in words', () => {
    expect(urlProblem('')).toMatch(/Pega/);
    expect(urlProblem('api.example.com')).toMatch(/https/);
    expect(urlProblem('http://api.example.com')).toMatch(/sin cifrar/);
    expect(urlProblem('http://api.example.com', true)).toBeNull();
    expect(urlProblem('ftp://example.com')).toMatch(/https/);
    expect(urlProblem('https://user:pw@example.com')).toMatch(/usuario/);
    expect(urlProblem('https://example.com/x?api_key=123')).toMatch(/api_key/);
    expect(urlProblem('https://example.com/x?access-token=123')).toMatch(/access-token/);
    expect(urlProblem('https://example.com/{{id}}')).toMatch(/campos/);
  });
});

describe('suggestIdentity', () => {
  it('names the tool after host and last path segment with a valid slug', () => {
    const id = suggestIdentity('https://api.acme.co/v2/pedidos/', 'Ab12Z9');
    expect(id.name).toBe('acme.co · pedidos');
    expect(id.slug).toBe('feed_acme_co_pedidos_ab12z9');
    expect(id.slug).toMatch(SLUG_RE);
    expect(id.description.length).toBeGreaterThanOrEqual(10);
  });

  it('stays valid for odd inputs', () => {
    for (const url of [
      'not a url',
      'https://ñandú.example/ÁRBOL',
      `https://x.io/${'a'.repeat(200)}`,
    ]) {
      expect(suggestIdentity(url, 'q1').slug).toMatch(SLUG_RE);
    }
  });
});

describe('withCursorParam', () => {
  it('appends the placeholder with ? or &', () => {
    expect(withCursorParam('https://x.io/items', 'cursor')).toBe(
      'https://x.io/items?cursor={{cursor}}',
    );
    expect(withCursorParam('https://x.io/items?limit=50', 'page_token')).toBe(
      'https://x.io/items?limit=50&page_token={{page_token}}',
    );
    expect(withCursorParam('https://x.io/items?cursor=abc', 'cursor')).toBe(
      'https://x.io/items?cursor=abc',
    );
  });
});

describe('parseTestBody', () => {
  it('prefers the raw body as JSON', () => {
    expect(parseTestBody({ response: { body: '{"a":1}' } })).toEqual({ a: 1 });
  });
  it('falls back to what the model got when the body is cut', () => {
    expect(
      parseTestBody({ response: { body: '{"a":[1,2' }, modelResult: { data: { a: [1, 2] } } }),
    ).toEqual({ a: [1, 2] });
    expect(parseTestBody({ modelResult: { data: '[{"x":1}]' } })).toEqual([{ x: 1 }]);
  });
  it('keeps plain text, and nothing means undefined', () => {
    expect(parseTestBody({ response: { body: 'hola' } })).toBe('hola');
    expect(parseTestBody({ response: null })).toBeUndefined();
  });
});

describe('detectRecords', () => {
  it('uses a root list as is', () => {
    expect(detectRecords([{ id: 1 }, { id: 2 }])).toMatchObject({ path: '' });
  });

  it('finds the largest list of objects, nested up to three levels', () => {
    const data = {
      meta: { tags: [{ t: 'a' }] },
      response: { flights: [{ id: 1 }, { id: 2 }, { id: 3 }] },
      data: [{ id: 'x' }, { id: 'y' }],
    };
    expect(detectRecords(data)?.path).toBe('response.flights');
    expect(listCandidates(data)).toEqual([
      { path: 'response.flights', count: 3 },
      { path: 'data', count: 2 },
      { path: 'meta.tags', count: 1 },
    ]);
  });

  it('prefers the shallower list on a tie and ignores lists of scalars', () => {
    const data = { a: { b: [{ x: 1 }] }, c: [{ y: 1 }], d: [1, 2, 3, 4] };
    expect(detectRecords(data)?.path).toBe('c');
  });

  it('skips keys feed would refuse as a path and returns null without lists', () => {
    expect(detectRecords({ 'bad key': [{ a: 1 }] })).toBeNull();
    expect(detectRecords({ status: 'ok' })).toBeNull();
    expect(detectRecords('texto')).toBeNull();
    expect(detectRecords([])).toBeNull();
  });
});

describe('previewTable', () => {
  it('flattens one level, keeps first-seen order and clips', () => {
    const table = previewTable(
      [
        { id: 1, cliente: { nombre: 'Ana', ciudad: 'Cali' }, nota: 'x'.repeat(100) },
        { id: 2, total: 30, tags: ['a', 'b'] },
      ],
      { maxColumns: 5, maxCell: 10 },
    );
    expect(table.headers).toEqual(['id', 'cliente.nombre', 'cliente.ciudad', 'nota', 'total']);
    expect(table.totalColumns).toBe(6);
    expect(table.rows[0]).toEqual(['1', 'Ana', 'Cali', `${'x'.repeat(9)}…`, '']);
    expect(table.rows[1]?.[4]).toBe('30');
    expect(table.totalRows).toBe(2);
  });
});

describe('detectPagination', () => {
  it('finds common cursor fields at the root and inside meta containers', () => {
    expect(detectPagination({ data: [{ a: 1 }], next_cursor: 'abc' }, 'data')).toEqual({
      nextCursorPath: 'next_cursor',
      cursorInput: 'cursor',
      recordsPath: 'data',
    });
    expect(
      detectPagination({ items: [{ a: 1 }], meta: { nextPageToken: 't1' } }, 'items'),
    ).toMatchObject({ nextCursorPath: 'meta.nextPageToken', cursorInput: 'pageToken' });
  });

  it('ignores empty cursors, provider URLs and non-objects', () => {
    expect(detectPagination({ data: [], next_cursor: '' }, 'data')).toBeNull();
    expect(detectPagination({ data: [], next_cursor: null }, 'data')).toBeNull();
    expect(
      detectPagination({ data: [], links: { next_cursor: 'https://x.io?page=2' } }, 'data'),
    ).toBeNull();
    expect(detectPagination([{ a: 1 }], '')).toBeNull();
  });
});

describe('friendlyTestError', () => {
  it('is null on success', () => {
    expect(friendlyTestError({ ok: true, modelResult: { ok: true, status: 200 } })).toBeNull();
  });
  it('names the usual failures', () => {
    expect(friendlyTestError({ ok: false, response: { status: 401 } })).toMatch(/clave/);
    expect(friendlyTestError({ ok: false, response: { status: 404 } })).toMatch(/404/);
    expect(friendlyTestError({ ok: false, response: { status: 503 } })).toMatch(/su lado/);
    expect(
      friendlyTestError({
        ok: false,
        modelResult: { ok: false, status: null, message: 'was not allowed to contact' },
      }),
    ).toMatch(/públicas/);
    expect(friendlyTestError({ ok: false, error: 'Solo admin.', problems: ['x'] })).toBe(
      'Solo admin. x',
    );
  });
});

describe('chatHref', () => {
  it('links to chat with the prompt and never the query string', () => {
    const href = chatHref('https://api.acme.co/v1/orders?api_key=SECRET');
    expect(href.startsWith('/chat?prompt=')).toBe(true);
    const prompt = decodeURIComponent(href.slice('/chat?prompt='.length));
    expect(prompt).toContain('https://api.acme.co/v1/orders');
    expect(prompt).not.toContain('SECRET');
    expect(decodeURIComponent(chatHref('').slice(13))).not.toContain('La dirección es');
  });
});
